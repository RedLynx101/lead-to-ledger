// The worker process. It polls for won deals, takes approved jobs one at a time, and
// checks for duplicates now and then.
//
//   node src/worker/main.ts          run until stopped
//   node src/worker/main.ts --once   exit when no job is queued or running
//
// Kill it at any moment: everything it needs to carry on is in Postgres.
//
// LTL_KILL_AT is for the restart tests. Set to a name like before:qb.create_invoice, the
// process ends itself at that exact point with no cleanup. Unset, it does nothing.

import { randomUUID } from 'node:crypto';
import { hubspotSettings, quickbooksSettings } from '../config.ts';
import { createDb, migrate } from '../db.ts';
import { HubSpotClient } from '../hubspot/client.ts';
import { ensureProperties } from '../hubspot/properties.ts';
import { QuickBooksClient } from '../quickbooks/client.ts';
import { connectSimulator } from '../quickbooks/connect.ts';
import { tokenKeyFrom, TokenStore } from '../quickbooks/tokens.ts';
import { claimNext } from './jobs.ts';
import { pollWonDeals } from './poller.ts';
import { processJob } from './process.ts';
import type { WorkerSettings } from './process.ts';
import { findDuplicates } from './reconcile.ts';

const once = process.argv.includes('--once');
const workerId = randomUUID().slice(0, 8);
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const killAt = process.env.LTL_KILL_AT;
function checkpoint(name: string): void {
  if (killAt !== name) return;
  console.log(`KILL ${name}`);
  process.kill(process.pid, 'SIGKILL');
}

const hubspotConfig = hubspotSettings();
const qbConfig = quickbooksSettings();
const settings: WorkerSettings = {
  leaseSeconds: num('LTL_LEASE_SECONDS', 120),
  settleMs: num('LTL_SETTLE_MS', 30_000),
  retryDelayMs: num('LTL_RETRY_DELAY_MS', 15_000),
  maxAttempts: num('LTL_MAX_ATTEMPTS', 8),
  reconnectDelayMs: num('LTL_RECONNECT_DELAY_MS', 60_000),
  wonStage: hubspotConfig.wonStage,
  itemName: qbConfig.itemName,
};
const pollMs = num('LTL_POLL_MS', 30_000);
const reconcileMs = num('LTL_RECONCILE_MS', 600_000);
const idleMs = num('LTL_IDLE_MS', 2_000);

const db = createDb();
await migrate(db);

const tokens = new TokenStore(db, qbConfig, tokenKeyFrom(process.env.LTL_TOKEN_KEY), checkpoint);
const hubspot = new HubSpotClient({ ...hubspotConfig, timeoutMs: num('LTL_HUBSPOT_TIMEOUT_MS', 20_000) });
const qb = new QuickBooksClient({
  baseUrl: qbConfig.apiBaseUrl,
  realmId: () => tokens.realmId(),
  tokens,
  minorVersion: qbConfig.minorVersion,
  timeoutMs: num('LTL_QB_TIMEOUT_MS', 30_000),
});

if (process.env.LTL_AUTO_CONNECT_SIM === 'true') {
  await ensureProperties(hubspot).catch((error) => console.error('property setup failed:', (error as Error).message));
  if ((await tokens.status()) !== 'connected') await connectSimulator(qbConfig, tokens);
}

const polling = process.env.LTL_POLL !== 'false';
let lastPoll = 0;
let lastReconcile = Date.now();
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

console.log(`worker ${workerId} started${once ? ' (once)' : ''}`);

while (!stopping) {
  if (polling && Date.now() - lastPoll >= pollMs) {
    lastPoll = Date.now();
    await pollWonDeals({ db, hubspot }, { wonStage: settings.wonStage, itemName: settings.itemName }).catch((error) => console.error('poll failed:', (error as Error).message));
  }
  if (!once && Date.now() - lastReconcile >= reconcileMs) {
    lastReconcile = Date.now();
    await findDuplicates(db, qb).catch((error) => console.error('reconcile failed:', (error as Error).message));
  }

  const job = await claimNext(db, settings.leaseSeconds);
  if (job) {
    const outcome = await processJob({ db, hubspot, qb, settings, checkpoint }, job);
    console.log(`worker ${workerId} job ${job.id.slice(0, 8)} attempt ${job.attempts}: ${outcome}`);
    continue;
  }

  if (once) {
    const left = await db.query("select count(*)::int as n from invoice_jobs where status in ('queued', 'running')");
    if (left.rows[0].n === 0) break;
  }
  await new Promise((resolve) => setTimeout(resolve, once ? 100 : idleMs));
}

await db.end();
