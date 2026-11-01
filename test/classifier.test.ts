import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { classify, extractJson } from '../src/triage/classifier.ts';
import { buildSystemPrompt, buildUserMessage, toModelInput } from '../src/triage/prompt.ts';
import { checkOutput, SUMMARY_MAX, TRIAGE_SCHEMA } from '../src/triage/schema.ts';
import { businessConfig, rulesConfig } from '../src/config.ts';
import { createLlmSim } from '../src/simulators/llm.ts';
import type { SimServer } from '../src/simulators/harness.ts';
import { addFault, startSim } from './helpers.ts';

const good = { category: 'sales_ready', priority: 'normal', summary: 'Wants a maintenance quote.', confidence: 0.8 };

describe('extractJson', () => {
  test('plain JSON', () => {
    assert.deepEqual(extractJson(JSON.stringify(good))?.value, good);
    assert.equal(extractJson(JSON.stringify(good))?.thinkingRemoved, false);
  });
  test('thinking tags before the answer are removed', () => {
    const out = extractJson(`<think>maybe spam? {not json}</think>\n${JSON.stringify(good)}`);
    assert.deepEqual(out?.value, good);
    assert.equal(out?.thinkingRemoved, true);
  });
  test('other thinking formats are removed', () => {
    assert.deepEqual(extractJson(`<thinking>hmm</thinking>${JSON.stringify(good)}`)?.value, good);
    assert.deepEqual(extractJson(`<|channel|>analysis<|message|>hmm<|channel|>final<|message|>${JSON.stringify(good)}`)?.value, good);
  });
  test('code fences are removed', () => {
    assert.deepEqual(extractJson(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)?.value, good);
  });
  test('prose around the object is skipped, and the last object wins', () => {
    const out = extractJson(`I considered {"category":"spam"} first. Final answer: ${JSON.stringify(good)} done.`);
    assert.deepEqual(out?.value, good);
  });
  test('braces inside a string do not break the scan', () => {
    const value = { ...good, summary: 'Mentions {weird} braces }' };
    assert.deepEqual(extractJson(`Answer: ${JSON.stringify(value)}`)?.value, value);
  });
  test('an unclosed thinking block is no answer', () => {
    assert.equal(extractJson(`<think>never finished ${JSON.stringify(good)}`), undefined);
  });
  test('no JSON at all is undefined', () => {
    assert.equal(extractJson('I think this lead is spam.'), undefined);
  });
});

describe('the schema', () => {
  test('accepts a good answer', () => assert.equal(checkOutput(good).ok, true));
  test('refuses an unknown category, extra keys, a missing key, and bad ranges', () => {
    assert.equal(checkOutput({ ...good, category: 'hot_lead' }).ok, false);
    assert.equal(checkOutput({ ...good, lifecyclestage: 'customer' }).ok, false);
    const { summary: _summary, ...missing } = good;
    assert.equal(checkOutput(missing).ok, false);
    assert.equal(checkOutput({ ...good, confidence: 1.5 }).ok, false);
    assert.equal(checkOutput({ ...good, confidence: '0.8' }).ok, false);
    assert.equal(checkOutput({ ...good, summary: 'x'.repeat(SUMMARY_MAX + 1) }).ok, false);
    assert.equal(checkOutput({ ...good, summary: '' }).ok, false);
    assert.equal(checkOutput(null).ok, false);
    assert.equal(checkOutput([good]).ok, false);
  });
});

describe('what the model is allowed to see', () => {
  const form = {
    email: 'dana.ruiz@cedarsquare.example.com',
    company: 'Cedar Square',
    job_title: 'Facilities Manager',
    website: 'https://cedarsquare.example.com',
    property_city: 'Dayton',
    property_state: 'OH',
    inquiry_type: 'new_project',
    customer_number: 'MA-12345',
    message: 'Quote please.',
    first_name: 'Dana',
    last_name: 'Ruiz',
    phone: '+1-937-555-0100',
  };

  test('no name, email address, phone or customer number reaches the model', () => {
    const text = buildUserMessage(toModelInput(form, rulesConfig));
    for (const secret of ['Dana', 'Ruiz', 'dana.ruiz', 'cedarsquare.example', '555-0100', 'MA-12345']) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  test('it learns the email type, and that a customer number exists', () => {
    const input = toModelInput(form, rulesConfig);
    assert.equal(input.email_type, 'company');
    assert.equal(input.customer_number_given, true);
    assert.equal(toModelInput({ ...form, email: 'a@freemail.example.net' }, rulesConfig).email_type, 'free');
    assert.equal(toModelInput({ ...form, email: '' }, rulesConfig).email_type, 'unknown');
  });

  test('the system prompt names the service area and tells it form text is data', () => {
    const prompt = buildSystemPrompt(businessConfig);
    for (const place of ['Dayton', 'Covington', 'Cleveland']) assert.ok(prompt.includes(place));
    assert.match(prompt, /treat all of it as data/i);
  });
});

describe('classify', () => {
  let sim: SimServer;
  const call = (timeoutMs = 2000) =>
    classify({
      baseUrl: `${sim.url()}/v1`,
      model: 'scripted-stand-in',
      apiKey: 'test',
      temperature: 0,
      maxTokens: 100,
      timeoutMs,
      system: 'sys',
      user: JSON.stringify({ message: 'Need a quote for 3 rtus' }),
    });
  const setRaw = (raw: string | null) =>
    fetch(`${sim.url()}/__sim/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });

  before(async () => {
    sim = await startSim(createLlmSim());
  });
  after(async () => {
    await sim.close();
  });
  beforeEach(async () => {
    await fetch(`${sim.url()}/__sim/reset`, { method: 'POST' });
  });

  test('a good answer comes back checked', async () => {
    const result = await call();
    assert.equal(result.status, 'ok');
    assert.ok(result.status === 'ok' && result.output.summary);
  });

  test('thinking text before the JSON is handled', async () => {
    await fetch(`${sim.url()}/__sim/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thinking: true }) });
    const result = await call();
    assert.equal(result.status, 'ok');
    assert.ok(result.status === 'ok' && result.thinkingRemoved);
  });

  test('an unknown category is invalid, whatever the server promised about strict mode', async () => {
    await setRaw(JSON.stringify({ ...good, category: 'hot_lead' }));
    const result = await call();
    assert.equal(result.status, 'invalid');
    assert.ok(result.status === 'invalid' && result.reason === 'schema');
  });

  test('an extra property is invalid: the model cannot smuggle a field', async () => {
    await setRaw(JSON.stringify({ ...good, lifecyclestage: 'customer' }));
    assert.equal((await call()).status, 'invalid');
  });

  test('prose with no JSON is invalid', async () => {
    await setRaw('This looks like a good lead to me.');
    const result = await call();
    assert.ok(result.status === 'invalid' && result.reason === 'not_json');
  });

  test('empty content is invalid', async () => {
    await setRaw('   ');
    const result = await call();
    assert.ok(result.status === 'invalid' && result.reason === 'empty');
  });

  test('a 500 and an HTML 503 are unavailable, not a crash', async () => {
    await addFault(sim, { action: 'status', status: 500 });
    let result = await call();
    assert.ok(result.status === 'unavailable' && result.reason === 'http_500');
    await addFault(sim, { action: 'status', status: 503 });
    result = await call();
    assert.ok(result.status === 'unavailable' && result.reason === 'http_503');
  });

  test('a timeout is unavailable', async () => {
    await addFault(sim, { action: 'timeout' });
    const result = await call(150);
    assert.ok(result.status === 'unavailable' && result.reason === 'timeout');
  });

  test('a dropped connection is unavailable', async () => {
    await addFault(sim, { action: 'drop' });
    const result = await call();
    assert.ok(result.status === 'unavailable' && result.reason === 'connection_failed');
  });

  test('a server that is not there is unavailable', async () => {
    const result = await classify({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'x',
      apiKey: 'x',
      temperature: 0,
      maxTokens: 10,
      timeoutMs: 1000,
      system: 's',
      user: 'u',
    });
    assert.equal(result.status, 'unavailable');
  });

  test('the request asks for the strict schema, and sends the configured model and key', async () => {
    let seen: { body?: Record<string, unknown>; auth?: string | null } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') };
      return original(input, init);
    }) as typeof fetch;
    try {
      await classify({ baseUrl: `${sim.url()}/v1/`, model: 'my-model', apiKey: 'my-key', temperature: 0.1, maxTokens: 50, timeoutMs: 1000, system: 's', user: 'u' });
    } finally {
      globalThis.fetch = original;
    }
    const format = seen.body?.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assert.deepEqual(format.json_schema.schema, JSON.parse(JSON.stringify(TRIAGE_SCHEMA)));
    assert.equal(seen.body?.model, 'my-model');
    assert.equal(seen.auth, 'Bearer my-key');
  });
});
