// The invoice path's rules, with a real Postgres and the simulators, in one process.
// The real kills are in scripts/restart-tests.ts. These cover what a kill can't show:
// approvals, edits, polling, and how each kind of failure is routed.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { databaseUrl } from '../../src/config.ts';
import type { QuickBooksSettings } from '../../src/config.ts';
import { createDb, migrate } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { HubSpotClient } from '../../src/hubspot/client.ts';
import { ensureProperties } from '../../src/hubspot/properties.ts';
import { QuickBooksClient } from '../../src/quickbooks/client.ts';
import { connectSimulator } from '../../src/quickbooks/connect.ts';
import { encrypt, ReconnectNeeded, tokenKeyFrom, TokenStore } from '../../src/quickbooks/tokens.ts';
import { createHubSpotSim } from '../../src/simulators/hubspot.ts';
import { createQuickBooksSim } from '../../src/simulators/quickbooks.ts';
import type { SimServer } from '../../src/simulators/harness.ts';
import { approveJob, claimNext, upsertJobFromDeal } from '../../src/worker/jobs.ts';
import type { ClaimedJob, InvoiceJob } from '../../src/worker/jobs.ts';
import { pollWonDeals } from '../../src/worker/poller.ts';
import { processJob } from '../../src/worker/process.ts';
import type { JobOutcome, WorkerDeps } from '../../src/worker/process.ts';
import { findDuplicates } from '../../src/worker/reconcile.ts';
import { addFault, simState, sleep, startSim } from '../helpers.ts';

const TEST_DB_URL = databaseUrl().replace(/\/ltl$/, '/ltl_test');

async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl() });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = 'ltl_test'");
  if (exists.rowCount === 0) await admin.query('create database ltl_test');
  await admin.end();
}

interface QbState {
  customers: Array<{ Id: string; DisplayName: string; Balance: number }>;
  invoices: Array<{ Id: string; DocNumber?: string; TotalAmt: number }>;
}

describe('invoice path', () => {
  let db: Db;
  let hubspotSim: SimServer;
  let qbSim: SimServer;
  let hubspot: HubSpotClient;
  let qb: QuickBooksClient;
  let store: TokenStore;
  let settings: QuickBooksSettings;
  let deps: WorkerDeps;

  const qbState = () => simState<QbState>(qbSim);
  const jobFor = async (dealId: string) => (await db.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1', [dealId])).rows[0];
  const events = async (jobId: string) => (await db.query<{ event: string; detail: Record<string, unknown> | null }>('select event, detail from job_events where job_id = $1 order by id', [jobId])).rows;
  const alertKinds = async () => (await db.query<{ kind: string }>('select kind from alerts order by id')).rows.map((r) => r.kind);
  const poll = () => pollWonDeals({ db, hubspot }, { wonStage: 'closedwon', itemName: 'Services', overlapMs: 60_000 });
  const qbConfig = (patch: unknown) => fetch(`${qbSim.url()}/__sim/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

  async function wonDeal(name = 'a', amount = '12500', stage = 'closedwon') {
    const contact = await hubspot.upsertContactByEmail(`${name}@cedar.example.com`, { firstname: 'Pat', lastname: name, company: `Cedar ${name}` });
    const deal = await hubspot.createDeal({ dealname: `Deal ${name}`, dealstage: stage, pipeline: 'default', amount, closedate: '2026-10-30T00:00:00Z' }, contact.id);
    return { contact, deal };
  }

  async function approved(name = 'a') {
    const { contact, deal } = await wonDeal(name);
    await poll();
    const job = await jobFor(deal.id);
    const result = await approveJob(db, job.id, job.digest, 'Test');
    assert.ok(result.ok);
    return { contact, deal, job: await jobFor(deal.id) };
  }

  /** Runs jobs in this process until nothing is ready, up to a limit. */
  async function drain(limit = 12): Promise<JobOutcome[]> {
    const outcomes: JobOutcome[] = [];
    for (let i = 0; i < limit; i += 1) {
      const job: ClaimedJob | null = await claimNext(db, 60);
      if (!job) {
        const waiting = await db.query("select count(*)::int as n from invoice_jobs where status = 'queued'");
        if (waiting.rows[0].n === 0) return outcomes;
        await sleep(15);
        continue;
      }
      outcomes.push(await processJob(deps, job));
    }
    return outcomes;
  }

  before(async () => {
    await ensureTestDatabase();
    db = createDb(TEST_DB_URL);
    await migrate(db);
    hubspotSim = await startSim(createHubSpotSim({ searchLagMs: 0, enforceRateLimits: false }));
    qbSim = await startSim(createQuickBooksSim({ enforceRateLimits: false }));
    settings = {
      apiBaseUrl: qbSim.url(),
      discoveryUrl: `${qbSim.url()}/.well-known/openid_sandbox_configuration`,
      clientId: 'sim-client-id',
      clientSecret: 'sim-client-secret',
      redirectUri: 'http://localhost:8765/callback',
      minorVersion: '75',
      itemName: 'Services',
    };
  });
  after(async () => {
    await hubspotSim.close();
    await qbSim.close();
    await db.end();
  });
  beforeEach(async () => {
    await db.query('truncate external_calls, job_events, approvals, invoice_jobs, poll_cursors, oauth_connections, alerts restart identity cascade');
    await fetch(`${hubspotSim.url()}/__sim/reset`, { method: 'POST' });
    await fetch(`${qbSim.url()}/__sim/reset`, { method: 'POST' });
    hubspot = new HubSpotClient({ baseUrl: hubspotSim.url(), token: 'sim-hubspot-token', apiVersion: '2026-09', timeoutMs: 300, sleep: async () => {} });
    await ensureProperties(hubspot);
    store = new TokenStore(db, settings, tokenKeyFrom(Buffer.alloc(32, 1).toString('base64')));
    await connectSimulator(settings, store);
    qb = new QuickBooksClient({ baseUrl: qbSim.url(), realmId: () => store.realmId(), tokens: store, timeoutMs: 200 });
    deps = {
      db,
      hubspot,
      qb,
      checkpoint: () => {},
      settings: { leaseSeconds: 60, settleMs: 20, retryDelayMs: 1, maxAttempts: 8, reconnectDelayMs: 1, wonStage: 'closedwon', itemName: 'Services' },
    };
  });

  describe('polling', () => {
    test('a won deal becomes one job, however many polls see it', async () => {
      const { deal } = await wonDeal();
      await poll();
      await poll();
      await poll();
      const jobs = await db.query('select * from invoice_jobs');
      assert.equal(jobs.rowCount, 1);
      assert.equal(jobs.rows[0].deal_id, deal.id);
      assert.equal(jobs.rows[0].status, 'awaiting_approval');
    });

    test('a deal that is not won is ignored, until it is', async () => {
      const { deal } = await wonDeal('open', '500', 'contractsent');
      await poll();
      assert.equal((await db.query('select * from invoice_jobs')).rowCount, 0);
      await hubspot.updateDeal(deal.id, { dealstage: 'closedwon' });
      await poll();
      assert.equal((await db.query('select * from invoice_jobs')).rowCount, 1);
    });

    test('a deal search that lags is picked up by the next poll', async () => {
      await fetch(`${hubspotSim.url()}/__sim/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchLagMs: 80 }) });
      await wonDeal();
      await poll();
      assert.equal((await db.query('select * from invoice_jobs')).rowCount, 0);
      await sleep(120);
      await poll();
      assert.equal((await db.query('select * from invoice_jobs')).rowCount, 1);
    });

    test('the overlap catches a deal modified just before the cursor', async () => {
      const first = await wonDeal('first');
      await poll();
      const second = await wonDeal('second');
      await poll();
      assert.ok(await jobFor(first.deal.id));
      assert.ok(await jobFor(second.deal.id));
    });

    test('a deal with no amount or no contact needs a person, and recovers when fixed', async () => {
      const contact = await hubspot.upsertContactByEmail('n@cedar.example.com', { firstname: 'N' });
      const noContact = await hubspot.createDeal({ dealname: 'No contact', dealstage: 'closedwon', pipeline: 'default', amount: '100' });
      const noAmount = await hubspot.createDeal({ dealname: 'No amount', dealstage: 'closedwon' , pipeline: 'default'}, contact.id);
      await poll();
      assert.equal((await jobFor(noContact.id)).status, 'needs_person');
      assert.match(String((await jobFor(noContact.id)).problem), /no contact/);
      assert.equal((await jobFor(noAmount.id)).status, 'needs_person');
      assert.deepEqual(await alertKinds(), ['deal_needs_fixing', 'deal_needs_fixing']);

      await hubspot.updateDeal(noAmount.id, { amount: '250' });
      await poll();
      assert.equal((await jobFor(noAmount.id)).status, 'awaiting_approval');
    });
  });

  describe('approval', () => {
    test('nothing runs until a person approves', async () => {
      await wonDeal();
      await poll();
      assert.equal(await claimNext(db, 60), null);
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('an approval needs a name and the exact content', async () => {
      const { deal } = await wonDeal();
      await poll();
      const job = await jobFor(deal.id);
      assert.deepEqual(await approveJob(db, job.id, job.digest, '   '), { ok: false, reason: 'no_name' });
      assert.deepEqual(await approveJob(db, job.id, 'wrong-digest', 'Test'), { ok: false, reason: 'stale_digest' });
      assert.equal((await jobFor(deal.id)).status, 'awaiting_approval');
      assert.ok((await approveJob(db, job.id, job.digest, 'Test')).ok);
      assert.equal((await jobFor(deal.id)).status, 'queued');
    });

    test('approving twice is refused, and leaves one approval', async () => {
      const { job } = await approved();
      assert.deepEqual(await approveJob(db, job.id, job.digest, 'Someone else'), { ok: false, reason: 'not_awaiting_approval' });
      assert.equal((await db.query('select * from approvals')).rowCount, 1);
    });

    test('a page loaded before an edit cannot approve what came after it', async () => {
      const { deal } = await wonDeal();
      await poll();
      const before = await jobFor(deal.id);
      await hubspot.updateDeal(deal.id, { amount: '99999' });
      await poll();
      assert.deepEqual(await approveJob(db, before.id, before.digest, 'Test'), { ok: false, reason: 'stale_digest' });
      assert.equal((await jobFor(deal.id)).payload.invoice.amount, 99999);
    });

    test('an edit after approval is refused: the poller sends it back', async () => {
      const { deal } = await approved();
      await hubspot.updateDeal(deal.id, { amount: '99999' });
      await poll();
      const job = await jobFor(deal.id);
      assert.equal(job.status, 'awaiting_approval');
      assert.equal(job.approval_id, null);
      assert.equal(await claimNext(db, 60), null);
      assert.ok((await alertKinds()).includes('changed_after_approval'));
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('an edit the poller has not seen yet is caught by the worker before it writes', async () => {
      const { deal } = await approved();
      await hubspot.updateDeal(deal.id, { amount: '99999' });
      assert.deepEqual(await drain(), ['back_to_approval']);
      const job = await jobFor(deal.id);
      assert.equal(job.status, 'awaiting_approval');
      assert.equal(job.payload.invoice.amount, 99999);
      assert.equal(job.approval_id, null);
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('a deal moved out of closed won before the worker runs goes back for a look', async () => {
      const { deal } = await approved();
      await hubspot.updateDeal(deal.id, { dealstage: 'contractsent' });
      assert.deepEqual(await drain(), ['back_to_approval']);
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('content changed behind the queue, directly in the database, is refused at claim', async () => {
      const { job } = await approved();
      await db.query("update invoice_jobs set payload = jsonb_set(payload, '{invoice,amount}', '1'), digest = 'tampered' where id = $1", [job.id]);
      assert.equal(await claimNext(db, 60), null);
      const after = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [job.id])).rows[0];
      assert.equal(after.status, 'awaiting_approval');
      assert.equal((await events(job.id)).at(-1)?.detail?.reason, 'content changed after approval');
    });

    test("another job's approval is refused", async () => {
      const a = await approved('a');
      const b = await approved('b');
      await db.query('update invoice_jobs set approval_id = $2 where id = $1', [b.job.id, a.job.approval_id]);
      const claimed = await claimNext(db, 60);
      assert.equal(claimed?.id, a.job.id, 'job A still runs on its own approval');
      assert.equal(await claimNext(db, 60), null, 'job B does not run on it');
      assert.equal((await jobFor(b.deal.id)).status, 'awaiting_approval');
    });

    test('a spent approval is refused: a finished job put back in the queue does not run', async () => {
      const { job, deal } = await approved();
      assert.deepEqual(await drain(), ['done']);
      await db.query("update invoice_jobs set status = 'queued' where id = $1", [job.id]);
      assert.equal(await claimNext(db, 60), null);
      const after = await jobFor(deal.id);
      assert.equal(after.status, 'needs_person');
      assert.match(String(after.problem), /already used/);
      assert.equal((await qbState()).invoices.length, 1);
    });

    test('a retry of a job in progress does not need a new approval', async () => {
      const { deal } = await approved();
      await addFault(qbSim, { match: { method: 'POST', path: '/invoice$' }, action: 'status', status: 500 });
      assert.deepEqual(await drain(), ['retry', 'done']);
      assert.equal((await db.query('select * from approvals')).rowCount, 1);
      assert.equal((await jobFor(deal.id)).status, 'done');
    });

    test('the approval is marked spent when a worker first claims the job', async () => {
      await approved();
      const before = await db.query('select consumed_at from approvals');
      assert.equal(before.rows[0].consumed_at, null);
      await claimNext(db, 60);
      const after = await db.query('select consumed_at from approvals');
      assert.ok(after.rows[0].consumed_at);
    });
  });

  describe('the happy path', () => {
    test('creates one customer and one invoice, reads it back, and notes it on the deal', async () => {
      const { deal } = await approved();
      assert.deepEqual(await drain(), ['done']);
      const state = await qbState();
      assert.equal(state.customers.length, 2, 'the seeded customer plus one');
      assert.equal(state.invoices.length, 1);
      assert.equal(state.invoices[0].DocNumber, `LTL-${deal.id}`);
      assert.equal(state.invoices[0].TotalAmt, 12500);
      const job = await jobFor(deal.id);
      assert.equal(job.status, 'done');
      assert.equal(job.qb_invoice_id, state.invoices[0].Id);
      const updated = await hubspot.getDeal(deal.id, ['ltl_qb_invoice_id', 'ltl_qb_doc_number', 'dealstage']);
      assert.equal(updated?.properties.ltl_qb_invoice_id, state.invoices[0].Id);
      assert.equal(updated?.properties.ltl_qb_doc_number, `LTL-${deal.id}`);
    });

    test('the audit trail shows who approved what, in order', async () => {
      const { job } = await approved();
      await drain();
      const names = (await events(job.id)).map((e) => e.event);
      assert.deepEqual(names, ['created', 'approved', 'claimed', 'created', 'created', 'done']);
      assert.equal((await events(job.id))[1].detail?.by, 'Test');
    });

    test('two deals for one contact share one customer', async () => {
      const contact = await hubspot.upsertContactByEmail('s@cedar.example.com', { firstname: 'S', company: 'Shared' });
      for (const name of ['one', 'two']) {
        const deal = await hubspot.createDeal({ dealname: name, dealstage: 'closedwon', pipeline: 'default', amount: '100', closedate: '2026-10-30T00:00:00Z' }, contact.id);
        await poll();
        const job = await jobFor(deal.id);
        await approveJob(db, job.id, job.digest, 'Test');
      }
      assert.deepEqual(await drain(), ['done', 'done']);
      const state = await qbState();
      assert.equal(state.customers.filter((c) => c.DisplayName.startsWith('Shared')).length, 1);
      assert.equal(state.invoices.length, 2);
    });

    test('a deal edited after it was invoiced changes nothing, and a person hears about it once', async () => {
      const { deal, job } = await approved();
      await drain();
      await hubspot.updateDeal(deal.id, { amount: '1' });
      await poll();
      await poll();
      const after = await jobFor(deal.id);
      assert.equal(after.status, 'done');
      assert.equal(after.payload.invoice.amount, 12500);
      assert.equal((await alertKinds()).filter((k) => k === 'deal_changed_after_start').length, 1);
      assert.equal((await qbState()).invoices.length, 1);
      assert.ok(job);
    });

    test('its own write-back to the deal does not look like an edit', async () => {
      const { deal } = await approved();
      await drain();
      await poll();
      assert.equal((await jobFor(deal.id)).status, 'done');
      assert.deepEqual(await alertKinds(), []);
    });
  });

  describe('failures', () => {
    for (const [name, mode] of [['replay', 'replay'], ['ignored', 'ignored'], ['duplicate_error', 'duplicate_error']] as const) {
      test(`requestid ${name}: a lost invoice response leaves one invoice`, async () => {
        await qbConfig({ requestid: { customer: mode, invoice: mode } });
        await approved();
        await addFault(qbSim, { match: { method: 'POST', path: '/invoice$' }, action: 'drop', commit: true });
        assert.deepEqual(await drain(), ['retry', 'done']);
        assert.equal((await qbState()).invoices.length, 1);
      });

      test(`requestid ${name}: a lost customer response leaves one customer`, async () => {
        await qbConfig({ requestid: { customer: mode, invoice: mode } });
        await approved();
        await addFault(qbSim, { match: { method: 'POST', path: '/customer$' }, action: 'drop', commit: true });
        assert.deepEqual(await drain(), ['retry', 'done']);
        assert.equal((await qbState()).customers.length, 2);
      });
    }

    test('a second attempt finds what the first one wrote, and says so', async () => {
      const { job } = await approved();
      await addFault(qbSim, { match: { method: 'POST', path: '/invoice$' }, action: 'drop', commit: true });
      await drain();
      const names = (await events(job.id)).map((e) => e.event);
      assert.ok(names.includes('unknown_outcome_resolving'));
      assert.ok(names.includes('found_existing'));
      const call = await db.query("select * from external_calls where call = 'qb.create_invoice'");
      assert.equal(call.rows[0].confirmed_by, 'lookup');
      assert.equal(call.rows[0].status, 'confirmed');
    });

    test('QuickBooks says the name exists but no search can find it: a person decides', async () => {
      const { job } = await approved();
      const made = await qb.createCustomer(job.payload.customer, 'made-earlier');
      assert.ok(made.ok);
      const blind = Object.create(qb) as QuickBooksClient;
      blind.findCustomerByDisplayName = async () => ({ ok: true, body: [], tid: null });
      deps = { ...deps, qb: blind };
      assert.deepEqual(await drain(), ['needs_person']);
      const after = (await db.query<InvoiceJob>('select * from invoice_jobs where id = $1', [job.id])).rows[0];
      assert.match(String(after.problem), /duplicate_name/);
      assert.ok((await alertKinds()).includes('job_needs_person'));
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('a refusal from QuickBooks goes to a person and writes nothing more', async () => {
      await approved();
      await addFault(qbSim, { match: { method: 'POST', path: '/invoice$' }, action: 'status', status: 400 });
      assert.deepEqual(await drain(), ['needs_person']);
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('an item QuickBooks does not have goes to a person', async () => {
      const { deal } = await wonDeal();
      await pollWonDeals({ db, hubspot }, { wonStage: 'closedwon', itemName: 'Nope', overlapMs: 60_000 });
      const job = await jobFor(deal.id);
      await approveJob(db, job.id, job.digest, 'Test');
      deps = { ...deps, settings: { ...deps.settings, itemName: 'Nope' } };
      assert.deepEqual(await drain(), ['needs_person']);
      assert.match(String((await jobFor(deal.id)).problem), /no item named Nope/);
    });

    test('a dead CRM at the recheck is a retry, not a failure', async () => {
      await approved();
      const job = await claimNext(db, 60);
      const dead = new HubSpotClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', apiVersion: '2026-09', maxAttempts: 1 });
      assert.equal(await processJob({ ...deps, hubspot: dead }, job!), 'retry');
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('giving up after too many attempts goes to a person, with the reason', async () => {
      await approved();
      deps = { ...deps, settings: { ...deps.settings, maxAttempts: 3 } };
      await addFault(qbSim, { match: { method: 'POST', path: '/customer$' }, action: 'status', status: 500, times: 0 });
      const outcomes = await drain();
      assert.deepEqual(outcomes, ['retry', 'retry', 'needs_person']);
      const job = (await db.query<InvoiceJob>('select * from invoice_jobs')).rows[0];
      assert.match(String(job.problem), /gave up after 3 attempts/);
    });

    test('a write-back that fails after the invoice exists does not make a second invoice', async () => {
      await approved();
      await addFault(hubspotSim, { match: { method: 'PATCH' }, action: 'status', status: 500, times: 4 });
      const outcomes = await drain();
      assert.deepEqual(outcomes, ['retry', 'done']);
      assert.equal((await qbState()).invoices.length, 1);
    });

    test('a CRM auth failure stops and asks: a service key cannot refresh itself', async () => {
      await approved();
      await fetch(`${hubspotSim.url()}/__sim/token/expire`, { method: 'POST' });
      assert.deepEqual(await drain(), ['needs_person']);
      assert.equal((await qbState()).invoices.length, 0);
    });

    test('a refused refresh waits for a reconnect, writes nothing, and resumes', async () => {
      const { deal } = await approved();
      await fetch(`${qbSim.url()}/__sim/token/expire`, { method: 'POST' });
      await db.query("update oauth_connections set refresh_token_enc = $1, access_expires_at = now() - interval '1 minute'", [encrypt('revoked', Buffer.alloc(32, 1))]);
      const job = await claimNext(db, 60);
      assert.equal(await processJob(deps, job!), 'blocked');
      assert.equal(await store.status(), 'needs_reconnect');
      assert.deepEqual((await alertKinds()).filter((k) => k === 'quickbooks_reconnect_needed').length, 1);
      assert.equal((await qbState()).invoices.length, 0);
      await assert.rejects(store.accessToken(), ReconnectNeeded);

      await sleep(10);
      const blocked = await claimNext(db, 60);
      assert.equal(await processJob(deps, blocked!), 'blocked');
      assert.equal((await alertKinds()).filter((k) => k === 'quickbooks_reconnect_needed').length, 1, 'one alert, not one per try');

      await connectSimulator(settings, store);
      await sleep(10);
      assert.deepEqual(await drain(), ['done']);
      assert.equal((await jobFor(deal.id)).status, 'done');
    });

    test('a read-back that finds two invoices goes to a person and deletes nothing', async () => {
      const { deal } = await approved();
      const seed = await qb.createCustomer({ DisplayName: 'Seeded [HS 1]' }, 'seed');
      assert.ok(seed.ok);
      await qb.createInvoice(
        { CustomerRef: { value: seed.body.Id }, DocNumber: `LTL-${deal.id}`, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 12500, SalesItemLineDetail: { ItemRef: { value: '1' } } }] },
        'seed-invoice',
      );
      await qb.createInvoice(
        { CustomerRef: { value: seed.body.Id }, DocNumber: `LTL-${deal.id}`, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 12500, SalesItemLineDetail: { ItemRef: { value: '1' } } }] },
        'seed-invoice-2',
      );
      assert.deepEqual(await drain(), ['needs_person']);
      const job = await jobFor(deal.id);
      assert.match(String(job.problem), /duplicate invoices/);
      assert.equal((await qbState()).invoices.length, 2);
    });
  });

  describe('leases', () => {
    test('a live lease keeps other workers off; an expired one lets them in', async () => {
      await approved();
      const first = await claimNext(db, 60);
      assert.ok(first);
      assert.equal(await claimNext(db, 60), null);
      await db.query("update invoice_jobs set lease_expires_at = now() - interval '1 second'");
      const second = await claimNext(db, 60);
      assert.equal(second?.id, first.id);
      assert.notEqual(second?.lease_token, first.lease_token);
    });

    test('ten claims at once: one winner', async () => {
      await approved();
      const claims = await Promise.all(Array.from({ length: 10 }, () => claimNext(db, 60)));
      assert.equal(claims.filter(Boolean).length, 1);
    });

    test('a worker that lost its lease stops, and writes nothing', async () => {
      await approved();
      const stale = await claimNext(db, 60);
      await db.query("update invoice_jobs set lease_expires_at = now() - interval '1 second'");
      const current = await claimNext(db, 60);
      assert.ok(stale && current);
      assert.equal(await processJob(deps, stale), 'lost_lease');
      assert.equal((await qbState()).invoices.length, 0);
      assert.equal(await processJob(deps, current), 'done');
      assert.equal((await qbState()).invoices.length, 1);
    });
  });

  describe('reconcile', () => {
    test('finds a duplicate after the fact, flags the job, and deletes nothing', async () => {
      const { deal, job } = await approved();
      await drain();
      assert.deepEqual(await findDuplicates(db, qb), []);

      const state = await qbState();
      const again = await qb.createInvoice(
        { CustomerRef: { value: state.customers.at(-1)!.Id }, DocNumber: `LTL-${deal.id}`, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 12500, SalesItemLineDetail: { ItemRef: { value: '1' } } }] },
        'late-one',
      );
      assert.ok(again.ok);

      const found = await findDuplicates(db, qb);
      assert.equal(found.length, 1);
      assert.equal(found[0].docNumber, `LTL-${deal.id}`);
      assert.equal(found[0].invoiceIds.length, 2);
      assert.equal((await jobFor(deal.id)).status, 'needs_person');
      assert.equal((await qbState()).invoices.length, 2);

      await findDuplicates(db, qb);
      assert.equal((await alertKinds()).filter((k) => k === 'duplicate_detected').length, 1, 'one alert, not one per sweep');
      assert.ok(job);
    });

    test('does nothing about invoices this repo did not create', async () => {
      await approved();
      await drain();
      const state = await qbState();
      for (const key of ['a', 'b']) {
        await qb.createInvoice(
          { CustomerRef: { value: state.customers[0].Id }, DocNumber: 'OTHER-1', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1, SalesItemLineDetail: { ItemRef: { value: '1' } } }] },
          `other-${key}`,
        );
      }
      assert.deepEqual(await findDuplicates(db, qb), []);
    });
  });

  describe('upsert rules', () => {
    test('a job in progress keeps what was approved', async () => {
      const { deal, job } = await approved();
      await claimNext(db, 60);
      const changed = await upsertJobFromDeal(db, deal.id, { ok: true, payload: { ...job.payload, invoice: { ...job.payload.invoice, amount: 1 } } });
      assert.equal(changed, 'flagged');
      assert.equal((await jobFor(deal.id)).payload.invoice.amount, 12500);
    });
  });
});
