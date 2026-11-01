// The failures a real sandbox won't produce on command. The brief requires the
// simulators to time out, drop a response after committing, return 429 and 5xx,
// and expire a token. Each is checked on both simulators, along with whether the
// write actually landed, because that is what the worker has to reason about.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHubSpotSim } from '../src/simulators/hubspot.ts';
import { createQuickBooksSim } from '../src/simulators/quickbooks.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { addFault, simLog, simState, sleep, startSim } from './helpers.ts';

const TOKEN = 'sim-hubspot-token';
const REALM = '9130000000000001';

describe('failure injection', () => {
  let hubspot: SimServer;
  let quickbooks: SimServer;
  let qbToken: string;

  const createContact = (email: string, timeoutMs = 2000) =>
    fetch(`${hubspot.url()}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ properties: { email } }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const createCustomer = (name: string, query = '', timeoutMs = 2000) =>
    fetch(`${quickbooks.url()}/v3/company/${REALM}/customer${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${qbToken}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ DisplayName: name }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const contactCount = async () => (await simState<{ contacts: unknown[] }>(hubspot)).contacts.length;
  // Excludes the seeded sample customer.
  const customerCount = async () => (await simState<{ customers: unknown[] }>(quickbooks)).customers.length - 1;

  before(async () => {
    hubspot = await startSim(createHubSpotSim({ searchLagMs: 0 }));
    quickbooks = await startSim(createQuickBooksSim());
  });
  after(async () => {
    await hubspot.close();
    await quickbooks.close();
  });
  beforeEach(async () => {
    await fetch(`${hubspot.url()}/__sim/reset`, { method: 'POST' });
    await fetch(`${quickbooks.url()}/__sim/reset`, { method: 'POST' });
    const connect = await fetch(
      `${quickbooks.url()}/connect/oauth2?client_id=sim-client-id&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent('http://localhost:8765/callback')}&response_type=code&state=s`,
      { redirect: 'manual' },
    );
    const code = new URL(connect.headers.get('location')!).searchParams.get('code')!;
    const res = await fetch(`${quickbooks.url()}/oauth2/v1/tokens/bearer`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8765/callback' }),
    });
    qbToken = ((await res.json()) as { access_token: string }).access_token;
  });

  describe('response lost after the write committed', () => {
    test('HubSpot: the caller sees a dead socket, but the contact exists', async () => {
      await addFault(hubspot, { match: { method: 'POST', path: '/contacts$' }, action: 'drop', commit: true });
      await assert.rejects(createContact('lost@sample.example.com'));
      assert.equal(await contactCount(), 1);
      const [entry] = await simLog(hubspot);
      assert.equal(entry.status, null);
      assert.equal(entry.committed, true);
      assert.equal(entry.outcome, 'dropped');
    });

    test('HubSpot: a blind retry after the lost response hits the 409', async () => {
      await addFault(hubspot, { match: { method: 'POST', path: '/contacts$' }, action: 'drop', commit: true });
      await assert.rejects(createContact('retry@sample.example.com'));
      const retry = await createContact('retry@sample.example.com');
      assert.equal(retry.status, 409);
      assert.equal(await contactCount(), 1);
    });

    test('QuickBooks: same requestid after a lost response returns the first result', async () => {
      await addFault(quickbooks, { match: { method: 'POST', path: '/customer$' }, action: 'drop', commit: true });
      await assert.rejects(createCustomer('Lost Co', '?requestid=lost-1'));
      assert.equal(await customerCount(), 1);
      const retry = await createCustomer('Lost Co', '?requestid=lost-1');
      assert.equal(retry.status, 200);
      assert.equal(await customerCount(), 1);
      const entries = await simLog(quickbooks);
      assert.equal(entries.at(-1)!.replayed, true);
    });
  });

  describe('dropped before committing', () => {
    test('the caller sees the same dead socket, but nothing was written', async () => {
      await addFault(hubspot, { match: { method: 'POST' }, action: 'drop' });
      await addFault(quickbooks, { match: { method: 'POST', path: '/customer$' }, action: 'drop' });
      await assert.rejects(createContact('never@sample.example.com'));
      await assert.rejects(createCustomer('Never Co'));
      assert.equal(await contactCount(), 0);
      assert.equal(await customerCount(), 0);
    });
  });

  describe('timeouts', () => {
    test('with no commit, the caller times out and nothing was written', async () => {
      await addFault(hubspot, { match: { method: 'POST' }, action: 'timeout' });
      await assert.rejects(createContact('hang@sample.example.com', 150), { name: 'TimeoutError' });
      assert.equal(await contactCount(), 0);
    });

    test('with a commit, the caller times out and the write landed anyway', async () => {
      await addFault(quickbooks, { match: { method: 'POST', path: '/customer$' }, action: 'timeout', commit: true });
      await assert.rejects(createCustomer('Hang Co', '', 150), { name: 'TimeoutError' });
      assert.equal(await customerCount(), 1);
    });
  });

  describe('status codes', () => {
    test('HubSpot 429 and 5xx carry its error shape and write nothing', async () => {
      for (const status of [429, 500]) {
        await addFault(hubspot, { action: 'status', status });
        const res = await createContact(`s${status}@sample.example.com`);
        assert.equal(res.status, status);
        const body = (await res.json()) as { status: string; correlationId: string };
        assert.equal(body.status, 'error');
        assert.ok(body.correlationId);
      }
      assert.equal(await contactCount(), 0);
    });

    test('502, 503 and 504 come back as HTML from both, so a client cannot assume JSON', async () => {
      for (const status of [502, 503, 504]) {
        await addFault(hubspot, { action: 'status', status });
        await addFault(quickbooks, { match: { path: '/customer$' }, action: 'status', status });
        const a = await createContact('html@sample.example.com');
        const b = await createCustomer('Html Co');
        assert.equal(a.status, status);
        assert.equal(b.status, status);
        assert.match(a.headers.get('content-type')!, /html/);
        assert.match(b.headers.get('content-type')!, /html/);
      }
    });

    test('QuickBooks 429 and 500 carry Fault bodies', async () => {
      await addFault(quickbooks, { match: { path: '/customer$' }, action: 'status', status: 429, retryAfterSeconds: 7 });
      const limited = await createCustomer('Busy Co');
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '7');
      assert.equal(((await limited.json()) as { Fault: { type: string } }).Fault.type, 'ThrottleExceeded');

      await addFault(quickbooks, { match: { path: '/customer$' }, action: 'status', status: 500 });
      const failed = await createCustomer('Broken Co');
      assert.equal(failed.status, 500);
      assert.equal(((await failed.json()) as { Fault: { type: string } }).Fault.type, 'SystemFault');
    });

    test('a 5xx can arrive after the write committed', async () => {
      await addFault(hubspot, { action: 'status', status: 504, commit: true });
      const res = await createContact('late@sample.example.com');
      assert.equal(res.status, 504);
      assert.equal(await contactCount(), 1);
    });

    test('QuickBooks can answer 200 with a Fault in the body', async () => {
      await addFault(quickbooks, { match: { path: '/customer$' }, action: 'fault200' });
      const res = await createCustomer('Sneaky Co');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { Fault?: { type: string }; Customer?: unknown };
      assert.equal(body.Fault?.type, 'SystemFault');
      assert.equal(body.Customer, undefined);
      assert.equal(await customerCount(), 0);
    });

    test('a missing-scope 403 and a locked 423 have HubSpot categories', async () => {
      await addFault(hubspot, { action: 'status', status: 403 });
      assert.equal(((await (await createContact('a@sample.example.com')).json()) as { category: string }).category, 'MISSING_SCOPES');
      await addFault(hubspot, { action: 'status', status: 423 });
      assert.equal((await createContact('a@sample.example.com')).status, 423);
    });
  });

  describe('expired tokens', () => {
    test('expire_token makes this call and later ones fail until restored', async () => {
      await addFault(hubspot, { match: { method: 'POST' }, action: 'expire_token' });
      assert.equal((await createContact('a@sample.example.com')).status, 401);
      assert.equal((await createContact('a@sample.example.com')).status, 401);
      await fetch(`${hubspot.url()}/__sim/token/restore`, { method: 'POST' });
      assert.equal((await createContact('a@sample.example.com')).status, 201);
    });

    test('QuickBooks gives a 401 mid-flow', async () => {
      await addFault(quickbooks, { match: { path: '/customer$' }, action: 'expire_token' });
      assert.equal((await createCustomer('Expired Co')).status, 401);
    });
  });

  describe('hold: a window to kill the caller mid-call', () => {
    test('wait reports when the request reaches the simulator', async () => {
      const id = await addFault(hubspot, { match: { method: 'POST' }, action: 'hold', holdMs: 150 });
      const waiting = fetch(`${hubspot.url()}/__sim/faults/${id}/wait?timeoutMs=2000`).then((r) => r.json()) as Promise<{ hit: boolean }>;
      const call = createContact('held@sample.example.com');
      assert.equal((await waiting).hit, true);
      assert.equal((await call).status, 201);
    });

    test('the write still commits if the caller dies during the hold', async () => {
      const id = await addFault(hubspot, { match: { method: 'POST' }, action: 'hold', holdMs: 150 });
      const controller = new AbortController();
      const call = fetch(`${hubspot.url()}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ properties: { email: 'died@sample.example.com' } }),
        signal: controller.signal,
      });
      await fetch(`${hubspot.url()}/__sim/faults/${id}/wait?timeoutMs=2000`);
      controller.abort();
      await assert.rejects(call);
      assert.equal(await contactCount(), 0);
      await sleep(250);
      assert.equal(await contactCount(), 1);
      const [entry] = await simLog(hubspot);
      assert.equal(entry.outcome, 'client_gone');
      assert.equal(entry.committed, true);
    });

    test('with commit false, the write is abandoned if the caller dies', async () => {
      const id = await addFault(hubspot, { match: { method: 'POST' }, action: 'hold', holdMs: 150, commit: false });
      const controller = new AbortController();
      const call = fetch(`${hubspot.url()}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ properties: { email: 'abandon@sample.example.com' } }),
        signal: controller.signal,
      });
      await fetch(`${hubspot.url()}/__sim/faults/${id}/wait?timeoutMs=2000`);
      controller.abort();
      await assert.rejects(call);
      await sleep(250);
      assert.equal(await contactCount(), 0);
    });

    test('wait returns hit:false if nothing arrives in time', async () => {
      const id = await addFault(hubspot, { match: { method: 'POST' }, action: 'hold' });
      const res = (await (await fetch(`${hubspot.url()}/__sim/faults/${id}/wait?timeoutMs=50`)).json()) as { hit: boolean };
      assert.equal(res.hit, false);
    });
  });

  describe('fault scheduling', () => {
    test('skip lets early requests through; times limits how many fail', async () => {
      await addFault(hubspot, { match: { method: 'POST' }, action: 'status', status: 500, skip: 1, times: 2 });
      assert.equal((await createContact('a@sample.example.com')).status, 201);
      assert.equal((await createContact('b@sample.example.com')).status, 500);
      assert.equal((await createContact('c@sample.example.com')).status, 500);
      assert.equal((await createContact('d@sample.example.com')).status, 201);
    });

    test('times 0 applies to every matching request', async () => {
      await addFault(hubspot, { match: { method: 'POST' }, action: 'status', status: 503, times: 0 });
      for (let i = 0; i < 3; i += 1) assert.equal((await createContact(`t${i}@sample.example.com`)).status, 503);
    });

    test('a fault can match one requestid', async () => {
      await addFault(quickbooks, { match: { requestid: 'only-this' }, action: 'status', status: 500 });
      assert.equal((await createCustomer('Other', '?requestid=not-this')).status, 200);
      assert.equal((await createCustomer('This', '?requestid=only-this')).status, 500);
    });

    test('control routes are not affected by faults', async () => {
      await addFault(hubspot, { action: 'status', status: 500, times: 0 });
      assert.equal((await fetch(`${hubspot.url()}/__sim/health`)).status, 200);
    });

    test('reset clears faults and the log', async () => {
      await addFault(hubspot, { action: 'status', status: 500, times: 0 });
      await createContact('a@sample.example.com');
      await fetch(`${hubspot.url()}/__sim/reset`, { method: 'POST' });
      assert.equal((await simLog(hubspot)).length, 0);
      assert.equal((await createContact('a@sample.example.com')).status, 201);
    });

    test('the log never contains credentials', async () => {
      await createContact('a@sample.example.com');
      const text = JSON.stringify(await simLog(hubspot));
      assert.equal(text.includes(TOKEN), false);
    });
  });
});
