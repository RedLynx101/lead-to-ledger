// The run against the real HubSpot test account and QuickBooks sandbox, in one command:
//
//   npm run real-run                 needs HUBSPOT_TOKEN in .env and `npm run connect:quickbooks` done
//   npm run real-run -- --rehearse   the same steps against the simulators, in their own database
//   npm run real-run -- --model granite-4.1-8b   use a model loaded in LM Studio instead of the stand-in
//
// What it does:
//   1. Checks keys, the QuickBooks connection and the HubSpot key, printing only pass or fail.
//   2. Starts the stack pointed at the real services.
//   3. Probes the behaviour the simulators had to assume: does `requestid` replay for customers
//      and invoices, are DocNumbers unique, does a query see a new record at once, how long
//      HubSpot search lags, and what the error bodies look like.
//   4. Runs leads through the form, n8n and triage in shadow, then live.
//   5. Runs won deals through approval and the worker, then kills a worker around the writes.
//   6. Writes results/real/ (or results/rehearsal/), with tokens, realm IDs and portal IDs removed.
//
// Everything it creates is synthetic and marked so: reserved email domains, ltl_synthetic on
// contacts, and "probe" or "LTL-" numbers in QuickBooks. It never deletes anything.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: args } = parseArgs({
  options: {
    rehearse: { type: 'boolean', default: false },
    model: { type: 'string' },
    'keep-stack': { type: 'boolean', default: false },
  },
});

const rehearse = args.rehearse;
// Set before the config is read, so nothing falls back to the other target.
process.env.LTL_TARGET = rehearse ? 'sim' : 'real';
const SIM_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
if (rehearse) {
  process.env.LTL_TOKEN_KEY = SIM_KEY;
  process.env.HUBSPOT_BASE_URL = 'http://127.0.0.1:4010';
  process.env.QB_API_BASE_URL = 'http://127.0.0.1:4020';
}

const { databaseUrl, hubspotSettings, quickbooksSettings, ROOT, rulesConfig } = await import('../src/config.ts');
const { createDb, migrate } = await import('../src/db.ts');
const { HubSpotClient } = await import('../src/hubspot/client.ts');
const { ensureProperties } = await import('../src/hubspot/properties.ts');
const { QuickBooksClient } = await import('../src/quickbooks/client.ts');
const { tokenKeyFrom, TokenStore } = await import('../src/quickbooks/tokens.ts');
const { connectSimulator } = await import('../src/quickbooks/connect.ts');
const { sortLead } = await import('../src/rules/rules.ts');
const { recordModeChange, submissionKey } = await import('../src/triage/service.ts');
const { approveJob } = await import('../src/worker/jobs.ts');
const { docNumberFor } = await import('../src/worker/payload.ts');
const { pollWonDeals } = await import('../src/worker/poller.ts');
const { findDuplicates } = await import('../src/worker/reconcile.ts');
type LabeledLead = import('../src/leads/types.ts').LabeledLead;
type InvoiceJob = import('../src/worker/jobs.ts').InvoiceJob;

const OUT = path.join(ROOT, rehearse ? 'results/rehearsal' : 'results/real');
const SAMPLES = path.join(OUT, 'samples');
mkdirSync(SAMPLES, { recursive: true });
const RUN = Date.now().toString(36);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Check {
  step: string;
  name: string;
  pass: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
const facts: Record<string, unknown> = {};
function check(step: string, name: string, pass: boolean, detail?: unknown): boolean {
  checks.push({ step, name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? 'ok  ' : 'FAIL'} [${step}] ${name}${!pass && detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
  return pass;
}
function fact(name: string, value: unknown): void {
  facts[name] = value;
  console.log(`fact ${name}: ${JSON.stringify(value)}`);
}

// ---- Scrubbing --------------------------------------------------------------
const secrets: string[] = [];
function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('<removed>');
    // Records carry a `url` into HubSpot's app, on a regional host such as app-na2, with the portal ID in it.
    return out.replace(/https?:\/\/app(?:-[a-z0-9]+)?\.hubspot\.com\/\S*/g, '<hubspot app link removed>');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/^(portalId|hubId|portal_id|realmId|realm_id|access_token|refresh_token|id_token)$/i.test(key)) {
        out[key] = '<removed>';
        continue;
      }
      out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}
function sample(name: string, value: unknown): void {
  writeFileSync(path.join(SAMPLES, `${name}.json`), `${JSON.stringify(scrub(value), null, 2)}\n`);
}

// ---- Setup ------------------------------------------------------------------
const compose = (params: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('docker', ['compose', ...params], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });

const dbName = rehearse ? 'ltl_rehearsal' : 'ltl';
const ADMIN_URL = databaseUrl();
const DB_URL = ADMIN_URL.replace(/\/ltl$/, `/${dbName}`);
process.env.LTL_DATABASE_URL = DB_URL;

console.log(`${rehearse ? 'REHEARSAL against the simulators' : 'REAL RUN against HubSpot and the QuickBooks sandbox'}, run ${RUN}`);
try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
} catch {
  console.error('Docker is not running. Start Docker Desktop and try again.');
  process.exit(1);
}
compose(['up', '-d', '--wait', 'postgres']);
if (rehearse) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  if ((await admin.query("select 1 from pg_database where datname = 'ltl_rehearsal'")).rowCount === 0) await admin.query('create database ltl_rehearsal');
  await admin.end();
}
const db = createDb(DB_URL);
await migrate(db);

// Preflight: names only, never values.
if (!rehearse) {
  const need = ['HUBSPOT_TOKEN', 'INTUIT_CLIENT_ID', 'INTUIT_CLIENT_SECRET', 'LTL_TOKEN_KEY'];
  const missing = need.filter((name) => !process.env[name]);
  if (!check('preflight', `.env has ${need.join(', ')}`, missing.length === 0, { missing })) process.exit(1);
  if (!check('preflight', 'INTUIT_ENVIRONMENT is sandbox', process.env.INTUIT_ENVIRONMENT === 'sandbox')) process.exit(1);
  secrets.push(process.env.HUBSPOT_TOKEN!, process.env.INTUIT_CLIENT_ID!, process.env.INTUIT_CLIENT_SECRET!);
}

const hubspotConfig = hubspotSettings();
const qbConfig = quickbooksSettings();
const store = new TokenStore(db, qbConfig, tokenKeyFrom(process.env.LTL_TOKEN_KEY));
const hubspot = new HubSpotClient({ ...hubspotConfig, timeoutMs: 30_000 });

const stackEnv: NodeJS.ProcessEnv = {
  ...process.env,
  LTL_TARGET: rehearse ? 'sim' : 'real',
  LTL_DB_NAME: dbName,
  LTL_TOKEN_KEY: process.env.LTL_TOKEN_KEY,
  APP_HUBSPOT_BASE_URL: rehearse ? 'http://simulators:4010' : 'https://api.hubapi.com',
  APP_HUBSPOT_TOKEN: rehearse ? 'sim-hubspot-token' : process.env.HUBSPOT_TOKEN,
  APP_QB_API_BASE_URL: rehearse ? 'http://simulators:4020' : 'https://sandbox-quickbooks.api.intuit.com',
  APP_LLM_BASE_URL: args.model ? 'http://host.docker.internal:1234/v1' : 'http://simulators:4030/v1',
  APP_LLM_MODEL: args.model ?? 'scripted-stand-in',
  LTL_AUTO_CONNECT_SIM: rehearse ? 'true' : 'false',
  LTL_AUTO_SETUP: 'false',
  LTL_POLL_MS: '5000',
  LTL_SETTLE_MS: '5000',
};

const started = new Date().toISOString();
console.log('starting the stack');
compose(['up', '-d', '--build', '--wait'], stackEnv);

if (rehearse) {
  // A restarted simulator forgets old tokens, so connect afresh. In a real run, the
  // connection comes from npm run connect:quickbooks and is never touched here.
  await db.query('truncate oauth_connections');
  await connectSimulator(qbConfig, store);
}
if (!check('preflight', 'QuickBooks is connected', (await store.status()) === 'connected', 'run npm run connect:quickbooks first')) process.exit(1);
const realm = await store.realmId();
secrets.push(realm);
const qb = new QuickBooksClient({ baseUrl: qbConfig.apiBaseUrl, realmId: async () => realm, tokens: store, minorVersion: qbConfig.minorVersion, timeoutMs: 30_000 });
check('preflight', 'a QuickBooks test read works', (await qb.companyName()).ok);

async function hubspotRaw(method: string, route: string, body?: unknown, token = hubspotConfig.token) {
  const res = await fetch(`${hubspotConfig.baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep the text.
  }
  return { status: res.status, body: json, headers: Object.fromEntries([...res.headers].filter(([k]) => k.startsWith('x-hubspot-ratelimit'))) };
}
const V = hubspotConfig.apiVersion;
const keyCheck = await hubspotRaw('GET', `/crm/properties/${V}/contacts?archived=false`);
if (!check('preflight', 'the HubSpot key can read contact properties', keyCheck.status === 200, { status: keyCheck.status })) process.exit(1);
if (!rehearse) {
  // The portal ID turns up inside values, not just under portalId keys, so scrub it everywhere.
  const account = await hubspotRaw('GET', '/account-info/v3/details');
  const portalId = (account.body as { portalId?: number } | null)?.portalId;
  if (portalId) secrets.push(String(portalId));
  check('preflight', 'the HubSpot portal ID is known, so it can be removed from saved files', Boolean(portalId), { status: account.status });
}

await db.query('truncate lead_submissions, triage_runs, settings, mode_changes, alerts, external_calls, job_events, approvals, invoice_jobs, poll_cursors restart identity cascade');

// ---- HubSpot setup and probes ---------------------------------------------------
facts.hubspot_property_setup = await ensureProperties(hubspot);
check('hubspot', 'the ai_ and ltl_ properties exist', Object.values(facts.hubspot_property_setup as Record<string, string>).every((v) => v === 'created' || v === 'exists'));

const pipelines = await hubspotRaw('GET', `/crm/pipelines/${V}/deals`);
sample('hubspot-pipelines', pipelines);
const stageIds = ((pipelines.body as { results?: Array<{ stages: Array<{ id: string }> }> }).results ?? []).flatMap((p) => p.stages.map((s) => s.id));
check('hubspot', 'deal pipelines are readable', pipelines.status === 200, { status: pipelines.status });
fact('hubspot_won_stage_present', stageIds.includes(hubspotConfig.wonStage));
// HubSpot refuses a deal with no pipeline, so use the one that holds the won stage.
const wonPipeline = ((pipelines.body as { results?: Array<{ id: string; stages: Array<{ id: string }> }> }).results ?? []).find((p) => p.stages.some((s) => s.id === hubspotConfig.wonStage))?.id ?? 'default';
fact('hubspot_won_pipeline', wonPipeline);
// The first real run stopped here: a deal with no pipeline was refused. Keep the evidence.
// An open stage, so if it were ever accepted the poller would ignore it.
const noPipeline = await hubspotRaw('POST', `/crm/objects/${V}/deals`, { properties: { dealname: `Probe ${RUN} [probe]`, dealstage: 'appointmentscheduled' } });
sample('hubspot-deal-without-pipeline', noPipeline);
fact('hubspot_deal_without_pipeline', { status: noPipeline.status, category: (noPipeline.body as { category?: string })?.category ?? null });

const probeEmail = `probe.${RUN}@lead-to-ledger.example.com`;
const created = await hubspotRaw('POST', `/crm/objects/${V}/contacts`, { properties: { email: probeEmail, firstname: 'Probe', lastname: RUN, ltl_synthetic: 'true' } });
sample('hubspot-contact-create', created);
check('hubspot', 'a contact can be created', created.status === 201, { status: created.status });
const probeId = (created.body as { id?: string }).id ?? '';

const duplicate = await hubspotRaw('POST', `/crm/objects/${V}/contacts`, { properties: { email: probeEmail } });
sample('hubspot-contact-duplicate', duplicate);
fact('hubspot_duplicate_email', { status: duplicate.status, category: (duplicate.body as { category?: string })?.category ?? null });

const unknown = await hubspotRaw('PATCH', `/crm/objects/${V}/contacts/${probeId}`, { properties: { ltl_no_such_property: 'x' } });
sample('hubspot-unknown-property', unknown);
fact('hubspot_unknown_property', { status: unknown.status, category: (unknown.body as { category?: string })?.category ?? null });

const missing = await hubspotRaw('GET', `/crm/objects/${V}/contacts/1`);
sample('hubspot-not-found', missing);
fact('hubspot_not_found', { status: missing.status, category: (missing.body as { category?: string })?.category ?? null });

const badToken = await hubspotRaw('GET', `/crm/objects/${V}/contacts?limit=1`, undefined, 'not-a-real-token');
sample('hubspot-bad-token', badToken);
fact('hubspot_bad_token', { status: badToken.status, category: (badToken.body as { category?: string })?.category ?? null });
fact('hubspot_rate_limit_headers', Object.keys(keyCheck.headers));

const byEmail = await hubspotRaw('GET', `/crm/objects/${V}/contacts/${encodeURIComponent(probeEmail)}?idProperty=email`);
fact('hubspot_read_by_email_right_after_create', byEmail.status === 200);

let searchLagMs: number | null = null;
const searchStart = Date.now();
while (Date.now() - searchStart < 90_000) {
  const res = await hubspotRaw('POST', `/crm/objects/${V}/contacts/search`, { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: probeEmail }] }] });
  if (res.status === 200 && (res.body as { total: number }).total > 0) {
    searchLagMs = Date.now() - searchStart;
    sample('hubspot-search', res);
    break;
  }
  await sleep(1000);
}
fact('hubspot_search_lag_ms_upper_bound', searchLagMs);

// ---- QuickBooks probes ------------------------------------------------------------
async function qbRaw(method: string, route: string, body?: unknown, extra: Record<string, string> = {}, token?: string) {
  const access = token ?? (await store.accessToken());
  const url = new URL(`${qbConfig.apiBaseUrl}/v3/company/${realm}/${route}`);
  url.searchParams.set('minorversion', qbConfig.minorVersion);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep the text.
  }
  return { status: res.status, body: json as Record<string, unknown> };
}
const faultCode = (body: Record<string, unknown>) => {
  const fault = (body?.Fault ?? body?.fault) as { Error?: Array<{ code?: string }>; error?: Array<{ code?: string }> } | undefined;
  return (fault?.Error ?? fault?.error)?.[0]?.code ?? null;
};

const prefs = await qbRaw('GET', 'preferences');
const customNumbers = (prefs.body?.Preferences as { SalesFormsPrefs?: { CustomTxnNumbers?: boolean } })?.SalesFormsPrefs?.CustomTxnNumbers ?? null;
fact('qb_custom_txn_numbers', customNumbers);

const items = await qb.findItemByName(qbConfig.itemName);
check('quickbooks', `the item "${qbConfig.itemName}" exists`, items.ok && items.body.length > 0);
const itemId = items.ok ? items.body[0]?.Id : undefined;

// Customer: the same requestid twice, then the same requestid with a different body.
const probeCustomer = { DisplayName: `Probe ${RUN} [probe]`, Notes: 'Synthetic test data.' };
const c1 = await qbRaw('POST', 'customer', probeCustomer, { requestid: `ltl-probe-c-${RUN}` });
const c2 = await qbRaw('POST', 'customer', probeCustomer, { requestid: `ltl-probe-c-${RUN}` });
sample('qb-customer-create', c1);
sample('qb-customer-same-requestid', c2);
const c1Id = (c1.body?.Customer as { Id?: string })?.Id;
const c2Id = (c2.body?.Customer as { Id?: string })?.Id;
fact(
  'qb_requestid_customer',
  c2.status === 200 && c2Id === c1Id ? 'replay' : faultCode(c2.body) === '600' ? 'duplicate_error' : faultCode(c2.body) === '6240' ? 'not_honored, blocked by unique name' : c2Id && c2Id !== c1Id ? 'not_honored, created again' : `other: ${c2.status} ${faultCode(c2.body)}`,
);
const c3 = await qbRaw('POST', 'customer', { ...probeCustomer, DisplayName: `Probe ${RUN} changed [probe]` }, { requestid: `ltl-probe-c-${RUN}` });
sample('qb-customer-same-requestid-new-body', c3);
const c3Id = (c3.body?.Customer as { Id?: string })?.Id;
fact('qb_requestid_customer_new_body', c3.status === 200 && c3Id === c1Id ? 'replayed the first response' : faultCode(c3.body) === '600' ? 'duplicate_error' : c3Id ? 'created a new record' : `other: ${c3.status} ${faultCode(c3.body)}`);
const nameClash = await qbRaw('POST', 'customer', probeCustomer, { requestid: `ltl-probe-c2-${RUN}` });
sample('qb-customer-duplicate-name', nameClash);
fact('qb_duplicate_display_name', { status: nameClash.status, code: faultCode(nameClash.body) });

// Invoice: the same requestid twice, a new requestid with the same DocNumber, and how soon a query sees it.
const probeDoc = `LTLP-${RUN}`.slice(0, 21);
const invoiceBody = {
  CustomerRef: { value: c1Id },
  DocNumber: probeDoc,
  PrivateNote: 'Probe. Synthetic test data.',
  Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10, SalesItemLineDetail: { ItemRef: { value: itemId } } }],
};
const i1 = await qbRaw('POST', 'invoice', invoiceBody, { requestid: `ltl-probe-i-${RUN}` });
const visibleStart = Date.now();
let queryLagMs: number | null = null;
while (Date.now() - visibleStart < 60_000) {
  const found = await qb.findInvoicesByDocNumber(probeDoc);
  if (found.ok && found.body.length > 0) {
    queryLagMs = Date.now() - visibleStart;
    break;
  }
  await sleep(250);
}
fact('qb_query_sees_new_invoice_within_ms', queryLagMs);
sample('qb-invoice-create', i1);
fact('qb_doc_number_kept', (i1.body?.Invoice as { DocNumber?: string })?.DocNumber === probeDoc);
const i2 = await qbRaw('POST', 'invoice', invoiceBody, { requestid: `ltl-probe-i-${RUN}` });
sample('qb-invoice-same-requestid', i2);
const i1Id = (i1.body?.Invoice as { Id?: string })?.Id;
const i2Id = (i2.body?.Invoice as { Id?: string })?.Id;
fact('qb_requestid_invoice', i2.status === 200 && i2Id === i1Id ? 'replay' : faultCode(i2.body) === '600' ? 'duplicate_error' : faultCode(i2.body) === '6140' ? 'not_honored, blocked by unique DocNumber' : i2Id && i2Id !== i1Id ? 'not_honored, created again' : `other: ${i2.status} ${faultCode(i2.body)}`);
const i3 = await qbRaw('POST', 'invoice', invoiceBody, { requestid: `ltl-probe-i2-${RUN}` });
sample('qb-invoice-same-doc-number', i3);
fact('qb_duplicate_doc_number', (i3.body?.Invoice as { Id?: string })?.Id ? 'allowed' : faultCode(i3.body) === '6140' ? 'rejected, 6140' : `other: ${i3.status} ${faultCode(i3.body)}`);

const badQuery = await qbRaw('GET', 'query', undefined, { query: 'SELECT FROM' });
sample('qb-bad-query', badQuery);
fact('qb_bad_query', { status: badQuery.status, code: faultCode(badQuery.body) });
const badAuth = await qbRaw('GET', 'preferences', undefined, {}, 'not-a-real-token');
sample('qb-bad-token', badAuth);
fact('qb_bad_token', { status: badAuth.status, code: faultCode(badAuth.body) });
const emptyQuery = await qbRaw('GET', 'query', undefined, { query: `SELECT * FROM Invoice WHERE DocNumber = 'LTLP-none-${RUN}'` });
sample('qb-empty-query', emptyQuery);

// ---- The lead path, through n8n -------------------------------------------------
const APP = 'http://127.0.0.1:4000';
const allLeads = readFileSync(path.join(ROOT, 'data/leads/dev.synthetic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LabeledLead);
const usable = allLeads.filter((l) => !l.generator.resubmission_of && !sortLead(l.form, rulesConfig)?.skip_crm);
// New email addresses each run, so each contact is new.
const withRunEmail = (lead: LabeledLead, n: number) => ({ ...lead.form, email: `lead${n}.${RUN}@${lead.form.email.split('@')[1]}` });
const shadowLeads = usable.slice(0, 3).map(withRunEmail);
const liveLeads = usable.slice(3, 6).map((l, i) => withRunEmail(l, i + 3));

async function submit(form: object) {
  const res = await fetch(`${APP}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, synthetic: true }) });
  return (await res.json()) as { ok: boolean; key: string };
}
async function waitForRuns(count: number, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = (await db.query<{ n: number }>("select count(*)::int as n from triage_runs where status <> 'claimed'")).rows[0].n;
    if (n >= count) return n;
    await sleep(1000);
  }
  return -1;
}
const AI = ['ai_category', 'ai_priority', 'ai_summary', 'ai_confidence', 'ai_needs_review', 'ai_source', 'ai_model'];

await recordModeChange(db, { mode: 'shadow' });
for (const form of shadowLeads) await submit(form);
check('lead path', 'shadow: every lead was triaged through n8n', (await waitForRuns(shadowLeads.length)) === shadowLeads.length);
for (const form of shadowLeads) {
  const contact = await hubspot.getContactByEmail(form.email, [...AI, 'firstname', 'ltl_synthetic']);
  check('lead path', `shadow: ${form.email.split('@')[0]} reached the CRM with no ai_ fields`, Boolean(contact) && AI.every((p) => !contact!.properties[p]));
}

await recordModeChange(db, { mode: 'live', signedOffBy: 'real-run script', belowBarNote: 'synthetic leads, testing the CRM writes' });
for (const form of liveLeads) await submit(form);
check('lead path', 'live: every lead was triaged through n8n', (await waitForRuns(shadowLeads.length + liveLeads.length)) === shadowLeads.length + liveLeads.length);
for (const form of liveLeads) {
  const row = (await db.query<{ fields: Record<string, unknown> }>('select fields from triage_runs where key = $1', [submissionKey(form)])).rows[0];
  const contact = await hubspot.getContactByEmail(form.email, AI);
  const matches = Boolean(row && contact) && Object.entries(row.fields).every(([k, v]) => String(contact!.properties[k]) === String(v));
  check('lead path', `live: ${form.email.split('@')[0]} holds exactly the stored ai_ values`, matches);
}
const replayed = liveLeads[0];
const before = await hubspot.getContactByEmail(replayed.email, AI);
await fetch('http://127.0.0.1:5678/webhook/lead-intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submission_key: submissionKey(replayed), synthetic: true, form: replayed }) });
await sleep(8000);
const after = await hubspot.getContactByEmail(replayed.email, AI);
check('lead path', 'a replayed webhook changed no ai_ field', AI.every((p) => before?.properties[p] === after?.properties[p]));
await recordModeChange(db, { mode: 'shadow' });

// ---- The invoice path ---------------------------------------------------------------
const jobFor = async (dealId: string) => (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [dealId])).rows[0] as InvoiceJob | undefined;
async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}
async function wonDeal(n: number, amount: string) {
  const contact = await hubspot.upsertContactByEmail(`buyer${n}.${RUN}@cedarsquare.example.com`, { firstname: 'Pat', lastname: `Buyer ${n}`, company: `Cedar Square ${RUN}-${n}`, ltl_synthetic: true });
  const deal = await hubspot.createDeal({ dealname: `Rooftop units ${RUN}-${n}`, dealstage: hubspotConfig.wonStage, pipeline: wonPipeline, amount, closedate: new Date().toISOString() }, contact.id);
  return deal.id;
}
const invoicesFor = async (doc: string) => {
  const found = await qb.findInvoicesByDocNumber(doc);
  return found.ok ? found.body.length : -1;
};

const dealA = await wonDeal(1, '12500');
const jobA = await waitFor(() => jobFor(dealA), 120_000);
check('invoice path', 'the worker polled the won deal into a job', jobA?.status === 'awaiting_approval', jobA?.status);
if (jobA) {
  const res = await fetch(`${APP}/approvals/${jobA.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ digest: jobA.digest, approved_by: 'Real-run script' }).toString(),
    redirect: 'manual',
  });
  check('invoice path', 'approval through the page', res.status === 303);
  const done = await waitFor(async () => ((await jobFor(dealA))?.status === 'done' ? jobFor(dealA) : null), 180_000);
  check('invoice path', 'the job finished', Boolean(done), (await jobFor(dealA))?.problem);
  check('invoice path', 'one invoice in QuickBooks', (await invoicesFor(docNumberFor(dealA))) === 1);
  const deal = await hubspot.getDeal(dealA, ['ltl_qb_invoice_id', 'ltl_qb_doc_number']);
  check('invoice path', 'the invoice is noted on the deal', Boolean(deal?.properties.ltl_qb_invoice_id));
}

// Kill drills: a worker on this machine, killed at an exact point, then a second one.
compose(['stop', 'worker'], stackEnv);
const workerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  LTL_DATABASE_URL: DB_URL,
  LTL_POLL: 'false',
  LTL_LEASE_SECONDS: '5',
  LTL_SETTLE_MS: '5000',
  LTL_RETRY_DELAY_MS: '1000',
};
function runWorker(killAt = ''): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/worker/main.ts', '--once'], { cwd: ROOT, env: { ...workerEnv, LTL_KILL_AT: killAt }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (out += String(c)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
const drills: Array<{ at: string; invoices: number; status: string | undefined; foundByLookup: boolean }> = [];
for (const [n, at] of [[2, 'after:qb.create_invoice'], [3, 'before:qb.create_invoice'], [4, 'after:qb.create_customer']] as const) {
  const dealId = await wonDeal(n, String(1000 * n));
  let job: InvoiceJob | undefined;
  for (let i = 0; i < 90 && !job; i += 1) {
    await pollWonDeals({ db, hubspot }, { wonStage: hubspotConfig.wonStage, itemName: qbConfig.itemName, overlapMs: 3_600_000 });
    job = await jobFor(dealId);
    if (!job) await sleep(1000);
  }
  if (!job) {
    check('kill drills', `${at}: the deal became a job`, false);
    continue;
  }
  await approveJob(db, job.id, job.digest, 'Real-run script');
  const first = await runWorker(at);
  check('kill drills', `${at}: the worker died at that point`, first.includes(`KILL ${at}`));
  await runWorker();
  const final = await jobFor(dealId);
  const events = await db.query<{ event: string }>('select event from job_events where job_id = $1', [job.id]);
  const count = await invoicesFor(docNumberFor(dealId));
  drills.push({ at, invoices: count, status: final?.status, foundByLookup: events.rows.some((e) => e.event === 'found_existing') });
  check('kill drills', `${at}: one invoice after a restart`, count === 1 && final?.status === 'done', { invoices: count, status: final?.status, problem: final?.problem });
}
facts.kill_drills = drills;

const duplicates = await findDuplicates(db, qb);
fact('qb_duplicates_found_by_reconcile', duplicates.length);

// ---- Write up ---------------------------------------------------------------------
const finished = new Date().toISOString();
const failed = checks.filter((c) => !c.pass);
const git = (...params: string[]) => execFileSync('git', params, { cwd: ROOT, encoding: 'utf8' }).trim();
const output = scrub({
  target: rehearse ? 'simulators (rehearsal)' : 'HubSpot test account and QuickBooks sandbox',
  synthetic: true,
  model: args.model ?? 'scripted stand-in',
  git_commit: git('rev-parse', '--short', 'HEAD'),
  git_dirty: git('status', '--porcelain') !== '',
  started_at: started,
  finished_at: finished,
  checks_total: checks.length,
  checks_failed: failed.length,
  facts,
  checks,
});
writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
const lines = [
  `# ${rehearse ? 'Rehearsal on the simulators' : 'Real run'}`,
  '',
  rehearse
    ? 'The real-run script run against the simulators, to prove it works before keys exist. These facts describe the simulators, not HubSpot or QuickBooks.'
    : 'Run against a HubSpot test account and the QuickBooks sandbox, with synthetic data. Tokens, realm IDs and portal IDs are removed from everything saved here.',
  '',
  `- Commit \`${(output as { git_commit: string }).git_commit}\`, ${started} to ${finished}. Model: ${args.model ?? 'scripted stand-in'}.`,
  `- ${checks.length - failed.length} of ${checks.length} checks passed.`,
  '',
  '## What the simulators had to assume',
  '',
  '| Fact | Result |',
  '|---|---|',
  ...Object.entries(facts).map(([k, v]) => `| ${k} | \`${JSON.stringify(scrub(v))}\` |`),
  '',
  '## Checks',
  '',
  ...checks.map((c) => `- ${c.pass ? 'ok' : '**FAIL**'} [${c.step}] ${c.name}`),
  '',
  'Raw responses, scrubbed, are in `samples/`.',
  '',
];
writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n'));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Wrote ${path.relative(ROOT, OUT)}/summary.md`);

await db.end();
if (!args['keep-stack']) compose(['down'], stackEnv);
process.exit(failed.length === 0 ? 0 : 1);
