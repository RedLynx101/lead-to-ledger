import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertOnlyAiFields, HubSpotClient, HubSpotError } from '../src/hubspot/client.ts';
import { ensureProperties } from '../src/hubspot/properties.ts';
import { contactProperties } from '../src/leads/contact.ts';
import { createHubSpotSim } from '../src/simulators/hubspot.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { addFault, simLog, simState, startSim } from './helpers.ts';

describe('HubSpot client', () => {
  let sim: SimServer;
  let client: HubSpotClient;
  const naps: number[] = [];

  const contacts = async () => (await simState<{ contacts: Array<{ id: string; properties: Record<string, string> }> }>(sim)).contacts;

  before(async () => {
    sim = await startSim(createHubSpotSim({ searchLagMs: 0 }));
  });
  after(async () => {
    await sim.close();
  });
  beforeEach(async () => {
    await fetch(`${sim.url()}/__sim/reset`, { method: 'POST' });
    naps.length = 0;
    client = new HubSpotClient({
      baseUrl: sim.url(),
      token: 'sim-hubspot-token',
      apiVersion: '2026-09',
      timeoutMs: 300,
      sleep: async (ms) => {
        naps.push(ms);
      },
    });
    await ensureProperties(client);
  });

  test('uses dated paths', async () => {
    await client.upsertContactByEmail('a@sample.example.com', { firstname: 'A' });
    const entries = await simLog(sim);
    assert.ok(entries.every((e) => String(e.path).includes('/2026-09/')));
  });

  describe('upsert by email', () => {
    test('creates once, then updates the same contact', async () => {
      const first = await client.upsertContactByEmail('a@sample.example.com', { firstname: 'One' });
      const second = await client.upsertContactByEmail('A@sample.example.com', { firstname: 'Two' });
      assert.equal(first.new, true);
      assert.equal(second.new, false);
      assert.equal(first.id, second.id);
      assert.equal((await contacts()).length, 1);
    });

    test('a lost response is retried and still leaves one contact', async () => {
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'drop', commit: true });
      const contact = await client.upsertContactByEmail('lost@sample.example.com', { firstname: 'L' });
      assert.equal(contact.new, false);
      assert.equal((await contacts()).length, 1);
      assert.equal(naps.length, 1);
    });

    test('a timeout after commit is retried and still leaves one contact', async () => {
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'timeout', commit: true });
      await client.upsertContactByEmail('slow@sample.example.com', { firstname: 'S' });
      assert.equal((await contacts()).length, 1);
    });
  });

  describe('retries', () => {
    test('429 and 5xx are retried, including an HTML gateway page', async () => {
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'status', status: 429 });
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'status', status: 502 });
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'status', status: 500 });
      const contact = await client.upsertContactByEmail('r@sample.example.com', {});
      assert.ok(contact.id);
      assert.equal(naps.length, 3);
    });

    test('Retry-After is honoured when longer than the backoff', async () => {
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'status', status: 429, retryAfterSeconds: 9 });
      await client.upsertContactByEmail('wait@sample.example.com', {});
      assert.equal(naps[0], 9000);
    });

    test('it gives up after the attempt limit and reports what happened', async () => {
      await addFault(sim, { match: { path: 'batch/upsert' }, action: 'status', status: 500, times: 0 });
      await assert.rejects(client.upsertContactByEmail('gone@sample.example.com', {}), (error: HubSpotError) => {
        assert.equal(error.status, 500);
        assert.equal(error.retryable, true);
        return true;
      });
      assert.equal(naps.length, 3);
    });

    test('a 400 is not retried', async () => {
      await assert.rejects(client.upsertContactByEmail('bad@sample.example.com', { no_such_property: 'x' }), (error: HubSpotError) => {
        assert.equal(error.status, 400);
        assert.equal(error.category, 'VALIDATION_ERROR');
        return true;
      });
      assert.equal(naps.length, 0);
    });

    test('a 401 is not retried: a service key cannot refresh itself', async () => {
      await fetch(`${sim.url()}/__sim/token/expire`, { method: 'POST' });
      await assert.rejects(client.upsertContactByEmail('a@sample.example.com', {}), (error: HubSpotError) => {
        assert.equal(error.status, 401);
        assert.equal(error.category, 'EXPIRED_AUTHENTICATION');
        assert.equal(error.retryable, false);
        return true;
      });
      assert.equal(naps.length, 0);
    });

    test('error messages carry no token', async () => {
      await addFault(sim, { action: 'status', status: 500, times: 0 });
      await assert.rejects(client.upsertContactByEmail('a@sample.example.com', {}), (error: Error) => {
        assert.equal(`${error.message} ${error.stack}`.includes('sim-hubspot-token'), false);
        return true;
      });
    });
  });

  describe('the ai_ guard', () => {
    test('writeAiFields writes ai_ fields by email', async () => {
      await client.upsertContactByEmail('g@sample.example.com', { firstname: 'G' });
      await client.writeAiFields('g@sample.example.com', { ai_category: 'spam', ai_priority: 'low', ai_needs_review: false, ai_confidence: 0.5 });
      const [contact] = await contacts();
      assert.equal(contact.properties.ai_category, 'spam');
      assert.equal(contact.properties.ai_needs_review, 'false');
      assert.equal(contact.properties.ai_confidence, '0.5');
      assert.equal(contact.properties.firstname, 'G');
    });

    test('writeAiFields refuses anything else, before sending', async () => {
      await client.upsertContactByEmail('h@sample.example.com', {});
      const before = (await simLog(sim)).length;
      for (const name of ['lifecyclestage', 'hs_lead_status', 'hubspot_owner_id', 'email', 'firstname', 'phone', 'ai_made_up']) {
        await assert.rejects(client.writeAiFields('h@sample.example.com', { [name]: 'x' } as never), /refusing to write/);
      }
      assert.equal((await simLog(sim)).length, before);
    });

    test('assertOnlyAiFields names the offending property', () => {
      assert.throws(() => assertOnlyAiFields({ ai_category: 'x', lifecyclestage: 'customer' }), /lifecyclestage/);
    });

    test('writing to a contact that does not exist is a 404', async () => {
      await assert.rejects(client.writeAiFields('none@sample.example.com', { ai_needs_review: true }), (error: HubSpotError) => error.status === 404);
    });
  });

  describe('reads', () => {
    test('getContactByEmail finds a contact, or returns null', async () => {
      await client.upsertContactByEmail('r@sample.example.com', { firstname: 'R' });
      const found = await client.getContactByEmail('r@sample.example.com', ['firstname']);
      assert.equal(found?.properties.firstname, 'R');
      assert.equal(await client.getContactByEmail('none@sample.example.com'), null);
    });
  });

  describe('property setup', () => {
    test('is safe to run twice', async () => {
      const again = await ensureProperties(client);
      assert.ok(Object.values(again).every((v) => v === 'exists'));
    });

    test('the ai_ fields accept what decide.ts produces', async () => {
      await client.upsertContactByEmail('p@sample.example.com', {});
      await client.writeAiFields('p@sample.example.com', {
        ai_category: 'sales_ready',
        ai_priority: 'high',
        ai_summary: 'A summary.',
        ai_confidence: 0.91,
        ai_needs_review: true,
        ai_source: 'model',
        ai_model: 'some-model',
      });
    });
  });

  describe('the form to contact mapping', () => {
    const form = {
      first_name: 'Dana',
      last_name: 'Ruiz',
      email: 'dana@sample.example.com',
      phone: '',
      company: 'Cedar',
      job_title: 'Manager',
      website: '',
      property_city: 'Dayton',
      property_state: 'OH',
      message: 'Hello',
    };

    test('sets only form fields and never CRM process fields', () => {
      const props = contactProperties(form, true);
      assert.deepEqual(Object.keys(props).sort(), ['city', 'company', 'firstname', 'jobtitle', 'lastname', 'ltl_synthetic', 'message', 'state']);
      assert.equal(props.ltl_synthetic, true);
    });

    test('empty values are left out, so a resubmission cannot blank a field', () => {
      assert.equal('phone' in contactProperties(form, false), false);
      assert.equal('ltl_synthetic' in contactProperties(form, false), false);
    });

    test('the mapped properties are accepted by the simulator', async () => {
      const contact = await client.upsertContactByEmail(form.email, contactProperties(form, true));
      assert.ok(contact.id);
    });
  });
});
