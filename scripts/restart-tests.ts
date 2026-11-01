// The restart tests. A real worker process is killed before, during and after each API
// call, a second worker finishes the job, and the simulators count what actually exists.
//
//   docker compose up -d postgres
//   node scripts/restart-tests.ts [--only substring] [--quick]
//
// `before` and `after` are kills at an exact point in the worker's code, with no cleanup.
// `during` holds the request inside the simulator and kills the worker from outside while
// it waits, then the simulator either finishes the write or abandons it.
//
// QuickBooks's real `requestid` behaviour per record type isn't known until the sandbox
// run, so every cell runs against all three simulated behaviours. Results go to
// results/restart/. A duplicate is reported whatever the number is.

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { databaseUrl, ROOT } from '../src/config.ts';
import type { QuickBooksSettings } from '../src/config.ts';
import { createDb, migrate } from '../src/db.ts';
import { HubSpotClient } from '../src/hubspot/client.ts';
import { ensureProperties } from '../src/hubspot/properties.ts';
import { QuickBooksClient } from '../src/quickbooks/client.ts';
import { connectSimulator } from '../src/quickbooks/connect.ts';
import { tokenKeyFrom, TokenStore } from '../src/quickbooks/tokens.ts';
import { createSimServer } from '../src/simulators/harness.ts';
import type { FaultSpec, SimServer } from '../src/simulators/harness.ts';
import { createHubSpotSim } from '../src/simulators/hubspot.ts';
import { createQuickBooksSim } from '../src/simulators/quickbooks.ts';
import { approveJob } from '../src/worker/jobs.ts';
import type { InvoiceJob } from '../src/worker/jobs.ts';
import { displayNameFor, docNumberFor } from '../src/worker/payload.ts';
import { pollWonDeals } from '../src/worker/poller.ts';
import { findDuplicates } from '../src/worker/reconcile.ts';

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    quick: { type: 'boolean', default: false },
    label: { type: 'string', default: 'matrix' },
  },
});

const RESTART_DB = databaseUrl().replace(/\/ltl$/, '/ltl_restart');
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const LEASE_SECONDS = 1;
const SETTLE_MS = 600;
const HOLD_MS = 300;
const LATE_COMMIT_MS = SETTLE_MS + 2500;
const QB_TIMEOUT_MS = 400;
const AMOUNT = 12500;

const MODES = ['replay', 'duplicate_error', 'ignored'] as const;
type Mode = (typeof MODES)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl() });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = 'ltl_restart'");
  if (exists.rowCount === 0) await admin.query('create database ltl_restart');
  await admin.end();
}

await ensureDatabase();
const db = createDb(RESTART_DB);
await migrate(db);

const hubspotSim: SimServer = createSimServer(createHubSpotSim({ searchLagMs: 0, enforceRateLimits: false }));
const qbSim: SimServer = createSimServer(createQuickBooksSim({ enforceRateLimits: false }));
await hubspotSim.listen(0);
await qbSim.listen(0);

const qbSettings: QuickBooksSettings = {
  apiBaseUrl: qbSim.url(),
  discoveryUrl: `${qbSim.url()}/.well-known/openid_sandbox_configuration`,
  clientId: 'sim-client-id',
  clientSecret: 'sim-client-secret',
  redirectUri: 'http://localhost:8765/callback',
  minorVersion: '75',
  itemName: 'Services',
};
const store = new TokenStore(db, qbSettings, tokenKeyFrom(TOKEN_KEY));
const hubspot = new HubSpotClient({ baseUrl: hubspotSim.url(), token: 'sim-hubspot-token', apiVersion: '2026-09', timeoutMs: 1000, sleep: async () => {} });
const qb = new QuickBooksClient({ baseUrl: qbSim.url(), realmId: () => store.realmId(), tokens: store, timeoutMs: 2000 });

const workerEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  LTL_TARGET: 'sim',
  LTL_DATABASE_URL: RESTART_DB,
  HUBSPOT_BASE_URL: hubspotSim.url(),
  QB_API_BASE_URL: qbSim.url(),
  LTL_TOKEN_KEY: TOKEN_KEY,
  LTL_POLL: 'false',
  LTL_LEASE_SECONDS: String(LEASE_SECONDS),
  LTL_SETTLE_MS: String(SETTLE_MS),
  LTL_RETRY_DELAY_MS: '50',
  LTL_MAX_ATTEMPTS: '12',
  LTL_RECONNECT_DELAY_MS: '100',
  LTL_QB_TIMEOUT_MS: String(QB_TIMEOUT_MS),
  LTL_HUBSPOT_TIMEOUT_MS: String(QB_TIMEOUT_MS),
  LTL_KILL_AT: '',
  ...extra,
});

function startWorker(extra: Record<string, string> = {}): { child: ChildProcess; done: Promise<{ code: number | null; signal: string | null; output: string }> } {
  const child = spawn(process.execPath, ['src/worker/main.ts', '--once'], { cwd: ROOT, env: workerEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const done = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, done };
}

async function simPost(sim: SimServer, route: string, body?: unknown): Promise<Response> {
  return fetch(`${sim.url()}/__sim/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function arm(sim: SimServer, spec: FaultSpec): Promise<string> {
  const res = await simPost(sim, 'faults', spec);
  return ((await res.json()) as { id: string }).id;
}

interface QbState {
  customers: Array<{ Id: string; DisplayName: string; Balance: number }>;
  invoices: Array<{ Id: string; DocNumber?: string; TotalAmt: number }>;
  requestIdHits: number;
}

interface Scenario {
  jobId: string;
  dealId: string;
  docNumber: string;
  displayName: string;
}

async function reset(simConfig: Record<string, unknown>): Promise<void> {
  await db.query('truncate external_calls, job_events, approvals, invoice_jobs, poll_cursors, oauth_connections, alerts restart identity cascade');
  await simPost(hubspotSim, 'reset');
  await simPost(qbSim, 'reset');
  await simPost(qbSim, 'config', simConfig);
  await ensureProperties(hubspot);
  await connectSimulator(qbSettings, store);
}

async function newApprovedJob(suffix = 'a'): Promise<Scenario> {
  const contact = await hubspot.upsertContactByEmail(`pat.${suffix}@cedarsquare.example.com`, {
    firstname: 'Pat',
    lastname: 'Lee',
    company: `Cedar Square ${suffix}`,
    ltl_synthetic: true,
  });
  const deal = await hubspot.createDeal({ dealname: `Rooftop units ${suffix}`, dealstage: 'closedwon', amount: String(AMOUNT), closedate: '2026-10-30T00:00:00Z' }, contact.id);
  await pollWonDeals({ db, hubspot }, { wonStage: 'closedwon', itemName: 'Services' });
  const job = (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [deal.id])).rows[0];
  const approved = await approveJob(db, job.id, job.digest, 'Restart test');
  if (!approved.ok) throw new Error(`approval failed: ${approved.reason}`);
  return {
    jobId: job.id,
    dealId: deal.id,
    docNumber: docNumberFor(deal.id),
    displayName: displayNameFor({ id: contact.id, properties: { company: `Cedar Square ${suffix}`, firstname: 'Pat', lastname: 'Lee' } }),
  };
}

interface CellResult {
  cell: string;
  group: string;
  mode: Mode | 'n/a';
  call: string;
  how: string;
  customers: number;
  invoices: number;
  customer_duplicates: number;
  invoice_duplicates: number;
  balance_correct: boolean;
  job_status: string;
  deal_written_back: boolean;
  requestid_replays: number;
  found_by_lookup: boolean;
  needed_reconnect: boolean;
  duplicates_found_by_reconcile: number;
  expected_gap: boolean;
  worker_runs: number;
  passed: boolean;
  note?: string;
}

const results: CellResult[] = [];

async function collect(scenario: Scenario, meta: { cell: string; group: string; mode: Mode | 'n/a'; call: string; how: string; expectedGap?: boolean; acceptPerson?: boolean; neededReconnect?: boolean; workerRuns: number; note?: string }): Promise<CellResult> {
  const state = (await (await fetch(`${qbSim.url()}/__sim/state`)).json()) as QbState;
  const customers = state.customers.filter((c) => c.DisplayName === scenario.displayName);
  const invoices = state.invoices.filter((i) => i.DocNumber === scenario.docNumber);
  const job = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [scenario.jobId])).rows[0];
  const events = await db.query<{ event: string }>('select event from job_events where job_id = $1', [scenario.jobId]);
  const deal = await hubspot.getDeal(scenario.dealId, ['ltl_qb_invoice_id']);
  const duplicates = await findDuplicates(db, qb);
  const after = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [scenario.jobId])).rows[0];
  const balance = customers[0]?.Balance;
  const result: CellResult = {
    cell: meta.cell,
    group: meta.group,
    mode: meta.mode,
    call: meta.call,
    how: meta.how,
    customers: customers.length,
    invoices: invoices.length,
    customer_duplicates: Math.max(0, customers.length - 1),
    invoice_duplicates: Math.max(0, invoices.length - 1),
    balance_correct: balance === AMOUNT * invoices.length && invoices.length > 0,
    job_status: after.status,
    deal_written_back: Boolean(deal?.properties.ltl_qb_invoice_id),
    requestid_replays: state.requestIdHits,
    found_by_lookup: events.rows.some((e) => e.event === 'found_existing'),
    needed_reconnect: Boolean(meta.neededReconnect),
    duplicates_found_by_reconcile: duplicates.length,
    expected_gap: Boolean(meta.expectedGap),
    worker_runs: meta.workerRuns,
    passed: false,
    ...(meta.note ? { note: meta.note } : {}),
  };
  const single = customers.length === 1 && invoices.length === 1;
  const clean = single && job.status === 'done' && result.balance_correct && result.deal_written_back;
  // A gap cell passes only if the duplicate it allowed was found afterwards.
  // Some cells can only end safely by asking a person: no duplicate, nothing guessed.
  const askedAPerson = customers.length <= 1 && invoices.length <= 1 && after.status === 'needs_person';
  if (meta.expectedGap) result.passed = single ? clean : result.duplicates_found_by_reconcile > 0 && after.status === 'needs_person';
  else result.passed = clean || (Boolean(meta.acceptPerson) && askedAPerson);
  results.push(result);
  const dup = result.customer_duplicates + result.invoice_duplicates;
  console.log(`${result.passed ? 'ok  ' : 'FAIL'} ${meta.cell}  customers=${customers.length} invoices=${invoices.length} status=${after.status}${dup ? `  DUPLICATES=${dup}` : ''}${result.needed_reconnect ? ' reconnected' : ''}`);
  return result;
}

const finishes = async (worker: ReturnType<typeof startWorker>, timeoutMs = 60_000) => {
  const timer = setTimeout(() => worker.child.kill('SIGKILL'), timeoutMs);
  const out = await worker.done;
  clearTimeout(timer);
  return out;
};

// Where each call happens, and how to hold it in the simulator. The worker's first query
// is the item, then the customer lookup, then the invoice lookup, then the read-back.
const CALLS: Array<{ name: string; kind: 'read' | 'write'; sim: () => SimServer; match: FaultSpec['match']; skip?: number }> = [
  { name: 'hubspot.get_deal', kind: 'read', sim: () => hubspotSim, match: { method: 'GET', path: '/deals/\\d+$' } },
  { name: 'qb.query_item', kind: 'read', sim: () => qbSim, match: { method: 'GET', path: '/query$' } },
  { name: 'qb.query_customer', kind: 'read', sim: () => qbSim, match: { method: 'GET', path: '/query$' }, skip: 1 },
  { name: 'qb.create_customer', kind: 'write', sim: () => qbSim, match: { method: 'POST', path: '/customer$' } },
  { name: 'qb.query_invoice', kind: 'read', sim: () => qbSim, match: { method: 'GET', path: '/query$' }, skip: 2 },
  { name: 'qb.create_invoice', kind: 'write', sim: () => qbSim, match: { method: 'POST', path: '/invoice$' } },
  { name: 'qb.verify_invoice', kind: 'read', sim: () => qbSim, match: { method: 'GET', path: '/query$' }, skip: 3 },
  { name: 'hubspot.patch_deal', kind: 'write', sim: () => hubspotSim, match: { method: 'PATCH', path: '/deals/\\d+$' } },
];

function wanted(name: string): boolean {
  return !args.only || name.includes(args.only);
}

async function killCell(call: (typeof CALLS)[number], mode: Mode, how: string): Promise<void> {
  const cell = `kill/${mode}/${call.name}/${how}`;
  if (!wanted(cell)) return;
  await reset({ requestid: { customer: mode, invoice: mode } });
  const scenario = await newApprovedJob();
  let first: ReturnType<typeof startWorker>;
  if (how === 'before' || how === 'after') {
    first = startWorker({ LTL_KILL_AT: `${how}:${call.name}` });
    await finishes(first);
  } else {
    const commit = how !== 'during_abandoned';
    const faultId = await arm(call.sim(), { match: call.match, skip: call.skip, action: 'hold', holdMs: HOLD_MS, commit });
    first = startWorker();
    const hit = (await (await fetch(`${call.sim().url()}/__sim/faults/${faultId}/wait?timeoutMs=15000`)).json()) as { hit: boolean };
    if (!hit.hit) throw new Error(`${cell}: the call never reached the simulator`);
    first.child.kill('SIGKILL');
    await first.done;
    await sleep(HOLD_MS + 50);
  }
  const second = startWorker();
  await finishes(second);
  await collect(scenario, { cell, group: 'kill', mode, call: call.name, how, workerRuns: 2 });
}

/** The first attempt lands after the settling period, so the second attempt can't see it. */
async function lateCommitCell(call: (typeof CALLS)[number], mode: Mode, rejectDuplicateDocNum: boolean): Promise<void> {
  const cell = `late_commit/${mode}/${call.name}${rejectDuplicateDocNum ? '/unique_doc_numbers' : ''}`;
  if (!wanted(cell)) return;
  await reset({ requestid: { customer: mode, invoice: mode }, rejectDuplicateDocNum });
  const scenario = await newApprovedJob();
  const faultId = await arm(call.sim(), { match: call.match, action: 'hold', holdMs: LATE_COMMIT_MS, commit: true });
  const first = startWorker();
  await fetch(`${call.sim().url()}/__sim/faults/${faultId}/wait?timeoutMs=15000`);
  first.child.kill('SIGKILL');
  await first.done;
  const second = startWorker();
  await finishes(second);
  await sleep(LATE_COMMIT_MS + 100);
  const gap = mode === 'ignored' && !rejectDuplicateDocNum && call.name === 'qb.create_invoice';
  await collect(scenario, { cell, group: 'late_commit', mode, call: call.name, how: 'killed; first attempt commits after the settling period', expectedGap: gap, workerRuns: 2 });
}

/** The worker wrote and died, and the next lookup can't see the record yet. Intuit's docs don't rule this out. */
async function queryLagCell(call: (typeof CALLS)[number], mode: Mode): Promise<void> {
  const cell = `query_lag/${mode}/${call.name}`;
  if (!wanted(cell)) return;
  await reset({ requestid: { customer: mode, invoice: mode } });
  const scenario = await newApprovedJob();
  await simPost(qbSim, 'config', { queryLagMs: LATE_COMMIT_MS });
  await finishes(startWorker({ LTL_KILL_AT: `after:${call.name}` }));
  await finishes(startWorker());
  await sleep(LATE_COMMIT_MS + 100);
  const gap = mode === 'ignored' && call.name === 'qb.create_invoice';
  await collect(scenario, { cell, group: 'query_lag', mode, call: call.name, how: 'killed after the write; lookups cannot see it for longer than the settling period', expectedGap: gap, acceptPerson: true, workerRuns: 2 });
}

const FAILURES: Array<{ name: string; spec: Partial<FaultSpec> }> = [
  { name: 'response_lost_after_commit', spec: { action: 'drop', commit: true } },
  { name: 'dropped_before_commit', spec: { action: 'drop', commit: false } },
  { name: 'timeout_after_commit', spec: { action: 'timeout', commit: true } },
  { name: 'timeout_before_commit', spec: { action: 'timeout', commit: false } },
  { name: '429', spec: { action: 'status', status: 429 } },
  { name: '500_no_commit', spec: { action: 'status', status: 500 } },
  { name: '500_after_commit', spec: { action: 'status', status: 500, commit: true } },
  { name: '502_html', spec: { action: 'status', status: 502 } },
  { name: '503_html_after_commit', spec: { action: 'status', status: 503, commit: true } },
  { name: '200_with_fault', spec: { action: 'fault200' } },
  { name: '200_with_fault_after_commit', spec: { action: 'fault200', commit: true } },
  { name: 'token_expired_mid_flow', spec: { action: 'expire_token' } },
];

async function failureCell(call: (typeof CALLS)[number], mode: Mode, failure: (typeof FAILURES)[number]): Promise<void> {
  const cell = `failure/${mode}/${call.name}/${failure.name}`;
  if (!wanted(cell)) return;
  await reset({ requestid: { customer: mode, invoice: mode } });
  const scenario = await newApprovedJob();
  await arm(call.sim(), { match: call.match, skip: call.skip, ...failure.spec } as FaultSpec);
  await finishes(startWorker());
  await collect(scenario, { cell, group: 'failure', mode, call: call.name, how: failure.name, workerRuns: 1 });
}

/** A token refresh can't be made safe from outside: the question is what it costs. */
async function tokenCell(rotation: 'every_refresh' | 'after_24h', how: string): Promise<void> {
  const cell = `token/${rotation}/${how}`;
  if (!wanted(cell)) return;
  await reset({ refreshRotation: rotation });
  const scenario = await newApprovedJob();
  await simPost(qbSim, 'token/expire');
  // Expired on our side too, or a restarted worker would carry on with the old access token.
  await db.query("update oauth_connections set access_expires_at = now() - interval '1 minute'");
  let first: ReturnType<typeof startWorker>;
  if (how === 'before' || how === 'after') {
    first = startWorker({ LTL_KILL_AT: `${how}:qb.token_refresh` });
    await finishes(first);
  } else {
    const faultId = await arm(qbSim, { match: { method: 'POST', path: 'tokens/bearer' }, action: 'hold', holdMs: HOLD_MS, commit: true });
    first = startWorker();
    await fetch(`${qbSim.url()}/__sim/faults/${faultId}/wait?timeoutMs=15000`);
    first.child.kill('SIGKILL');
    await first.done;
    await sleep(HOLD_MS + 50);
  }
  const second = startWorker();
  let neededReconnect = false;
  const deadline = Date.now() + 30_000;
  const watching = (async () => {
    while (Date.now() < deadline) {
      if ((await store.status()) === 'needs_reconnect') {
        neededReconnect = true;
        const before = (await (await fetch(`${qbSim.url()}/__sim/state`)).json()) as QbState;
        const held = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [scenario.jobId])).rows[0];
        if (before.invoices.length > 0 || held.status === 'done') throw new Error('a job moved while the connection was down');
        await connectSimulator(qbSettings, store);
        return;
      }
      const job = (await db.query<InvoiceJob>('select status from invoice_jobs where id = $1', [scenario.jobId])).rows[0];
      if (job.status === 'done') return;
      await sleep(100);
    }
  })();
  await finishes(second);
  await watching;
  await collect(scenario, { cell, group: 'token', mode: 'n/a', call: 'qb.token_refresh', how: `${rotation}, killed ${how}`, neededReconnect, workerRuns: 2 });
}

async function concurrencyCell(mode: Mode): Promise<void> {
  const cell = `concurrency/${mode}`;
  if (!wanted(cell)) return;
  await reset({ requestid: { customer: mode, invoice: mode } });
  const scenarios: Scenario[] = [];
  for (let i = 0; i < 10; i += 1) scenarios.push(await newApprovedJob(`c${i}`));
  // Two more deals for one contact, so workers race for the same customer.
  const shared = await hubspot.upsertContactByEmail('shared@cedarsquare.example.com', { firstname: 'Sam', lastname: 'Shared', company: 'Shared Co' });
  for (const name of ['one', 'two']) {
    const deal = await hubspot.createDeal({ dealname: `Shared ${name}`, dealstage: 'closedwon', amount: String(AMOUNT), closedate: '2026-10-30T00:00:00Z' }, shared.id);
    await pollWonDeals({ db, hubspot }, { wonStage: 'closedwon', itemName: 'Services' });
    const job = (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [deal.id])).rows[0];
    await approveJob(db, job.id, job.digest, 'Restart test');
  }
  const workers = [startWorker(), startWorker(), startWorker(), startWorker()];
  await sleep(250);
  workers[0].child.kill('SIGKILL');
  await Promise.all(workers.map((w) => finishes(w, 90_000)));
  const stragglers = startWorker();
  await finishes(stragglers, 60_000);

  const state = (await (await fetch(`${qbSim.url()}/__sim/state`)).json()) as QbState;
  const names = new Map<string, number>();
  for (const c of state.customers) names.set(c.DisplayName, (names.get(c.DisplayName) ?? 0) + 1);
  const docs = new Map<string, number>();
  for (const i of state.invoices) if (i.DocNumber) docs.set(i.DocNumber, (docs.get(i.DocNumber) ?? 0) + 1);
  const statuses = await db.query<{ status: string; n: number }>('select status, count(*)::int as n from invoice_jobs group by status');
  const done = statuses.rows.find((r) => r.status === 'done')?.n ?? 0;
  const dupCustomers = [...names.values()].filter((n) => n > 1).length;
  const dupInvoices = [...docs.values()].filter((n) => n > 1).length;
  const passed = done === 12 && dupCustomers === 0 && dupInvoices === 0 && state.invoices.length === 12 && state.customers.length === 12;
  results.push({
    cell,
    group: 'concurrency',
    mode,
    call: 'all',
    how: '4 workers on 12 jobs, 2 sharing a customer, 1 worker killed',
    customers: state.customers.length - 1,
    invoices: state.invoices.length,
    customer_duplicates: dupCustomers,
    invoice_duplicates: dupInvoices,
    balance_correct: true,
    job_status: `done ${done} of 12`,
    deal_written_back: true,
    requestid_replays: state.requestIdHits,
    found_by_lookup: false,
    needed_reconnect: false,
    duplicates_found_by_reconcile: 0,
    expected_gap: false,
    worker_runs: 5,
    passed,
  });
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${cell}  invoices=${state.invoices.length} done=${done} duplicates=${dupCustomers + dupInvoices}`);
}

/** A check on the instrument: if the worker's protection is skipped, do the counts show it? */
async function controlCell(): Promise<{ blind_retries: number; invoices_counted: number; customers_counted: number; detected: boolean }> {
  await reset({ requestid: { customer: 'ignored', invoice: 'ignored' } });
  const scenario = await newApprovedJob('control');
  const job = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [scenario.jobId])).rows[0];
  const created = await qb.createCustomer(job.payload.customer, 'control-customer');
  if (!created.ok) throw new Error('control: customer create failed');
  const body = {
    CustomerRef: { value: created.body.Id },
    DocNumber: scenario.docNumber,
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: AMOUNT, SalesItemLineDetail: { ItemRef: { value: '1', name: 'Services' } } }],
  };
  await arm(qbSim, { match: { method: 'POST', path: '/invoice$' }, action: 'drop', commit: true });
  const first = await qb.createInvoice(body, 'control-invoice');
  const second = await qb.createInvoice(body, 'control-invoice');
  if (first.ok || !second.ok) throw new Error('control: the lost-response setup did not behave');
  const state = (await (await fetch(`${qbSim.url()}/__sim/state`)).json()) as QbState;
  const duplicates = await findDuplicates(db, qb);
  const counted = state.invoices.filter((i) => i.DocNumber === scenario.docNumber).length;
  return { blind_retries: 1, invoices_counted: counted, customers_counted: state.customers.filter((c) => c.DisplayName === scenario.displayName).length, detected: duplicates.length === 1 };
}

// ---- Run ------------------------------------------------------------------

const started = new Date().toISOString();
const control = await controlCell();
console.log(`control: one blind retry after a lost response counted ${control.invoices_counted} invoices, detected=${control.detected}`);
if (control.invoices_counted !== 2 || !control.detected) throw new Error('the harness failed to see a duplicate it was shown, so its counts mean nothing');

const modes: readonly Mode[] = args.quick ? (['ignored'] as const) : MODES;
for (const mode of modes) {
  for (const call of CALLS) {
    const kinds = call.kind === 'write' ? ['before', 'during_commits', 'during_abandoned', 'after'] : ['before', 'during_commits', 'after'];
    for (const how of kinds) await killCell(call, mode, how);
  }
}

const writes = CALLS.filter((c) => c.name === 'qb.create_customer' || c.name === 'qb.create_invoice');
for (const mode of modes) {
  for (const call of writes) await lateCommitCell(call, mode, false);
}
await lateCommitCell(writes[1], 'ignored', true);
for (const mode of modes) {
  for (const call of writes) await queryLagCell(call, mode);
}

for (const mode of modes) {
  for (const call of writes) {
    for (const failure of FAILURES) await failureCell(call, mode, failure);
  }
}
const patch = CALLS.find((c) => c.name === 'hubspot.patch_deal')!;
const getDeal = CALLS.find((c) => c.name === 'hubspot.get_deal')!;
const verify = CALLS.find((c) => c.name === 'qb.verify_invoice')!;
for (const name of ['response_lost_after_commit', '500_no_commit', '429', '502_html']) {
  const failure = FAILURES.find((f) => f.name === name)!;
  await failureCell(patch, 'replay', failure);
  await failureCell(getDeal, 'replay', failure);
  await failureCell(verify, 'replay', failure);
}

for (const rotation of ['every_refresh', 'after_24h'] as const) {
  for (const how of ['before', 'during', 'after']) await tokenCell(rotation, how);
}

for (const mode of modes) await concurrencyCell(mode);

const finished = new Date().toISOString();
await hubspotSim.close();
await qbSim.close();
await db.end();

// ---- Report ---------------------------------------------------------------

const unexpected = results.filter((r) => !r.expected_gap && (r.customer_duplicates > 0 || r.invoice_duplicates > 0));
const failed = results.filter((r) => !r.passed);
const gapCells = results.filter((r) => r.expected_gap);
const sum = (rows: CellResult[], key: 'customer_duplicates' | 'invoice_duplicates') => rows.reduce((n, r) => n + r[key], 0);

function table(rows: CellResult[], keyOf: (r: CellResult) => string): Array<{ key: string; cells: number; customer_duplicates: number; invoice_duplicates: number; failed: number }> {
  const keys = [...new Set(rows.map(keyOf))];
  return keys.map((key) => {
    const part = rows.filter((r) => keyOf(r) === key);
    return { key, cells: part.length, customer_duplicates: sum(part, 'customer_duplicates'), invoice_duplicates: sum(part, 'invoice_duplicates'), failed: part.filter((r) => !r.passed).length };
  });
}

const git = (...params: string[]) => execFileSync('git', params, { cwd: ROOT, encoding: 'utf8' }).trim();
const output = {
  meta: {
    synthetic: true,
    services: 'HubSpot and QuickBooks simulators, not the real APIs',
    git_commit: git('rev-parse', '--short', 'HEAD'),
    git_dirty: git('status', '--porcelain') !== '',
    node: process.version,
    platform: process.platform,
    lease_seconds: LEASE_SECONDS,
    settle_ms: SETTLE_MS,
    hold_ms: HOLD_MS,
    late_commit_ms: LATE_COMMIT_MS,
    started_at: started,
    finished_at: finished,
  },
  control,
  summary: {
    cells: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    customer_duplicates: sum(results, 'customer_duplicates'),
    invoice_duplicates: sum(results, 'invoice_duplicates'),
    duplicates_outside_known_gap: unexpected.length,
    known_gap_cells: gapCells.length,
    by_group: table(results, (r) => r.group),
    by_mode: table(results, (r) => r.mode),
    kills_by_call: table(results.filter((r) => r.group === 'kill'), (r) => r.call),
    kills_by_when: table(results.filter((r) => r.group === 'kill'), (r) => r.how),
  },
  cells: results,
};

const dir = path.join(ROOT, 'results/restart');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${args.label}.json`), `${JSON.stringify(output, null, 2)}\n`);

const s = output.summary;
const rowsOf = (rows: typeof s.by_group, title: string) => [
  `| ${title} | Cells | Customer duplicates | Invoice duplicates | Failed |`,
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.key} | ${r.cells} | ${r.customer_duplicates} | ${r.invoice_duplicates} | ${r.failed} |`),
  '',
];
const md = [
  `# Restart tests: ${args.label}`,
  '',
  'Run against the HubSpot and QuickBooks simulators, not the real APIs. A real worker process is killed, a second one finishes the job, and the simulator counts what exists. Real `requestid` behaviour is unknown until the sandbox run, so each cell runs against all three simulated behaviours.',
  '',
  `- Commit \`${output.meta.git_commit}\`${output.meta.git_dirty ? ' (with uncommitted changes)' : ''}, Node ${output.meta.node} on ${output.meta.platform}, ${output.meta.started_at} to ${output.meta.finished_at}.`,
  `- Lease ${LEASE_SECONDS} s, settling period ${SETTLE_MS} ms, request held ${HOLD_MS} ms, late commit ${LATE_COMMIT_MS} ms.`,
  `- Control: with the worker's checks skipped, one blind retry after a lost response counted ${control.invoices_counted} invoices, and the reconcile sweep ${control.detected ? 'found it' : 'missed it'}. So the counts below can see a duplicate.`,
  '',
  '## Result',
  '',
  `**${s.passed} of ${s.cells} cells passed. Duplicates: ${s.customer_duplicates} customers, ${s.invoice_duplicates} invoices.** Outside the known gap: ${s.duplicates_outside_known_gap}.`,
  '',
  ...rowsOf(s.by_group, 'Group'),
  ...rowsOf(s.by_mode, '`requestid` behaviour'),
  '## Kills, by call',
  '',
  ...rowsOf(s.kills_by_call, 'Call'),
  '## Kills, by when',
  '',
  ...rowsOf(s.kills_by_when, 'When'),
  '## The known gap',
  '',
  'The lookup before a create can miss a record in two ways: the first attempt commits after the settling period, or queries lag behind writes. If QuickBooks also ignores `requestid` and DocNumbers aren\'t unique, a duplicate lands. These cells force both. A job marked needs_person stopped and asked instead of guessing.',
  '',
  '| Cell | Customers | Invoices | Job status | Found by reconcile |',
  '|---|---|---|---|---|',
  ...results.filter((r) => r.group === 'late_commit' || r.group === 'query_lag').map((r) => `| ${r.cell} | ${r.customers} | ${r.invoices} | ${r.job_status} | ${r.duplicates_found_by_reconcile} |`),
  '',
  '## Token refresh',
  '',
  'A process killed after Intuit rotates a refresh token and before the new value is saved loses the connection. These cells show what that costs.',
  '',
  '| Cell | Needed a reconnect | Invoices | Job status |',
  '|---|---|---|---|',
  ...results.filter((r) => r.group === 'token').map((r) => `| ${r.cell} | ${r.needed_reconnect ? 'yes' : 'no'} | ${r.invoices} | ${r.job_status} |`),
  '',
  ...(failed.length > 0 ? ['## Failed cells', '', ...failed.map((r) => `- ${r.cell}: customers ${r.customers}, invoices ${r.invoices}, status ${r.job_status}, balance correct ${r.balance_correct}, written back ${r.deal_written_back}`), ''] : []),
].join('\n');
writeFileSync(path.join(dir, `${args.label}.md`), md);

console.log(`\n${s.passed}/${s.cells} cells passed. Customer duplicates ${s.customer_duplicates}, invoice duplicates ${s.invoice_duplicates}, outside the known gap ${s.duplicates_outside_known_gap}.`);
console.log(`Wrote results/restart/${args.label}.json and .md`);
process.exit(failed.length === 0 ? 0 : 1);
