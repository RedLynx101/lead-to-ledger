import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHubSpotSim } from '../src/simulators/hubspot.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { simState, sleep, startSim } from './helpers.ts';

const TOKEN = 'sim-hubspot-token';

describe('HubSpot simulator', () => {
  let sim: SimServer;

  async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
    const res = await fetch(`${sim.url()}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  before(async () => {
    sim = await startSim(createHubSpotSim({ searchLagMs: 0 }));
  });
  after(async () => {
    await sim.close();
  });
  beforeEach(async () => {
    await fetch(`${sim.url()}/__sim/reset`, { method: 'POST' });
  });

  describe('auth', () => {
    test('no token is a 401 INVALID_AUTHENTICATION', async () => {
      const res = await call('GET', '/crm/v3/objects/contacts', undefined, null);
      assert.equal(res.status, 401);
      assert.equal(res.body.category, 'INVALID_AUTHENTICATION');
      assert.ok(res.body.correlationId);
    });
    test('a wrong token is a 401', async () => {
      assert.equal((await call('GET', '/crm/v3/objects/contacts', undefined, 'nope')).status, 401);
    });
    test('an expired token is a 401 EXPIRED_AUTHENTICATION until restored', async () => {
      await fetch(`${sim.url()}/__sim/token/expire`, { method: 'POST' });
      const res = await call('GET', '/crm/v3/objects/contacts');
      assert.equal(res.status, 401);
      assert.equal(res.body.category, 'EXPIRED_AUTHENTICATION');
      await fetch(`${sim.url()}/__sim/token/restore`, { method: 'POST' });
      assert.equal((await call('GET', '/crm/v3/objects/contacts')).status, 200);
    });
  });

  describe('contacts', () => {
    test('create returns 201 with the documented record shape', async () => {
      const res = await call('POST', '/crm/v3/objects/contacts', {
        properties: { email: 'Pat.Lee@sample.example.com', firstname: 'Pat', lastname: 'Lee' },
      });
      assert.equal(res.status, 201);
      assert.match(res.body.id, /^\d+$/);
      assert.equal(res.body.properties.email, 'pat.lee@sample.example.com');
      assert.equal(res.body.properties.hs_object_id, res.body.id);
      assert.ok(res.body.createdAt);
      assert.ok(res.body.updatedAt);
      assert.equal(res.body.archived, false);
    });

    test('a second create with the same email is a 409 CONFLICT naming the existing ID', async () => {
      const first = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'a@sample.example.com' } });
      const second = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'A@sample.example.com' } });
      assert.equal(second.status, 409);
      assert.equal(second.body.category, 'CONFLICT');
      assert.equal(second.body.message, `Contact already exists. Existing ID: ${first.body.id}`);
      const state = await simState<{ contacts: unknown[] }>(sim);
      assert.equal(state.contacts.length, 1);
    });

    test('an unknown property is a 400 PROPERTY_DOESNT_EXIST and nothing is written', async () => {
      const res = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'b@sample.example.com', no_such_prop: 'x' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.category, 'VALIDATION_ERROR');
      assert.equal(res.body.errors[0].code, 'PROPERTY_DOESNT_EXIST');
      assert.equal((await simState<{ contacts: unknown[] }>(sim)).contacts.length, 0);
    });

    test('a read-only property cannot be set', async () => {
      const res = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'c@sample.example.com', createdate: '2020-01-01' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.errors[0].code, 'READ_ONLY_VALUE');
    });

    test('an enumeration value outside its options is rejected', async () => {
      const res = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'd@sample.example.com', lifecyclestage: 'made_up' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.errors[0].code, 'INVALID_OPTION');
    });

    test('read and update by email use idProperty', async () => {
      const created = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'e@sample.example.com', firstname: 'Old' } });
      const read = await call('GET', '/crm/v3/objects/contacts/e@sample.example.com?idProperty=email&properties=firstname,email');
      assert.equal(read.status, 200);
      assert.equal(read.body.id, created.body.id);
      assert.deepEqual(Object.keys(read.body.properties).sort(), ['email', 'firstname']);

      const patched = await call('PATCH', '/crm/v3/objects/contacts/e@sample.example.com?idProperty=email', { properties: { firstname: 'New' } });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.properties.firstname, 'New');
    });

    test('a missing record is a 404', async () => {
      const res = await call('GET', '/crm/v3/objects/contacts/999999');
      assert.equal(res.status, 404);
      assert.equal(res.body.category, 'OBJECT_NOT_FOUND');
    });

    test('defined properties with no value come back null; undefined ones are omitted', async () => {
      await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'f@sample.example.com' } });
      const read = await call('GET', '/crm/v3/objects/contacts/f@sample.example.com?idProperty=email&properties=phone,not_a_property');
      assert.equal(read.body.properties.phone, null);
      assert.equal('not_a_property' in read.body.properties, false);
    });

    test('batch upsert by email creates once, then updates the same record', async () => {
      const input = { inputs: [{ idProperty: 'email', id: 'g@sample.example.com', properties: { firstname: 'One' } }] };
      const first = await call('POST', '/crm/v3/objects/contacts/batch/upsert', input);
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'COMPLETE');
      assert.equal(first.body.results[0].new, true);

      input.inputs[0].properties.firstname = 'Two';
      const second = await call('POST', '/crm/v3/objects/contacts/batch/upsert', input);
      assert.equal(second.body.results[0].new, false);
      assert.equal(second.body.results[0].id, first.body.results[0].id);
      assert.equal((await simState<{ contacts: unknown[] }>(sim)).contacts.length, 1);
    });

    test('batch upsert by email is all or nothing', async () => {
      const res = await call('POST', '/crm/v3/objects/contacts/batch/upsert', {
        inputs: [
          { idProperty: 'email', id: 'ok@sample.example.com', properties: { firstname: 'Fine' } },
          { idProperty: 'email', id: 'bad@sample.example.com', properties: { no_such_prop: 'x' } },
        ],
      });
      assert.equal(res.status, 400);
      assert.equal((await simState<{ contacts: unknown[] }>(sim)).contacts.length, 0);
    });

    test('batch read returns records found and skips the rest', async () => {
      await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'h@sample.example.com' } });
      const res = await call('POST', '/crm/v3/objects/contacts/batch/read', {
        idProperty: 'email',
        properties: ['email'],
        inputs: [{ id: 'h@sample.example.com' }, { id: 'missing@sample.example.com' }],
      });
      assert.equal(res.body.results.length, 1);
    });

    test('an archived contact leaves search and frees its email', async () => {
      const created = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'i@sample.example.com' } });
      assert.equal((await call('DELETE', `/crm/v3/objects/contacts/${created.body.id}`)).status, 204);
      const search = await call('POST', '/crm/v3/objects/contacts/search', {});
      assert.equal(search.body.total, 0);
      assert.equal((await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'i@sample.example.com' } })).status, 201);
    });
  });

  describe('paths', () => {
    test('legacy v3 and date-based paths reach the same records', async () => {
      const created = await call('POST', '/crm/objects/2026-09/contacts', { properties: { email: 'j@sample.example.com' } });
      assert.equal(created.status, 201);
      assert.equal((await call('GET', `/crm/v3/objects/contacts/${created.body.id}`)).status, 200);
      assert.equal((await call('GET', `/crm/objects/2026-03/0-1/${created.body.id}`)).status, 200);
    });
    test('an unknown route is a 404, not a crash', async () => {
      assert.equal((await call('GET', '/crm/v3/objects/tickets')).status, 404);
      assert.equal((await call('GET', '/nope')).status, 404);
    });
  });

  describe('search', () => {
    test('EQ, IN, GT, sort and paging', async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        await call('POST', '/crm/v3/objects/contacts', { properties: { email: `s${n}@sample.example.com`, firstname: n % 2 ? 'odd' : 'even' } });
      }
      const eq = await call('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'firstname', operator: 'EQ', value: 'EVEN' }] }],
      });
      assert.equal(eq.body.total, 2);

      const isIn = await call('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: ['s1@sample.example.com', 's2@sample.example.com'] }] }],
      });
      assert.equal(isIn.body.total, 2);

      const page1 = await call('POST', '/crm/v3/objects/contacts/search', {
        sorts: [{ propertyName: 'email', direction: 'DESCENDING' }],
        properties: ['email'],
        limit: 2,
      });
      assert.equal(page1.body.total, 5);
      assert.deepEqual(page1.body.results.map((r: { properties: { email: string } }) => r.properties.email), ['s5@sample.example.com', 's4@sample.example.com']);
      assert.equal(page1.body.paging.next.after, '2');

      const page3 = await call('POST', '/crm/v3/objects/contacts/search', { limit: 2, after: '4' });
      assert.equal(page3.body.results.length, 1);
      assert.equal(page3.body.paging, undefined);
    });

    test('OR across filter groups, AND within a group', async () => {
      await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'x1@sample.example.com', firstname: 'a', lastname: 'b' } });
      await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'x2@sample.example.com', firstname: 'a', lastname: 'c' } });
      const res = await call('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [
          { filters: [{ propertyName: 'firstname', operator: 'EQ', value: 'a' }, { propertyName: 'lastname', operator: 'EQ', value: 'b' }] },
          { filters: [{ propertyName: 'lastname', operator: 'EQ', value: 'c' }] },
        ],
      });
      assert.equal(res.body.total, 2);
    });

    test('date filters accept epoch milliseconds and ISO strings', async () => {
      const before = Date.now() - 1000;
      await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'k@sample.example.com' } });
      for (const value of [String(before), new Date(before).toISOString()]) {
        const res = await call('POST', '/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value }] }],
        });
        assert.equal(res.body.total, 1);
      }
      const future = await call('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GT', value: String(Date.now() + 60_000) }] }],
      });
      assert.equal(future.body.total, 0);
    });

    test('a limit over 200 and too many filters are 400s', async () => {
      assert.equal((await call('POST', '/crm/v3/objects/contacts/search', { limit: 201 })).status, 400);
      const filters = Array.from({ length: 7 }, () => ({ propertyName: 'email', operator: 'HAS_PROPERTY' }));
      assert.equal((await call('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters }] })).status, 400);
    });

    test('search lags writes, so a committed record can look missing', async () => {
      await fetch(`${sim.url()}/__sim/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchLagMs: 150 }),
      });
      const created = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'lag@sample.example.com' } });
      const filter = { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'lag@sample.example.com' }] }] };

      const tooSoon = await call('POST', '/crm/v3/objects/contacts/search', filter);
      assert.equal(tooSoon.body.total, 0);
      // A direct read is not behind the index.
      assert.equal((await call('GET', `/crm/v3/objects/contacts/${created.body.id}`)).status, 200);

      await sleep(200);
      const later = await call('POST', '/crm/v3/objects/contacts/search', filter);
      assert.equal(later.body.total, 1);
    });
  });

  describe('properties', () => {
    const def = { groupName: 'ai_triage', name: 'ai_category', label: 'AI category', type: 'enumeration', fieldType: 'select', options: [{ label: 'Spam', value: 'spam' }] };

    test('create group, create property, write to it, and validate its options', async () => {
      assert.equal((await call('POST', '/crm/v3/properties/contacts/groups', { name: 'ai_triage', label: 'AI triage' })).status, 201);
      assert.equal((await call('POST', '/crm/v3/properties/contacts', def)).status, 201);
      const ok = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'l@sample.example.com', ai_category: 'spam' } });
      assert.equal(ok.status, 201);
      const bad = await call('PATCH', `/crm/v3/objects/contacts/${ok.body.id}`, { properties: { ai_category: 'other' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.errors[0].code, 'INVALID_OPTION');
    });

    test('creating a property that exists is a 409', async () => {
      await call('POST', '/crm/v3/properties/contacts/groups', { name: 'ai_triage', label: 'AI triage' });
      await call('POST', '/crm/v3/properties/contacts', def);
      const again = await call('POST', '/crm/v3/properties/contacts', def);
      assert.equal(again.status, 409);
      assert.equal(again.body.category, 'OBJECT_ALREADY_EXISTS');
    });

    test('a property needs an existing group and a compatible fieldType', async () => {
      assert.equal((await call('POST', '/crm/v3/properties/contacts', def)).status, 400);
      await call('POST', '/crm/v3/properties/contacts/groups', { name: 'ai_triage', label: 'AI triage' });
      assert.equal((await call('POST', '/crm/v3/properties/contacts', { ...def, fieldType: 'number' })).status, 400);
    });

    test('hasUniqueValue blocks a second record with the same value', async () => {
      const unique = { groupName: 'dealinformation', name: 'ltl_source_key', label: 'Source key', type: 'string', fieldType: 'text', hasUniqueValue: true };
      assert.equal((await call('POST', '/crm/v3/properties/deals', unique)).status, 201);
      const deal = { properties: { dealname: 'One', dealstage: 'closedwon', ltl_source_key: 'abc' } };
      const first = await call('POST', '/crm/v3/objects/deals', deal);
      assert.equal(first.status, 201);
      const second = await call('POST', '/crm/v3/objects/deals', deal);
      assert.equal(second.status, 409);
      assert.equal(second.body.category, 'CONFLICT');
      const byKey = await call('GET', '/crm/v3/objects/deals/abc?idProperty=ltl_source_key');
      assert.equal(byKey.body.id, first.body.id);
    });
  });

  describe('deals', () => {
    test('create with a contact association, then read it back two ways', async () => {
      const contact = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'm@sample.example.com' } });
      const deal = await call('POST', '/crm/v3/objects/deals', {
        properties: { dealname: 'Rooftop units', dealstage: 'contractsent', amount: '12500' },
        associations: [{ to: { id: contact.body.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
      });
      assert.equal(deal.status, 201);
      assert.equal(deal.body.properties.pipeline, 'default');

      const read = await call('GET', `/crm/v3/objects/deals/${deal.body.id}?associations=contacts`);
      assert.equal(read.body.associations.contacts.results[0].id, contact.body.id);
      assert.equal(read.body.associations.contacts.results[0].type, 'deal_to_contact');

      const listed = await call('GET', `/crm/objects/2026-09/deals/${deal.body.id}/associations/contacts`);
      assert.equal(listed.body.results[0].toObjectId, Number(contact.body.id));
      assert.equal(listed.body.results[0].associationTypes[0].typeId, 3);
    });

    test('a default association can be added later', async () => {
      const contact = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'n@sample.example.com' } });
      const deal = await call('POST', '/crm/v3/objects/deals', { properties: { dealname: 'Chiller', dealstage: 'contractsent' } });
      const put = await call('PUT', `/crm/objects/2026-09/deals/${deal.body.id}/associations/default/contacts/${contact.body.id}`);
      assert.equal(put.status, 200);
      const read = await call('GET', `/crm/v3/objects/deals/${deal.body.id}?associations=contacts`);
      assert.equal(read.body.associations.contacts.results.length, 1);
    });

    test('dealname and dealstage are required, and the stage must exist', async () => {
      assert.equal((await call('POST', '/crm/v3/objects/deals', { properties: { dealname: 'x' } })).status, 400);
      assert.equal((await call('POST', '/crm/v3/objects/deals', { properties: { dealname: 'x', dealstage: 'made_up' } })).status, 400);
    });

    test('closed-won deals can be polled with a stage filter and a modified-since cursor', async () => {
      const start = Date.now() - 1000;
      const deal = await call('POST', '/crm/v3/objects/deals', { properties: { dealname: 'Won', dealstage: 'contractsent' } });
      await call('POST', '/crm/v3/objects/deals', { properties: { dealname: 'Open', dealstage: 'contractsent' } });
      await call('PATCH', `/crm/v3/objects/deals/${deal.body.id}`, { properties: { dealstage: 'closedwon' } });
      const res = await call('POST', '/crm/v3/objects/deals/search', {
        filterGroups: [{ filters: [
          { propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' },
          { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(start) },
        ] }],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        properties: ['dealname', 'dealstage', 'amount'],
      });
      assert.equal(res.body.total, 1);
      assert.equal(res.body.results[0].id, deal.body.id);
    });

    test('pipelines list the default stages', async () => {
      const res = await call('GET', '/crm/v3/pipelines/deals');
      const stages = res.body.results[0].stages.map((s: { id: string }) => s.id);
      assert.ok(stages.includes('closedwon'));
      assert.ok(stages.includes('closedlost'));
    });
  });

  describe('rate limits', () => {
    test('search over 5 a second is a 429 with the documented fields and no rate headers', async () => {
      const results = [];
      for (let i = 0; i < 6; i += 1) results.push(await call('POST', '/crm/v3/objects/contacts/search', {}));
      const last = results[5];
      assert.equal(last.status, 429);
      assert.equal(last.body.status, 'error');
      assert.equal(last.body.errorType, 'RATE_LIMIT');
      assert.equal(last.body.policyName, 'SECONDLY');
      assert.ok(last.body.correlationId);
      assert.ok(last.body.requestId);
      assert.equal(results[0].headers.get('x-hubspot-ratelimit-remaining'), null);
    });

    test('general calls carry rate headers and 429 after the window fills', async () => {
      await fetch(`${sim.url()}/__sim/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rateLimitPer10s: 3 }),
      });
      const first = await call('GET', '/crm/v3/objects/contacts');
      assert.equal(first.headers.get('x-hubspot-ratelimit-max'), '3');
      assert.equal(first.headers.get('x-hubspot-ratelimit-remaining'), '2');
      await call('GET', '/crm/v3/objects/contacts');
      await call('GET', '/crm/v3/objects/contacts');
      const over = await call('GET', '/crm/v3/objects/contacts');
      assert.equal(over.status, 429);
      assert.equal(over.body.policyName, 'TEN_SECONDLY_ROLLING');
    });
  });

  test('the write log records which properties each call touched', async () => {
    const created = await call('POST', '/crm/v3/objects/contacts', { properties: { email: 'o@sample.example.com', firstname: 'O' } });
    await call('PATCH', `/crm/v3/objects/contacts/${created.body.id}`, { properties: { lastname: 'P' } });
    const state = await simState<{ writeLog: Array<{ properties: string[] }> }>(sim);
    assert.deepEqual(state.writeLog.map((w) => w.properties), [['email', 'firstname'], ['lastname']]);
  });
});
