// Runs synthetic leads through the running stack: form, real n8n, rules, model, CRM
// simulator. Checks what landed, including what didn't, and writes the result to
// results/. Start the stack first with `docker compose up -d --build --wait`.
//
//   node scripts/e2e-lead-path.ts [--leads 24] [--label stand-in]
//
// Phases:
//   shadow    the model answers, nothing reaches ai_ fields
//   live      the same leads, with only ai_ fields written by the triage step
//   failures  model down, bad output, CRM down, n8n down (scripted stand-in only, since
//             a real model can't fail on command and the real server is shared)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { databaseUrl, ROOT, rulesConfig } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { CONTACT_FIELDS, contactProperties } from '../src/leads/contact.ts';
import type { LabeledLead } from '../src/leads/types.ts';
import { sortLead } from '../src/rules/rules.ts';
import { recordModeChange, submissionKey } from '../src/triage/service.ts';

const { values: args } = parseArgs({
  options: {
    leads: { type: 'string', default: '24' },
    label: { type: 'string', default: 'stand-in' },
    'skip-failures': { type: 'boolean', default: false },
  },
});

const APP = 'http://127.0.0.1:4000';
const HUBSPOT = 'http://127.0.0.1:4010';
const LLM = 'http://127.0.0.1:4030';
const INTERNAL = process.env.LTL_INTERNAL_TOKEN ?? 'local-only';

const db = createDb(databaseUrl());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const compose = (...params: string[]) => execFileSync('docker', ['compose', ...params], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Check {
  phase: string;
  name: string;
  pass: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
function check(phase: string, name: string, pass: boolean, detail?: unknown): void {
  checks.push({ phase, name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? 'ok  ' : 'FAIL'} [${phase}] ${name}${!pass && detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const hubspotState = async () =>
  (await (await fetch(`${HUBSPOT}/__sim/state`)).json()) as {
    contacts: Array<{ id: string; properties: Record<string, string | null> }>;
    writeLog: Array<{ type: string; id: string; properties: string[] }>;
  };

async function resetAll(): Promise<void> {
  await post(`${HUBSPOT}/__sim/reset`);
  await post(`${LLM}/__sim/reset`);
  await db.query('truncate lead_submissions, triage_runs, settings, mode_changes, alerts restart identity');
  // The simulator just forgot the ai_ properties; put them back the way setup does.
  execFileSync(process.execPath, ['scripts/setup-hubspot.ts'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HUBSPOT_BASE_URL: HUBSPOT, HUBSPOT_TOKEN: 'sim-hubspot-token' } });
}

async function submit(form: object): Promise<{ ok: boolean; key: string; duplicate: boolean; handed_off: boolean }> {
  const res = await post(`${APP}/submit`, { ...form, synthetic: true });
  return (await res.json()) as { ok: boolean; key: string; duplicate: boolean; handed_off: boolean };
}

async function waitForRuns(expected: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let done = 0;
  while (Date.now() < deadline) {
    const res = await db.query<{ n: number }>("select count(*)::int as n from triage_runs where status <> 'claimed'");
    done = res.rows[0].n;
    if (done >= expected) return done;
    await sleep(500);
  }
  return done;
}

const leads = readFileSync(path.join(ROOT, 'data/leads/dev.synthetic.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as LabeledLead);

// Unique emails only, so contact counts are easy to reason about, then a couple of repeats.
function pickLeads(count: number): LabeledLead[] {
  const seen = new Set<string>();
  const out: LabeledLead[] = [];
  for (const lead of leads) {
    if (lead.generator.resubmission_of || seen.has(lead.form.email)) continue;
    seen.add(lead.form.email);
    out.push(lead);
    if (out.length === count) break;
  }
  return out;
}

const chosen = pickLeads(Number(args.leads));
const expectedRouted = chosen.map((lead) => ({ lead, rule: sortLead(lead.form, rulesConfig) }));
const expectedContacts = expectedRouted.filter((x) => !x.rule?.skip_crm).length;
const timeoutMs = 240_000 + chosen.length * 30_000;

const health = (await (await fetch(`${APP}/healthz`)).json()) as { ok: boolean };
if (!health.ok) throw new Error('app is not healthy');
const n8nVersion = compose('exec', '-T', 'n8n', 'n8n', '--version').trim().split('\n').pop();
const modelName = (compose('exec', '-T', 'app', 'printenv', 'LLM_MODEL').trim());
const usingStandIn = modelName === 'scripted-stand-in';

// ---- Shadow ---------------------------------------------------------------
await resetAll();
const started = new Date().toISOString();
for (const { lead } of expectedRouted) await submit(lead.form);
const repeat = await submit(chosen[0].form);
check('shadow', 'a repeat submission is recognized at the form', repeat.duplicate === true);

let done = await waitForRuns(chosen.length, timeoutMs);
check('shadow', `all ${chosen.length} leads were triaged through n8n`, done === chosen.length, { done });

let state = await hubspotState();
const allowedContact = new Set<string>([...CONTACT_FIELDS, 'ltl_synthetic', 'email']);
check('shadow', 'no ai_ property was written', state.writeLog.every((w) => w.properties.every((p) => !p.startsWith('ai_'))));
check('shadow', 'the contact path wrote only form fields', state.writeLog.every((w) => w.properties.every((p) => allowedContact.has(p))));
check('shadow', 'one contact per lead, minus those rules kept out of the CRM', state.contacts.length === expectedContacts, { contacts: state.contacts.length, expectedContacts });

const shadowRows = await db.query<{ key: string; route: string; rule_id: string | null; mode: string; wrote_to_crm: boolean; fields: Record<string, unknown>; outcome: string; skip_crm: boolean }>('select * from triage_runs');
check('shadow', 'every run is logged as shadow with no CRM write', shadowRows.rows.every((r) => r.mode === 'shadow' && !r.wrote_to_crm));
const byKey = new Map(shadowRows.rows.map((r) => [r.key, r]));
const parity = expectedRouted.every(({ lead, rule }) => {
  const row = byKey.get(submissionKey(lead.form));
  return row && (rule ? row.route === 'rule' && row.rule_id === rule.rule_id : row.route === 'model');
});
check('shadow', 'the rules in n8n sorted every lead the same way as the rules in src/', parity);
check('shadow', 'what would be written is on record for each lead that has fields', shadowRows.rows.filter((r) => !r.skip_crm && r.outcome !== 'model_unavailable').every((r) => Object.keys(r.fields ?? {}).length > 0));
const shadowOutcomes: Record<string, number> = {};
for (const row of shadowRows.rows) shadowOutcomes[row.outcome] = (shadowOutcomes[row.outcome] ?? 0) + 1;

// ---- Live -----------------------------------------------------------------
await resetAll();
await recordModeChange(db, { mode: 'live', signedOffBy: 'e2e script', belowBarNote: 'test run on the simulator' });
for (const { lead } of expectedRouted) await submit(lead.form);
done = await waitForRuns(chosen.length, timeoutMs);
check('live', `all ${chosen.length} leads were triaged through n8n`, done === chosen.length, { done });

state = await hubspotState();
const aiWrites = state.writeLog.filter((w) => w.properties.some((p) => p.startsWith('ai_')));
const liveRows = await db.query<{ key: string; wrote_to_crm: boolean; fields: Record<string, unknown>; skip_crm: boolean; outcome: string }>('select * from triage_runs');
const shouldWrite = liveRows.rows.filter((r) => !r.skip_crm && Object.keys(r.fields ?? {}).length > 0);
check('live', 'triage wrote only ai_ properties, in writes separate from the contact path', aiWrites.every((w) => w.properties.every((p) => p.startsWith('ai_'))));
check('live', 'one ai_ write per lead that had something to write', aiWrites.length === shouldWrite.length, { writes: aiWrites.length, expected: shouldWrite.length });
check('live', 'no CRM process field was ever touched', state.writeLog.every((w) => !w.properties.some((p) => ['lifecyclestage', 'hs_lead_status', 'hubspot_owner_id'].includes(p))));
check('live', 'one contact per lead, minus those rules kept out of the CRM', state.contacts.length === expectedContacts, { contacts: state.contacts.length, expectedContacts });
const contactsMatch = expectedRouted.filter((x) => !x.rule?.skip_crm).every(({ lead }) => {
  const contact = state.contacts.find((c) => c.properties.email === lead.form.email.toLowerCase());
  const row = liveRows.rows.find((r) => r.key === submissionKey(lead.form));
  if (!contact || !row) return false;
  const fieldsMatch = Object.entries(row.fields).every(([name, value]) => String(contact.properties[name]) === String(value));
  const formMatch = Object.entries(contactProperties(lead.form, true)).every(([name, value]) => String(contact.properties[name]) === String(value));
  return fieldsMatch && formMatch;
});
check('live', 'each contact holds the form values and the stored ai_ values', contactsMatch);

// Replay the webhook itself, as n8n or a Zap might.
const replayed = chosen.find((lead) => !sortLead(lead.form, rulesConfig)) ?? chosen[0];
const writesBefore = (await hubspotState()).writeLog.filter((w) => w.properties.some((p) => p.startsWith('ai_'))).length;
const callsBefore = usingStandIn ? ((await (await fetch(`${LLM}/__sim/state`)).json()) as { calls: number }).calls : 0;
await post('http://127.0.0.1:5678/webhook/lead-intake', { submission_key: submissionKey(replayed.form), synthetic: true, form: replayed.form });
await sleep(4000);
const stateAfterReplay = await hubspotState();
const writesAfter = stateAfterReplay.writeLog.filter((w) => w.properties.some((p) => p.startsWith('ai_'))).length;
check('live', 'a replayed webhook made no second ai_ write', writesAfter === writesBefore, { writesBefore, writesAfter });
check('live', 'a replayed webhook left one contact', stateAfterReplay.contacts.filter((c) => c.properties.email === replayed.form.email.toLowerCase()).length === 1);
if (usingStandIn) {
  const callsAfter = ((await (await fetch(`${LLM}/__sim/state`)).json()) as { calls: number }).calls;
  check('live', 'a replayed webhook made no second model call', callsAfter === callsBefore, { callsBefore, callsAfter });
}

// ---- Failures -------------------------------------------------------------
if (!args['skip-failures'] && usingStandIn) {
  const phase = 'failures';
  const lead = (email: string, message: string) => ({
    first_name: 'Test',
    last_name: 'Lead',
    email,
    company: 'Failure Drill (synthetic)',
    property_city: 'Dayton',
    property_state: 'OH',
    inquiry_type: 'new_project',
    message,
  });
  const contactFor = async (email: string) => (await hubspotState()).contacts.find((c) => c.properties.email === email);
  const alertsOf = async (kind: string) => (await db.query('select * from alerts where kind = $1', [kind])).rows;

  await resetAll();
  await recordModeChange(db, { mode: 'live', signedOffBy: 'e2e script', belowBarNote: 'test run on the simulator' });

  // Model down.
  const faultDown = await post(`${LLM}/__sim/faults`, { match: { path: 'chat/completions' }, action: 'status', status: 503, times: 0 });
  check(phase, 'fault armed: model down', faultDown.status === 201);
  await submit(lead('down@drill.example.com', 'Need a quote on 2 rtus at our office.'));
  await waitForRuns(1, 30_000);
  let contact = await contactFor('down@drill.example.com');
  check(phase, 'model down: the lead still reached the CRM through the form path', Boolean(contact));
  check(phase, 'model down: no ai_ fields on it', contact !== undefined && !Object.keys(contact.properties).some((p) => p.startsWith('ai_')));
  check(phase, 'model down: an alert was raised', (await alertsOf('model_unavailable')).length === 1);
  await fetch(`${LLM}/__sim/faults`, { method: 'DELETE' });

  // Model back: retriage fills the fields in.
  execFileSync(process.execPath, ['scripts/retriage.ts'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, LLM_BASE_URL: `${LLM}/v1`, LLM_MODEL: 'scripted-stand-in', HUBSPOT_BASE_URL: HUBSPOT, HUBSPOT_TOKEN: 'sim-hubspot-token' },
  });
  contact = await contactFor('down@drill.example.com');
  check(phase, 'model back: retriage filled in the ai_ fields', Boolean(contact?.properties.ai_category));

  // Bad output.
  await post(`${LLM}/__sim/config`, { raw: 'Sounds like a great lead to me!' });
  await submit(lead('bad-output@drill.example.com', 'Need a quote on 4 rtus at our plant.'));
  await waitForRuns(2, 30_000);
  contact = await contactFor('bad-output@drill.example.com');
  check(phase, 'invalid output: no category written', contact !== undefined && !contact.properties.ai_category);
  check(phase, 'invalid output: flagged for review', contact?.properties.ai_needs_review === 'true');
  await post(`${LLM}/__sim/config`, { raw: JSON.stringify({ category: 'hot_lead', priority: 'high', summary: 'x', confidence: 1 }) });
  await submit(lead('bad-category@drill.example.com', 'Need a quote on 5 rtus at our plant.'));
  await waitForRuns(3, 30_000);
  contact = await contactFor('bad-category@drill.example.com');
  check(phase, 'unknown category: no category written, flagged', contact?.properties.ai_needs_review === 'true' && !contact?.properties.ai_category);
  await post(`${LLM}/__sim/config`, { raw: null });

  // Low confidence.
  await post(`${LLM}/__sim/config`, { confidence: 0.3 });
  await submit(lead('unsure@drill.example.com', 'Need a quote on 6 rtus at our plant.'));
  await waitForRuns(4, 30_000);
  contact = await contactFor('unsure@drill.example.com');
  check(phase, 'low confidence: a summary but no category, flagged', Boolean(contact?.properties.ai_summary) && !contact?.properties.ai_category && contact?.properties.ai_needs_review === 'true');
  await post(`${LLM}/__sim/config`, { confidence: 0.9 });

  // CRM down for the contact upsert: n8n retries, then alerts, then the lead goes back in the queue.
  await post(`${HUBSPOT}/__sim/faults`, { match: { path: 'contacts/batch/upsert' }, action: 'status', status: 500, times: 0 });
  await submit(lead('crm-down@drill.example.com', 'Need a quote on 7 rtus at our plant.'));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await alertsOf('crm_upsert_failed')).length === 0) await sleep(500);
  check(phase, 'CRM down: n8n raised an alert after its retries', (await alertsOf('crm_upsert_failed')).length >= 1);
  await fetch(`${HUBSPOT}/__sim/faults`, { method: 'DELETE' });
  const recovered = Date.now() + 90_000;
  while (Date.now() < recovered && !(await contactFor('crm-down@drill.example.com'))) await sleep(1000);
  check(phase, 'CRM back: the re-drive delivered the lead, with no help', Boolean(await contactFor('crm-down@drill.example.com')));

  // n8n down: the form keeps working and the lead waits.
  compose('stop', 'n8n');
  const whileDown = await submit(lead('n8n-down@drill.example.com', 'Need a quote on 8 rtus at our plant.'));
  check(phase, 'n8n down: the form still accepted the lead', whileDown.ok === true && whileDown.handed_off === false);
  const waiting = await db.query("select 1 from lead_submissions where key = $1 and handed_off_at is null", [whileDown.key]);
  check(phase, 'n8n down: the lead is on disk, waiting', waiting.rowCount === 1);
  compose('start', 'n8n');
  const back = Date.now() + 180_000;
  while (Date.now() < back && !(await contactFor('n8n-down@drill.example.com'))) await sleep(2000);
  check(phase, 'n8n back: the re-drive delivered the lead, with no help', Boolean(await contactFor('n8n-down@drill.example.com')));
}

const finished = new Date().toISOString();
const failed = checks.filter((c) => !c.pass);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const output = {
  synthetic: true,
  crm: 'HubSpot simulator',
  model: modelName,
  scripted_stand_in: usingStandIn,
  n8n_version: n8nVersion,
  git_commit: commit,
  git_dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '',
  leads: chosen.length,
  shadow_outcomes: shadowOutcomes,
  started_at: started,
  finished_at: finished,
  checks_total: checks.length,
  checks_failed: failed.length,
  checks,
};
const dir = path.join(ROOT, 'results/e2e');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `lead-path-${args.label}.json`), `${JSON.stringify(output, null, 2)}\n`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed. Wrote results/e2e/lead-path-${args.label}.json`);
await db.end();
process.exit(failed.length === 0 ? 0 : 1);
