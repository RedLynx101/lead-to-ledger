// Real credentials must not reach a simulator, and nothing here may point at production.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { hubspotSettings, quickbooksSettings, usingRealServices } from '../src/config.ts';

const NAMES = ['LTL_TARGET', 'INTUIT_ENVIRONMENT', 'INTUIT_CLIENT_ID', 'INTUIT_CLIENT_SECRET', 'HUBSPOT_TOKEN', 'HUBSPOT_BASE_URL', 'QB_API_BASE_URL'];

describe('which services are used', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
    for (const name of NAMES) delete process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('the default is the simulators', () => {
    assert.equal(usingRealServices(), false);
    assert.match(hubspotSettings().baseUrl, /127\.0\.0\.1/);
    assert.match(quickbooksSettings().apiBaseUrl, /127\.0\.0\.1/);
  });

  test('real credentials in the environment are not sent to a simulator', () => {
    process.env.HUBSPOT_TOKEN = 'real-looking-token';
    process.env.INTUIT_CLIENT_ID = 'real-looking-id';
    process.env.INTUIT_CLIENT_SECRET = 'real-looking-secret';
    assert.equal(hubspotSettings().token, 'sim-hubspot-token');
    assert.equal(quickbooksSettings().clientId, 'sim-client-id');
    assert.equal(quickbooksSettings().clientSecret, 'sim-client-secret');
  });

  test('real mode needs its credentials and says which one is missing', () => {
    process.env.LTL_TARGET = 'real';
    process.env.INTUIT_ENVIRONMENT = 'sandbox';
    assert.throws(() => hubspotSettings(), /HUBSPOT_TOKEN must be set/);
    assert.throws(() => quickbooksSettings(), /INTUIT_CLIENT_ID must be set/);
  });

  test('real mode points at the sandbox and at HubSpot', () => {
    process.env.LTL_TARGET = 'real';
    process.env.INTUIT_ENVIRONMENT = 'sandbox';
    process.env.INTUIT_CLIENT_ID = 'x';
    process.env.INTUIT_CLIENT_SECRET = 'y';
    process.env.HUBSPOT_TOKEN = 'z';
    assert.equal(quickbooksSettings().apiBaseUrl, 'https://sandbox-quickbooks.api.intuit.com');
    assert.match(quickbooksSettings().discoveryUrl, /openid_sandbox_configuration$/);
    assert.equal(hubspotSettings().baseUrl, 'https://api.hubapi.com');
  });

  test('production is refused outright', () => {
    process.env.LTL_TARGET = 'real';
    process.env.INTUIT_ENVIRONMENT = 'production';
    process.env.INTUIT_CLIENT_ID = 'x';
    process.env.INTUIT_CLIENT_SECRET = 'y';
    assert.throws(() => quickbooksSettings(), /does not run against production/);
    delete process.env.INTUIT_ENVIRONMENT;
    assert.throws(() => quickbooksSettings(), /must be sandbox/);
  });
});
