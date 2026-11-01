// Runs a won deal through the running stack: poller, approval page, worker container, and
// the simulators. Kills the worker container mid-write with SIGKILL. Start the stack first
// with `docker compose up -d --build --wait`. Results go to results/e2e/.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { databaseUrl, ROOT } from '../src/config.ts';
import type { QuickBooksSettings } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { HubSpotClient } from '../src/hubspot/client.ts';
import { ensureProperties } from '../src/hubspot/properties.ts';
import { connectSimulator } from '../src/quickbooks/connect.ts';
import { tokenKeyFrom, TokenStore } from '../src/quickbooks/tokens.ts';
import type { InvoiceJob } from '../src/worker/jobs.ts';

const APP = 'http://127.0.0.1:4000';
const HUBSPOT = 'http://127.0.0.1:4010';
const QB = 'http://127.0.0.1:4020';
const SIM_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

const db = createDb(databaseUrl());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const compose = (...params: string[]) => execFileSync('docker', ['compose', ...params], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const hubspot = new HubSpotClient({ baseUrl: HUBSPOT, token: 'sim-hubspot-token', apiVersion: '2026-09' });
const settings: QuickBooksSettings = {
  apiBaseUrl: QB,
  discoveryUrl: `${QB}/.well-known/openid_sandbox_configuration`,
  clientId: 'sim-client-id',
  clientSecret: 'sim-client-secret',
  redirectUri: 'http://localhost:8765/callback',
  minorVersion: '75',
  itemName: 'Services',
};

interface Check {
  name: string;
  pass: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
function check(name: string, pass: boolean, detail?: unknown): void {
  checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
}

interface QbState {
  customers: Array<{ DisplayName: string; Balance: number }>;
  invoices: Array<{ Id: string; DocNumber?: string; TotalAmt: number }>;
}
const qbState = async () => (await (await fetch(`${QB}/__sim/state`)).json()) as QbState;
const jobFor = async (dealId: string) => (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [dealId])).rows[0] as InvoiceJob | undefined;

async function waitFor<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function approveThroughPage(job: InvoiceJob, name: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(`${APP}/approvals/${job.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ digest: job.digest, approved_by: name }).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') };
}

async function newDeal(name: string, amount: string, stage = 'closedwon') {
  const contact = await hubspot.upsertContactByEmail(`${name}@cedarsquare.example.com`, { firstname: 'Pat', lastname: name, company: `Cedar Square ${name}`, ltl_synthetic: true });
  const deal = await hubspot.createDeal({ dealname: `Rooftop units, ${name}`, dealstage: stage, amount, closedate: '2026-10-30T00:00:00Z' }, contact.id);
  return { contact, deal };
}

const started = new Date().toISOString();
await post(`${HUBSPOT}/__sim/reset`);
await post(`${QB}/__sim/reset`);
await db.query('truncate external_calls, job_events, approvals, invoice_jobs, poll_cursors, oauth_connections, alerts restart identity cascade');
await ensureProperties(hubspot);
await connectSimulator(settings, new TokenStore(db, settings, tokenKeyFrom(process.env.LTL_TOKEN_KEY ?? SIM_KEY)));

// ---- The whole path -------------------------------------------------------
const first = await newDeal('first', '12500', 'contractsent');
await sleep(8000);
check('a deal that is not won creates no job', !(await jobFor(first.deal.id)));

await hubspot.updateDeal(first.deal.id, { dealstage: 'closedwon' });
const waiting = await waitFor('the job', () => jobFor(first.deal.id));
check('the poller created one job when the deal was won', waiting.status === 'awaiting_approval', waiting.status);
check('nothing has reached QuickBooks before approval', (await qbState()).invoices.length === 0);

const page = await fetch(`${APP}/approvals`);
const html = await page.text();
check('the approval page shows the customer and amount', html.includes(waiting.payload.customer.DisplayName) && html.includes('$12,500.00'));

const yes = await approveThroughPage(waiting, 'Example Reviewer');
check('approving through the page works', yes.status === 303 && yes.location === '/approvals', yes);
const done = await waitFor('the job to finish', async () => {
  const job = await jobFor(first.deal.id);
  return job?.status === 'done' ? job : null;
});
let state = await qbState();
check('one customer and one invoice exist', state.invoices.length === 1 && state.customers.filter((c) => c.DisplayName === waiting.payload.customer.DisplayName).length === 1, { invoices: state.invoices.length });
check('the invoice has the deal amount and number', state.invoices[0]?.TotalAmt === 12500 && state.invoices[0]?.DocNumber === waiting.payload.invoice.doc_number);
const written = await hubspot.getDeal(first.deal.id, ['ltl_qb_invoice_id', 'ltl_qb_doc_number']);
check('the invoice is noted on the deal', written?.properties.ltl_qb_invoice_id === done.qb_invoice_id && written?.properties.ltl_qb_doc_number === waiting.payload.invoice.doc_number);

const again = await approveThroughPage(waiting, 'Someone Else');
check('a second approval is refused', again.location === '/approvals?notice=not_awaiting_approval', again);

// ---- Kill the worker container during the invoice write ---------------------
const second = await newDeal('second', '8000');
const secondJob = await waitFor('the second job', () => jobFor(second.deal.id));
const fault = (await (await post(`${QB}/__sim/faults`, { match: { method: 'POST', path: '/invoice$' }, action: 'hold', holdMs: 1500, commit: true })).json()) as { id: string };
await approveThroughPage(secondJob, 'Example Reviewer');
const hit = (await (await fetch(`${QB}/__sim/faults/${fault.id}/wait?timeoutMs=30000`)).json()) as { hit: boolean };
check('the invoice request reached QuickBooks', hit.hit);
compose('kill', '-s', 'SIGKILL', 'worker');
check('the worker container was killed mid-write', compose('ps', '--status', 'running', '--format', '{{.Service}}').includes('worker') === false);
await sleep(2000);
check('the write landed anyway, with no worker to hear about it', (await qbState()).invoices.filter((i) => i.DocNumber === secondJob.payload.invoice.doc_number).length === 1);
compose('start', 'worker');
await waitFor(
  'the restarted worker to finish',
  async () => {
    const job = await jobFor(second.deal.id);
    return job?.status === 'done' ? job : null;
  },
  240_000,
);
state = await qbState();
check('after the restart there is still one invoice for that deal', state.invoices.filter((i) => i.DocNumber === secondJob.payload.invoice.doc_number).length === 1);
const events = await db.query<{ event: string }>('select event from job_events where job_id = $1 order by id', [secondJob.id]);
check('the second worker found what the first one wrote', events.rows.some((e) => e.event === 'found_existing'), events.rows.map((e) => e.event));

// ---- An edit after approval ---------------------------------------------------
compose('stop', 'worker');
const third = await newDeal('third', '5000');
compose('start', 'worker');
const thirdJob = await waitFor('the third job', () => jobFor(third.deal.id));
compose('stop', 'worker');
await approveThroughPage(thirdJob, 'Example Reviewer');
await hubspot.updateDeal(third.deal.id, { amount: '999999' });
compose('start', 'worker');
const sentBack = await waitFor('the edited job to go back', async () => {
  const job = await jobFor(third.deal.id);
  return job?.status === 'awaiting_approval' && job.payload.invoice.amount === 999999 ? job : null;
}, 60_000);
check('an edit after approval sends the job back with the new amount', sentBack.approval_id === null);
state = await qbState();
check('no invoice was made from the edited deal', !state.invoices.some((i) => i.DocNumber === thirdJob.payload.invoice.doc_number));
const stale = await approveThroughPage(thirdJob, 'Example Reviewer');
check('the old content cannot be approved any more', stale.location === '/approvals?notice=stale_digest', stale);

const failed = checks.filter((c) => !c.pass);
const git = (...params: string[]) => execFileSync('git', params, { cwd: ROOT, encoding: 'utf8' }).trim();
const output = {
  synthetic: true,
  services: 'HubSpot and QuickBooks simulators, not the real APIs',
  git_commit: git('rev-parse', '--short', 'HEAD'),
  git_dirty: git('status', '--porcelain') !== '',
  started_at: started,
  finished_at: new Date().toISOString(),
  checks_total: checks.length,
  checks_failed: failed.length,
  checks,
};
const dir = path.join(ROOT, 'results/e2e');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'invoice-path-sim.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed. Wrote results/e2e/invoice-path-sim.json`);
await db.end();
process.exit(failed.length === 0 ? 0 : 1);
