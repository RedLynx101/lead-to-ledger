import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createQuickBooksSim } from '../src/simulators/quickbooks.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { simState, startSim } from './helpers.ts';

const CLIENT = 'sim-client-id';
const SECRET = 'sim-client-secret';
const REDIRECT = 'http://localhost:8765/callback';
const REALM = '9130000000000001';

describe('QuickBooks simulator', () => {
  let sim: SimServer;
  let accessToken: string;
  let refreshToken: string;

  const basic = () => `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`;

  async function connect(): Promise<{ code: string; state: string; realmId: string }> {
    const url = new URL(`${sim.url()}/connect/oauth2`);
    url.search = new URLSearchParams({
      client_id: CLIENT,
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 'csrf123',
    }).toString();
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location')!);
    return {
      code: location.searchParams.get('code')!,
      state: location.searchParams.get('state')!,
      realmId: location.searchParams.get('realmId')!,
    };
  }

  async function token(form: Record<string, string>, auth = basic()) {
    const res = await fetch(`${sim.url()}/oauth2/v1/tokens/bearer`, {
      method: 'POST',
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function api(method: string, path: string, body?: unknown, tokenValue: string | null = accessToken) {
    const res = await fetch(`${sim.url()}/v3/company/${REALM}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  const query = (statement: string) => api('GET', `/query?query=${encodeURIComponent(statement)}&minorversion=75`);

  async function configure(patch: unknown) {
    await fetch(`${sim.url()}/__sim/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  const invoiceBody = (customerId: string, extra: Record<string, unknown> = {}) => ({
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: '1', name: 'Services' } } }],
    CustomerRef: { value: customerId },
    ...extra,
  });

  before(async () => {
    sim = await startSim(createQuickBooksSim());
  });
  after(async () => {
    await sim.close();
  });
  beforeEach(async () => {
    await fetch(`${sim.url()}/__sim/reset`, { method: 'POST' });
    const { code } = await connect();
    const res = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    accessToken = res.body.access_token as string;
    refreshToken = res.body.refresh_token as string;
  });

  describe('OAuth 2.0', () => {
    test('connect redirects with code, state and realmId', async () => {
      const { code, state, realmId } = await connect();
      assert.ok(code);
      assert.equal(state, 'csrf123');
      assert.equal(realmId, REALM);
    });

    test('a redirect URI that is not registered is refused', async () => {
      const url = `${sim.url()}/connect/oauth2?client_id=${CLIENT}&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent('http://localhost:1/x')}&response_type=code&state=s`;
      const res = await fetch(url, { redirect: 'manual' });
      assert.equal(res.status, 400);
    });

    test('state is required', async () => {
      const url = `${sim.url()}/connect/oauth2?client_id=${CLIENT}&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;
      assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
    });

    test('the token response has the documented fields', async () => {
      const { code } = await connect();
      const res = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
      assert.equal(res.status, 200);
      assert.equal(res.body.token_type, 'bearer');
      assert.equal(res.body.expires_in, 3600);
      assert.equal(res.body.x_refresh_token_expires_in, 8640000);
      assert.ok(res.body.access_token);
      assert.ok(res.body.refresh_token);
    });

    test('a code works once; reusing it is invalid_grant and revokes what it issued', async () => {
      const { code } = await connect();
      const first = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
      assert.equal(first.status, 200);
      const second = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
      assert.equal(second.status, 400);
      assert.equal(second.body.error, 'invalid_grant');
      const refresh = await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string });
      assert.equal(refresh.body.error, 'invalid_grant');
    });

    test('wrong client credentials are invalid_client', async () => {
      const res = await token({ grant_type: 'refresh_token', refresh_token: refreshToken }, `Basic ${Buffer.from('x:y').toString('base64')}`);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    test('refresh rotates the token; the old value is invalid_grant', async () => {
      const first = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      assert.equal(first.status, 200);
      assert.notEqual(first.body.refresh_token, refreshToken);
      const replay = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      assert.equal(replay.status, 400);
      assert.equal(replay.body.error, 'invalid_grant');
    });

    test('after_24h rotation keeps the value within the day', async () => {
      await configure({ refreshRotation: 'after_24h' });
      const first = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      assert.equal(first.body.refresh_token, refreshToken);
    });

    test('an API call with no token or an expired one is a 401; refresh recovers', async () => {
      assert.equal((await api('GET', '/item/1', undefined, null)).status, 401);
      await fetch(`${sim.url()}/__sim/token/expire`, { method: 'POST' });
      const expired = await api('GET', '/item/1');
      assert.equal(expired.status, 401);
      assert.equal(expired.body.fault.error[0].code, '3200');
      const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      assert.equal((await api('GET', '/item/1', undefined, refreshed.body.access_token as string)).status, 200);
    });

    test('a token ages out after its lifetime', async () => {
      await configure({ accessTokenTtlSeconds: -1 });
      const res = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      assert.equal((await api('GET', '/item/1', undefined, res.body.access_token as string)).status, 401);
    });

    test('the wrong realm is refused', async () => {
      const res = await fetch(`${sim.url()}/v3/company/111/item/1`, {
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      });
      assert.equal(res.status, 403);
    });

    test('revoke kills a token', async () => {
      const res = await fetch(`${sim.url()}/v2/oauth2/tokens/revoke`, {
        method: 'POST',
        headers: { authorization: basic(), accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ token: refreshToken }),
      });
      assert.equal(res.status, 200);
      assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refreshToken })).body.error, 'invalid_grant');
    });
  });

  describe('Accept header', () => {
    test('without Accept: application/json the API answers XML', async () => {
      const res = await fetch(`${sim.url()}/v3/company/${REALM}/item/1`, { headers: { authorization: `Bearer ${accessToken}` } });
      assert.match(res.headers.get('content-type')!, /xml/);
      assert.match(await res.text(), /^<IntuitResponse/);
    });
    test('JSON responses carry an intuit_tid header', async () => {
      assert.match((await api('GET', '/item/1')).headers.get('intuit_tid')!, /^sim-/);
    });
  });

  describe('customers', () => {
    test('create returns the documented shape with Id and SyncToken as strings', async () => {
      const res = await api('POST', '/customer?minorversion=75', {
        DisplayName: 'Sample Holdings',
        PrimaryEmailAddr: { Address: 'billing@sample.example.com' },
        CompanyName: 'Sample Holdings',
      });
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.Customer.Id, 'string');
      assert.equal(res.body.Customer.SyncToken, '0');
      assert.equal(res.body.Customer.domain, 'QBO');
      assert.equal(res.body.Customer.Active, true);
      assert.ok(res.body.Customer.MetaData.CreateTime);
      assert.ok(res.body.time);
    });

    test('a duplicate DisplayName is Fault 6240, ignoring case', async () => {
      const first = await api('POST', '/customer', { DisplayName: 'Dup Co' });
      const second = await api('POST', '/customer', { DisplayName: 'dup co' });
      assert.equal(second.status, 400);
      assert.equal(second.body.Fault.type, 'ValidationFault');
      assert.equal(second.body.Fault.Error[0].code, '6240');
      assert.match(second.body.Fault.Error[0].Detail, new RegExp(first.body.Customer.Id));
    });

    test('a colon, tab or newline in a name is refused', async () => {
      for (const DisplayName of ['Has: colon', 'Has\ttab', 'Has\nline']) {
        const res = await api('POST', '/customer', { DisplayName });
        assert.equal(res.status, 400);
        assert.equal(res.body.Fault.Error[0].code, '2040');
      }
    });

    test('a name can come from its parts; no name at all is Fault 6080', async () => {
      const built = await api('POST', '/customer', { GivenName: 'Pat', FamilyName: 'Lee' });
      assert.equal(built.body.Customer.DisplayName, 'Pat Lee');
      const none = await api('POST', '/customer', {});
      assert.equal(none.body.Fault.Error[0].code, '6080');
    });

    test('an email with no @ or dot is Fault 2210', async () => {
      const res = await api('POST', '/customer', { DisplayName: 'Bad Email', PrimaryEmailAddr: { Address: 'nope' } });
      assert.equal(res.body.Fault.Error[0].code, '2210');
    });

    test('sparse update needs the current SyncToken', async () => {
      const created = await api('POST', '/customer', { DisplayName: 'Stale Co' });
      const { Id } = created.body.Customer;
      const ok = await api('POST', '/customer', { Id, SyncToken: '0', sparse: true, CompanyName: 'New Name' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.Customer.SyncToken, '1');
      const stale = await api('POST', '/customer', { Id, SyncToken: '0', sparse: true, CompanyName: 'Older' });
      assert.equal(stale.body.Fault.Error[0].code, '5010');
    });

    test('a missing customer is Fault 610', async () => {
      const res = await api('GET', '/customer/9999');
      assert.equal(res.status, 400);
      assert.equal(res.body.Fault.Error[0].code, '610');
    });
  });

  describe('invoices', () => {
    let customerId: string;
    beforeEach(async () => {
      customerId = (await api('POST', '/customer', { DisplayName: 'Invoice Co' })).body.Customer.Id;
    });

    test('the documented minimum creates an invoice with totals and dates filled in', async () => {
      const res = await api('POST', '/invoice?minorversion=75', invoiceBody(customerId, { TxnDate: '2026-07-24' }));
      assert.equal(res.status, 200);
      const inv = res.body.Invoice;
      assert.equal(inv.TotalAmt, 100);
      assert.equal(inv.Balance, 100);
      assert.equal(inv.DueDate, '2026-08-23');
      assert.equal(inv.CustomerRef.name, 'Invoice Co');
      assert.equal(inv.Line[0].SalesItemLineDetail.ItemRef.name, 'Services');
      assert.equal(inv.Line[1].DetailType, 'SubTotalLineDetail');
      assert.match(inv.DocNumber, /^\d+$/);
    });

    test('the customer balance moves with the invoice', async () => {
      await api('POST', '/invoice', invoiceBody(customerId));
      assert.equal((await api('GET', `/customer/${customerId}`)).body.Customer.Balance, 100);
    });

    test('with custom numbers on and no DocNumber, the number stays empty', async () => {
      await configure({ customTxnNumbers: true });
      const res = await api('POST', '/invoice', invoiceBody(customerId));
      assert.equal(res.body.Invoice.DocNumber, undefined);
      assert.equal((await api('GET', '/preferences')).body.Preferences.SalesFormsPrefs.CustomTxnNumbers, true);
    });

    test('a supplied DocNumber is kept; over 21 characters is Fault 2050', async () => {
      const ok = await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'LTL-0001' }));
      assert.equal(ok.body.Invoice.DocNumber, 'LTL-0001');
      const long = await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'x'.repeat(22) }));
      assert.equal(long.body.Fault.Error[0].code, '2050');
    });

    test('by default DocNumber does not stop a duplicate', async () => {
      await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'LTL-0002' }));
      const second = await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'LTL-0002' }));
      assert.equal(second.status, 200);
      assert.equal((await simState<{ invoices: unknown[] }>(sim)).invoices.length, 2);
    });

    test('with the duplicate check on, the repeat is Fault 6140 unless allowduplicatedocnum is sent', async () => {
      await configure({ rejectDuplicateDocNum: true });
      await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'LTL-0003' }));
      const refused = await api('POST', '/invoice', invoiceBody(customerId, { DocNumber: 'LTL-0003' }));
      assert.equal(refused.body.Fault.Error[0].code, '6140');
      const allowed = await api('POST', '/invoice?include=allowduplicatedocnum', invoiceBody(customerId, { DocNumber: 'LTL-0003' }));
      assert.equal(allowed.status, 200);
    });

    test('missing and invalid references are faults', async () => {
      assert.equal((await api('POST', '/invoice', { Line: [] })).body.Fault.Error[0].code, '2020');
      assert.equal((await api('POST', '/invoice', invoiceBody('9999'))).body.Fault.Error[0].code, '2500');
      assert.equal((await api('POST', '/invoice', { CustomerRef: { value: customerId } })).body.Fault.Error[0].code, '2020');
      const badItem = invoiceBody(customerId);
      badItem.Line[0].SalesItemLineDetail.ItemRef.value = '9999';
      assert.equal((await api('POST', '/invoice', badItem)).body.Fault.Error[0].code, '2500');
    });

    test('an amount that disagrees with Qty * UnitPrice is Fault 6070; a negative one is 2290', async () => {
      const wrong = await api('POST', '/invoice', {
        CustomerRef: { value: customerId },
        Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 2, UnitPrice: 40 } }],
      });
      assert.equal(wrong.body.Fault.Error[0].code, '6070');
      const negative = await api('POST', '/invoice', {
        CustomerRef: { value: customerId },
        Line: [{ DetailType: 'SalesItemLineDetail', Amount: -5, SalesItemLineDetail: { ItemRef: { value: '1' } } }],
      });
      assert.equal(negative.body.Fault.Error[0].code, '2290');
    });
  });

  describe('requestid', () => {
    let customerId: string;
    beforeEach(async () => {
      customerId = (await api('POST', '/customer', { DisplayName: 'Keyed Co' })).body.Customer.Id;
    });

    test('replay mode: the same key returns the first response and writes nothing', async () => {
      const first = await api('POST', '/invoice?requestid=key-1', invoiceBody(customerId));
      const second = await api('POST', '/invoice?requestid=key-1', invoiceBody(customerId));
      assert.equal(second.status, 200);
      assert.equal(second.body.Invoice.Id, first.body.Invoice.Id);
      const state = await simState<{ invoices: unknown[]; requestIdHits: number }>(sim);
      assert.equal(state.invoices.length, 1);
      assert.equal(state.requestIdHits, 1);
    });

    test('duplicate_error mode: the repeat is Fault 600', async () => {
      await configure({ requestid: { invoice: 'duplicate_error' } });
      await api('POST', '/invoice?requestid=key-2', invoiceBody(customerId));
      const second = await api('POST', '/invoice?requestid=key-2', invoiceBody(customerId));
      assert.equal(second.status, 400);
      assert.equal(second.body.Fault.Error[0].code, '600');
    });

    test('ignored mode: the repeat creates a second invoice', async () => {
      await configure({ requestid: { invoice: 'ignored' } });
      await api('POST', '/invoice?requestid=key-3', invoiceBody(customerId));
      await api('POST', '/invoice?requestid=key-3', invoiceBody(customerId));
      assert.equal((await simState<{ invoices: unknown[] }>(sim)).invoices.length, 2);
    });

    test('modes are set per record type', async () => {
      await configure({ requestid: { customer: 'ignored', invoice: 'replay' } });
      await api('POST', '/customer?requestid=c-1', { DisplayName: 'Per Type' });
      const again = await api('POST', '/customer?requestid=c-1', { DisplayName: 'Per Type' });
      // Ignored, so the second attempt reaches the duplicate-name check.
      assert.equal(again.body.Fault.Error[0].code, '6240');
    });

    test('a failed attempt is not remembered, so a fixed retry goes through', async () => {
      const bad = await api('POST', '/invoice?requestid=key-4', { CustomerRef: { value: customerId } });
      assert.equal(bad.status, 400);
      const good = await api('POST', '/invoice?requestid=key-4', invoiceBody(customerId));
      assert.equal(good.status, 200);
    });

    test('a key over 50 characters is Fault 2130', async () => {
      const res = await api('POST', `/invoice?requestid=${'k'.repeat(51)}`, invoiceBody(customerId));
      assert.equal(res.body.Fault.Error[0].code, '2130');
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      const a = await api('POST', '/customer', { DisplayName: "O'Brien Supply", PrimaryEmailAddr: { Address: 'a@sample.example.com' } });
      await api('POST', '/customer', { DisplayName: 'Other Co' });
      await api('POST', '/invoice', invoiceBody(a.body.Customer.Id, { DocNumber: 'LTL-Q1' }));
    });

    test('a query lag hides a new record from queries, but not from a read by ID', async () => {
      await configure({ queryLagMs: 60_000 });
      const made = await api('POST', '/customer', { DisplayName: 'Lagging Co' });
      assert.equal(made.status, 200);
      assert.deepEqual((await query("SELECT * FROM Customer WHERE DisplayName = 'Lagging Co'")).body.QueryResponse, {});
      assert.equal((await api('GET', `/customer/${made.body.Customer.Id}`)).status, 200);
      // The name is still taken, even though a query can't see it yet.
      assert.equal((await api('POST', '/customer', { DisplayName: 'Lagging Co' })).body.Fault.Error[0].code, '6240');
    });

    test('find an invoice by DocNumber', async () => {
      const res = await query("SELECT * FROM Invoice WHERE DocNumber = 'LTL-Q1'");
      assert.equal(res.body.QueryResponse.Invoice.length, 1);
      assert.equal(res.body.QueryResponse.startPosition, 1);
      assert.equal(res.body.QueryResponse.maxResults, 1);
    });

    test('no match returns an empty QueryResponse, not an error', async () => {
      const res = await query("SELECT * FROM Invoice WHERE DocNumber = 'LTL-NOPE'");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.QueryResponse, {});
    });

    test('keywords, entity and values ignore case, and quotes escape with a backslash', async () => {
      const res = await query("select * from cUsToMeR where displayname = 'o\\'brien supply'");
      assert.equal(res.body.QueryResponse.Customer.length, 1);
    });

    test('LIKE, IN, count, order and paging', async () => {
      assert.equal((await query("SELECT * FROM Customer WHERE DisplayName LIKE 'O%'")).body.QueryResponse.Customer.length, 2);
      assert.equal((await query("SELECT * FROM Customer WHERE DisplayName IN ('Other Co', 'Nobody')")).body.QueryResponse.Customer.length, 1);
      assert.equal((await query('SELECT COUNT(*) FROM Customer')).body.QueryResponse.totalCount, 3);
      const page = await query('SELECT * FROM Customer ORDERBY DisplayName DESC STARTPOSITION 2 MAXRESULTS 1');
      assert.equal(page.body.QueryResponse.Customer[0].DisplayName, 'Other Co');
    });

    test('references and nested attributes can be filtered', async () => {
      const customer = (await query("SELECT * FROM Customer WHERE PrimaryEmailAddr = 'a@sample.example.com'")).body.QueryResponse.Customer[0];
      const invoices = await query(`SELECT * FROM Invoice WHERE CustomerRef = '${customer.Id}'`);
      assert.equal(invoices.body.QueryResponse.Invoice.length, 1);
      const byTime = await query("SELECT * FROM Invoice WHERE MetaData.CreateTime >= '2000-01-01'");
      assert.equal(byTime.body.QueryResponse.Invoice.length, 1);
    });

    test('POST with the statement as the body also works', async () => {
      const res = await fetch(`${sim.url()}/v3/company/${REALM}/query`, {
        method: 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'content-type': 'application/text' },
        body: "SELECT * FROM Item WHERE Name = 'Services'",
      });
      const body = (await res.json()) as { QueryResponse: { Item: unknown[] } };
      assert.equal(body.QueryResponse.Item.length, 1);
    });

    test('a bad query is Fault 4000 or 4001', async () => {
      assert.equal((await query('SELECT FROM')).body.Fault.Error[0].code, '4000');
      assert.equal((await query("SELECT * FROM Customer WHERE a = 'b' OR c = 'd'")).body.Fault.Error[0].code, '4000');
      assert.equal((await query('SELECT * FROM Starship')).body.Fault.Error[0].code, '4001');
      assert.equal((await query("SELECT * FROM Customer WHERE a = 'unterminated")).body.Fault.Error[0].code, '4000');
    });
  });

  test('reads for connection checks: companyinfo and preferences', async () => {
    assert.equal((await api('GET', `/companyinfo/${REALM}`)).status, 200);
    assert.equal((await api('GET', '/preferences')).body.Preferences.SalesFormsPrefs.CustomTxnNumbers, false);
  });

  test('the discovery document points at the token endpoints', async () => {
    const res = await fetch(`${sim.url()}/.well-known/openid_sandbox_configuration`);
    const doc = (await res.json()) as Record<string, string>;
    assert.match(doc.token_endpoint, /\/oauth2\/v1\/tokens\/bearer$/);
    assert.match(doc.authorization_endpoint, /\/connect\/oauth2$/);
  });

  test('over the per-minute limit is a 429 ThrottleExceeded', async () => {
    await configure({ rateLimitPerMinute: 2 });
    await api('GET', '/item/1');
    await api('GET', '/item/1');
    const res = await api('GET', '/item/1');
    assert.equal(res.status, 429);
    assert.equal(res.body.Fault.type, 'ThrottleExceeded');
    assert.equal(res.body.Fault.Error[0].code, '3001');
  });

  test('a seeded sample customer exists, so duplicate counts cannot assume an empty company', async () => {
    const res = await query("SELECT * FROM Customer WHERE DisplayName LIKE 'Sample%'");
    assert.equal(res.body.QueryResponse.Customer.length, 1);
  });
});
