import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { QuickBooksClient } from '../src/quickbooks/client.ts';
import { decrypt, encrypt, ReconnectNeeded, tokenKeyFrom } from '../src/quickbooks/tokens.ts';
import type { TokenSource } from '../src/quickbooks/tokens.ts';
import { createQuickBooksSim } from '../src/simulators/quickbooks.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { addFault, simState, startSim } from './helpers.ts';

const REALM = '9130000000000001';

describe('QuickBooks client', () => {
  let sim: SimServer;
  let access: string;
  let refreshToken: string;
  let refreshes: number;
  let client: QuickBooksClient;

  const basic = `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}`;

  async function tokenRequest(form: Record<string, string>) {
    const res = await fetch(`${sim.url()}/oauth2/v1/tokens/bearer`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return (await res.json()) as { access_token: string; refresh_token: string; error?: string };
  }

  const tokens: TokenSource = {
    accessToken: async () => access,
    refresh: async () => {
      refreshes += 1;
      const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
      if (res.error) throw new ReconnectNeeded(res.error);
      access = res.access_token;
      refreshToken = res.refresh_token;
      return access;
    },
  };

  const customers = async () => (await simState<{ customers: Array<{ DisplayName: string }> }>(sim)).customers;

  before(async () => {
    sim = await startSim(createQuickBooksSim());
  });
  after(async () => {
    await sim.close();
  });
  beforeEach(async () => {
    await fetch(`${sim.url()}/__sim/reset`, { method: 'POST' });
    refreshes = 0;
    const redirect = encodeURIComponent('http://localhost:8765/callback');
    const consent = await fetch(`${sim.url()}/connect/oauth2?client_id=sim-client-id&scope=com.intuit.quickbooks.accounting&redirect_uri=${redirect}&response_type=code&state=s`, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const res = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8765/callback' });
    access = res.access_token;
    refreshToken = res.refresh_token;
    client = new QuickBooksClient({ baseUrl: sim.url(), realmId: async () => REALM, tokens, timeoutMs: 200 });
  });

  describe('success', () => {
    test('creates and finds a customer', async () => {
      const created = await client.createCustomer({ DisplayName: "O'Brien Supply [HS 1]" }, 'key-1');
      assert.ok(created.ok);
      const found = await client.findCustomerByDisplayName("O'Brien Supply [HS 1]");
      assert.ok(found.ok);
      assert.equal(found.body[0].Id, created.body.Id);
    });

    test('a lookup with no match is an empty list', async () => {
      const found = await client.findCustomerByDisplayName('Nobody');
      assert.ok(found.ok);
      assert.deepEqual(found.body, []);
    });

    test('a hidden customer is still found, because it still holds its name', async () => {
      const created = await client.createCustomer({ DisplayName: 'Hidden Co' }, 'key-h');
      assert.ok(created.ok);
      const updated = await fetch(`${sim.url()}/v3/company/${REALM}/customer`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ Id: created.body.Id, SyncToken: '0', sparse: true, Active: false }),
      });
      assert.equal(updated.status, 200);
      const found = await client.findCustomerByDisplayName('Hidden Co');
      assert.ok(found.ok && found.body.length === 1);
    });

    test('finds the seeded item, creates an invoice, and finds it by number and prefix', async () => {
      const item = await client.findItemByName('Services');
      assert.ok(item.ok);
      const customer = await client.createCustomer({ DisplayName: 'Invoice Co' }, 'key-2');
      assert.ok(customer.ok);
      const invoice = await client.createInvoice(
        {
          CustomerRef: { value: customer.body.Id },
          DocNumber: 'LTL-77',
          Line: [{ DetailType: 'SalesItemLineDetail', Amount: 50, SalesItemLineDetail: { ItemRef: { value: item.body[0].Id } } }],
        },
        'key-3',
      );
      assert.ok(invoice.ok);
      assert.equal(invoice.body.DocNumber, 'LTL-77');
      const byNumber = await client.findInvoicesByDocNumber('LTL-77');
      assert.ok(byNumber.ok && byNumber.body.length === 1);
      const byPrefix = await client.findInvoicesByDocPrefix('LTL-');
      assert.ok(byPrefix.ok && byPrefix.body.length === 1);
      assert.ok((await client.getInvoice(invoice.body.Id)).ok);
    });

    test('a test read works', async () => {
      const res = await client.companyName();
      assert.ok(res.ok && res.body.length > 0);
    });

    test('it sends the minor version and asks for JSON', async () => {
      const seen: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(String(input));
        assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
        return original(input, init);
      }) as typeof fetch;
      try {
        await client.findItemByName('Services');
      } finally {
        globalThis.fetch = original;
      }
      assert.match(seen[0], /minorversion=75/);
    });
  });

  describe('what each failure means', () => {
    const create = () => client.createCustomer({ DisplayName: 'Failure Co' }, 'key-f');

    test('a lost response is an unknown outcome, and the write did land', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'drop', commit: true });
      const res = await create();
      assert.ok(!res.ok && res.kind === 'unknown_outcome' && res.status === null);
      assert.equal((await customers()).length, 2);
    });

    test('a timeout is an unknown outcome', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'timeout', commit: true });
      const res = await create();
      assert.ok(!res.ok && res.kind === 'unknown_outcome');
    });

    test('a 500 and an HTML 502 are unknown outcomes, since neither proves nothing landed', async () => {
      for (const status of [500, 502, 503, 504]) {
        await addFault(sim, { match: { path: '/customer$' }, action: 'status', status });
        const res = await create();
        assert.ok(!res.ok && res.kind === 'unknown_outcome', String(status));
      }
    });

    test('a 200 with a Fault in the body is not a success', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'fault200' });
      const res = await create();
      assert.ok(!res.ok && res.kind === 'unknown_outcome');
    });

    test('a 429 is throttled, with Retry-After when given', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'status', status: 429, retryAfterSeconds: 3 });
      const res = await create();
      assert.ok(!res.ok && res.kind === 'throttled' && res.retryAfterMs === 3000);
    });

    test('duplicates are told apart by code', async () => {
      await create();
      const name = await client.createCustomer({ DisplayName: 'Failure Co' }, 'key-other');
      assert.ok(!name.ok && name.kind === 'duplicate_name' && name.code === '6240');

      await fetch(`${sim.url()}/__sim/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestid: { customer: 'duplicate_error' } }) });
      const request = await create();
      assert.ok(!request.ok && request.kind === 'duplicate_request' && request.code === '600');
    });

    test('a validation fault is final', async () => {
      const res = await client.createCustomer({ DisplayName: 'Has: colon' }, 'key-v');
      assert.ok(!res.ok && res.kind === 'validation' && res.code === '2040');
    });

    test('a bad query is a validation fault', async () => {
      const res = await client.findItemByName('x');
      assert.ok(res.ok);
      await addFault(sim, { match: { path: '/query$' }, action: 'status', status: 400 });
      const bad = await client.findItemByName('x');
      assert.ok(!bad.ok && bad.kind === 'validation');
    });

    test('a 403 is forbidden', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'status', status: 403 });
      const res = await create();
      assert.ok(!res.ok && res.kind === 'forbidden');
    });

    test('messages carry no token', async () => {
      await addFault(sim, { match: { path: '/customer$' }, action: 'status', status: 500 });
      const res = await create();
      assert.ok(!res.ok && !JSON.stringify(res).includes(access));
    });
  });

  describe('expired tokens', () => {
    test('a 401 refreshes once and repeats the call', async () => {
      await fetch(`${sim.url()}/__sim/token/expire`, { method: 'POST' });
      const res = await client.createCustomer({ DisplayName: 'Refresh Co' }, 'key-r');
      assert.ok(res.ok);
      assert.equal(refreshes, 1);
      assert.equal((await customers()).filter((c) => c.DisplayName === 'Refresh Co').length, 1);
    });

    test('a refresh token that was revoked raises ReconnectNeeded', async () => {
      await fetch(`${sim.url()}/__sim/token/expire`, { method: 'POST' });
      refreshToken = 'revoked';
      await assert.rejects(client.findItemByName('Services'), ReconnectNeeded);
    });

    test('a second 401 after a refresh is reported, not looped on', async () => {
      await addFault(sim, { match: { path: '/query$' }, action: 'status', status: 401, times: 2 });
      const res = await client.findItemByName('Services');
      assert.ok(!res.ok && res.kind === 'auth');
      assert.equal(refreshes, 1);
    });
  });
});

describe('token encryption', () => {
  const key = Buffer.alloc(32, 5);

  test('round trips', () => {
    assert.equal(decrypt(encrypt('a-token-value', key), key), 'a-token-value');
  });
  test('the sealed value does not contain the token, and differs each time', () => {
    const a = encrypt('a-token-value', key);
    assert.equal(Buffer.from(a, 'base64').toString('utf8').includes('a-token-value'), false);
    assert.notEqual(a, encrypt('a-token-value', key));
  });
  test('a wrong key or a tampered value fails', () => {
    const sealed = encrypt('a-token-value', key);
    assert.throws(() => decrypt(sealed, Buffer.alloc(32, 6)));
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => decrypt(raw.toString('base64'), key));
  });
  test('the key must be 32 bytes', () => {
    assert.throws(() => tokenKeyFrom(undefined));
    assert.throws(() => tokenKeyFrom('c2hvcnQ='));
    assert.equal(tokenKeyFrom(key.toString('base64')).length, 32);
  });
});
