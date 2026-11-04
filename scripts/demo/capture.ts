// Captures the screenshots and facts the demo and gallery are built from, by driving the
// real stack: the form, n8n, the status page, the approval page and a killed worker.
// Runs on the simulators, in its own database. Needs Docker, Edge or Chrome, and, for real
// triage summaries, a model loaded in LM Studio.
//
//   node scripts/demo/capture.ts [--model granite-4.1-8b] [--out tmp/demo]
//
// Then: node scripts/demo/compose.ts

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const { values: args } = parseArgs({ options: { model: { type: 'string' }, out: { type: 'string', default: 'tmp/demo' } } });

process.env.LTL_TARGET = 'sim';
const { databaseUrl, ROOT } = await import('../../src/config.ts');
const { createDb, migrate } = await import('../../src/db.ts');
const { HubSpotClient } = await import('../../src/hubspot/client.ts');
const { ensureProperties } = await import('../../src/hubspot/properties.ts');
const { connectSimulator } = await import('../../src/quickbooks/connect.ts');
const { tokenKeyFrom, TokenStore } = await import('../../src/quickbooks/tokens.ts');
const { recordModeChange } = await import('../../src/triage/service.ts');
type LabeledLead = import('../../src/leads/types.ts').LabeledLead;
type InvoiceJob = import('../../src/worker/jobs.ts').InvoiceJob;

const OUT = path.resolve(ROOT, args.out!);
mkdirSync(OUT, { recursive: true });
const SIM_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const APP = 'http://127.0.0.1:4000';
const N8N = 'http://127.0.0.1:5678';
const HUBSPOT = 'http://127.0.0.1:4010';
const QB = 'http://127.0.0.1:4020';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stackEnv: NodeJS.ProcessEnv = {
  ...process.env,
  LTL_TARGET: 'sim',
  LTL_DB_NAME: 'ltl_demo',
  APP_LLM_BASE_URL: args.model ? 'http://host.docker.internal:1234/v1' : 'http://simulators:4030/v1',
  APP_LLM_MODEL: args.model ?? 'scripted-stand-in',
  LTL_POLL_MS: '3000',
  LTL_SETTLE_MS: '3000',
  LTL_RETRY_DELAY_MS: '1000',
};
const compose = (...params: string[]) => execFileSync('docker', ['compose', ...params], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: stackEnv });

// Its own database, so a demo never touches a real connection.
compose('up', '-d', '--wait', 'postgres');
const admin = new pg.Client({ connectionString: databaseUrl() });
await admin.connect();
if ((await admin.query("select 1 from pg_database where datname = 'ltl_demo'")).rowCount === 0) await admin.query('create database ltl_demo');
await admin.end();
const db = createDb(databaseUrl().replace(/\/ltl$/, '/ltl_demo'));
await migrate(db);
compose('up', '-d', '--build', '--wait');

const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
await post(`${HUBSPOT}/__sim/reset`);
await post(`${QB}/__sim/reset`);
await db.query('truncate lead_submissions, triage_runs, settings, mode_changes, alerts, external_calls, job_events, approvals, invoice_jobs, poll_cursors, oauth_connections restart identity cascade');
const hubspot = new HubSpotClient({ baseUrl: HUBSPOT, token: 'sim-hubspot-token', apiVersion: '2026-09' });
await ensureProperties(hubspot);
const qbSettings = {
  apiBaseUrl: QB,
  discoveryUrl: `${QB}/.well-known/openid_sandbox_configuration`,
  clientId: 'sim-client-id',
  clientSecret: 'sim-client-secret',
  redirectUri: 'http://localhost:8765/callback',
  minorVersion: '75',
  itemName: 'Services',
};
await connectSimulator(qbSettings, new TokenStore(db, qbSettings, tokenKeyFrom(SIM_KEY)));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await context.newPage();
async function shot(name: string, target: Page = page): Promise<void> {
  await target.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`captured ${name}`);
}

const leads = readFileSync(path.join(ROOT, 'data/leads/dev.synthetic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LabeledLead);
const byTemplate = (id: string) => leads.find((l) => l.generator.template_id === id && !l.generator.resubmission_of)!;

async function waitForRuns(count: number): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    const n = (await db.query<{ n: number }>("select count(*)::int as n from triage_runs where status <> 'claimed'")).rows[0].n;
    if (n >= count) return;
    await sleep(1000);
  }
  throw new Error('triage did not finish');
}

// ---- The form, filled in through the page ---------------------------------------
await recordModeChange(db, { mode: 'shadow' });
const typed = byTemplate('sr-01').form;
await page.goto(`${APP}/`);
for (const [name, value] of Object.entries(typed)) {
  if (!value || name === 'hp_field') continue;
  const field = page.locator(`[name="${name}"]`);
  if (name === 'inquiry_type') await field.selectOption(value);
  else await field.fill(value);
}
// Start the shot just below the heading, so it is not cut through.
await page.evaluate(() => {
  const g = globalThis as unknown as { document: { querySelector: (s: string) => { getBoundingClientRect: () => { bottom: number } } | null }; scrollY: number; scrollTo: (x: number, y: number) => void };
  const h1 = g.document.querySelector('h1');
  if (h1) g.scrollTo(0, h1.getBoundingClientRect().bottom + g.scrollY + 8);
});
await shot('form-filled');
await page.click('button[type="submit"]');
await page.waitForSelector('.notice');
await page.evaluate(() => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 0));
await shot('form-sent');

// ---- More leads, shadow mode ---------------------------------------------------------
const shadow = ['sr-02', 'vp-03', 'sp-01', 'ni-03'];
for (const id of shadow) await post(`${APP}/submit`, { ...byTemplate(id).form, synthetic: true });
await waitForRuns(1 + shadow.length);
await page.goto(`${APP}/status`);
await shot('status-shadow');

// ---- Live, after a sign-off ------------------------------------------------------------
await recordModeChange(db, { mode: 'live', signedOffBy: 'Demo reviewer', belowBarNote: 'demo on synthetic data' });
const live = ['sr-10', 'ec-02', 'nf-03', 'vp-08', 'js-04'];
for (const id of live) await post(`${APP}/submit`, { ...byTemplate(id).form, synthetic: true });
await waitForRuns(1 + shadow.length + live.length);
await page.goto(`${APP}/status`);
await shot('status-live');

// ---- n8n: the workflow and its runs ------------------------------------------------------
const envFile = path.join(ROOT, '.env');
const envText = readFileSync(envFile, 'utf8');
let ownerPassword = /^N8N_OWNER_PASSWORD=(.+)$/m.exec(envText)?.[1];
if (!ownerPassword) {
  // A local owner for this machine's n8n only. Generated, kept in .env, never shown.
  ownerPassword = `Ltl-${randomBytes(12).toString('hex')}-9`;
  appendFileSync(envFile, `\nN8N_OWNER_PASSWORD=${ownerPassword}\n`);
}
const owner = { email: 'owner@example.com', firstName: 'Demo', lastName: 'Owner', password: ownerPassword };
const setup = await context.request.post(`${N8N}/rest/owner/setup`, { data: owner });
if (!setup.ok()) {
  const login = await context.request.post(`${N8N}/rest/login`, { data: { emailOrLdapLoginId: owner.email, password: owner.password } });
  if (!login.ok()) throw new Error(`n8n login failed: ${login.status()}`);
}
const n8nPage = await context.newPage();
await n8nPage.setViewportSize({ width: 1440, height: 810 });
await n8nPage.goto(`${N8N}/workflow/ltlLeadIntake001`);
await n8nPage.waitForSelector('.vue-flow__node', { timeout: 60_000 });
await sleep(2500);
for (let i = 0; i < 3; i += 1) await n8nPage.keyboard.press('Escape');
await n8nPage.keyboard.press('Shift+1');
await sleep(1200);
await shot('n8n-workflow', n8nPage);
await n8nPage.goto(`${N8N}/workflow/ltlLeadIntake001/executions`);
await sleep(4000);
for (let i = 0; i < 3; i += 1) await n8nPage.keyboard.press('Escape');
await shot('n8n-executions', n8nPage);

// ---- The invoice path --------------------------------------------------------------------
const jobFor = async (dealId: string) => (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [dealId])).rows[0] as InvoiceJob | undefined;
async function waitJob(dealId: string, status: string, timeoutMs = 120_000): Promise<InvoiceJob> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = await jobFor(dealId);
    if (job?.status === status) return job;
    await sleep(1000);
  }
  throw new Error(`job for ${dealId} never reached ${status}`);
}
async function wonDeal(company: string, first: string, last: string, dealname: string, amount: string) {
  const email = `${first}.${last}@${company.toLowerCase().replace(/[^a-z]/g, '')}.example.com`.toLowerCase();
  const contact = await hubspot.upsertContactByEmail(email, { firstname: first, lastname: last, company, ltl_synthetic: true });
  const deal = await hubspot.createDeal({ dealname, dealstage: 'closedwon', pipeline: 'default', amount, closedate: '2026-11-02T00:00:00Z' }, contact.id);
  return deal.id;
}
async function approveOnPage(name: string): Promise<void> {
  await page.goto(`${APP}/approvals`);
  const form = page.locator('form.approve').first();
  await form.locator('input[name="approved_by"]').fill(name);
  await form.locator('button').click();
  await page.waitForURL(`${APP}/approvals`);
}

const dealA = await wonDeal('Redwing Commercial Realty', 'Dana', 'Ruiz', 'Quarterly maintenance, Hamilton office', '18400');
const dealB = await wonDeal('Brightwater Commercial Realty', 'Marcus', 'Okafor', 'Chiller repair, Newark plant', '7250');
await waitJob(dealA, 'awaiting_approval');
await waitJob(dealB, 'awaiting_approval');
await page.goto(`${APP}/approvals`);
await shot('approvals-waiting');

// Approve deal A and let it run.
await page.goto(`${APP}/approvals`);
const rowA = page.locator('tr', { hasText: 'Redwing' });
await rowA.locator('input[name="approved_by"]').fill('Demo reviewer');
await rowA.locator('button').click();
await waitJob(dealA, 'done');

// Deal B: hold its invoice write in the simulator, kill the worker container while it waits.
const fault = (await (await post(`${QB}/__sim/faults`, { match: { method: 'POST', path: '/invoice$' }, action: 'hold', holdMs: 2500, commit: true })).json()) as { id: string };
await page.goto(`${APP}/approvals`);
const rowB = page.locator('tr', { hasText: 'Brightwater' });
await rowB.locator('input[name="approved_by"]').fill('Demo reviewer');
await rowB.locator('button').click();
await fetch(`${QB}/__sim/faults/${fault.id}/wait?timeoutMs=60000`);
// Recorded just before the kill. Docker's own event log is too short to rely on later.
const killedAt = new Date().toISOString();
compose('kill', '-s', 'SIGKILL', 'worker');
await sleep(3000);
const afterKill = (await (await fetch(`${QB}/__sim/state`)).json()) as { invoices: Array<{ DocNumber?: string; Id: string }> };
compose('start', 'worker');
const jobB = await waitJob(dealB, 'done', 240_000);
await page.goto(`${APP}/approvals`);
await shot('approvals-done');

const state = (await (await fetch(`${QB}/__sim/state`)).json()) as { invoices: Array<{ DocNumber?: string; Id: string; TotalAmt: number }>; customers: Array<{ DisplayName: string }> };
const events = await db.query<{ at: Date; event: string; detail: Record<string, unknown> | null }>('select at, event, detail from job_events where job_id = $1 order by id', [jobB.id]);
const dealBNote = await hubspot.getDeal(dealB, ['ltl_qb_invoice_id', 'ltl_qb_doc_number']);
const facts = {
  synthetic: true,
  model: args.model ?? 'scripted stand-in',
  captured_at: new Date().toISOString(),
  killed_at: killedAt,
  drill: {
    doc_number: jobB.payload.invoice.doc_number,
    invoices_after_kill: afterKill.invoices.filter((i) => i.DocNumber === jobB.payload.invoice.doc_number).length,
    invoices_after_restart: state.invoices.filter((i) => i.DocNumber === jobB.payload.invoice.doc_number).length,
    events: events.rows.map((e) => ({ at: e.at.toISOString(), event: e.event, detail: e.detail })),
    deal_note: dealBNote?.properties ?? null,
  },
  triage: (await db.query('select route, rule_id, outcome, category, priority, wrote_to_crm, mode from triage_runs order by created_at')).rows,
};
writeFileSync(path.join(OUT, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
console.log(`drill: ${facts.drill.invoices_after_kill} invoice after the kill, ${facts.drill.invoices_after_restart} after the restart`);

await browser.close();
await db.end();
compose('down');
