// The consent script, run as a process against the QuickBooks simulator, through the same
// steps the real flow takes: consent URL, redirect to a local callback, code exchange, and
// a test read. A fetch that follows redirects stands in for the browser.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { databaseUrl } from '../../src/config.ts';
import type { QuickBooksSettings } from '../../src/config.ts';
import { createDb, migrate } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { tokenKeyFrom, TokenStore } from '../../src/quickbooks/tokens.ts';
import { createQuickBooksSim } from '../../src/simulators/quickbooks.ts';
import type { SimServer } from '../../src/simulators/harness.ts';
import { startSim } from '../helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TEST_DB_URL = databaseUrl().replace(/\/ltl$/, '/ltl_test');
const SIM_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const PORT = 18765;
const REDIRECT = `http://localhost:${PORT}/callback`;

function run(args: string[], env: Record<string, string>, onLine?: (line: string) => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/connect-quickbooks.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, LTL_DATABASE_URL: TEST_DB_URL, LTL_TOKEN_KEY: SIM_KEY, INTUIT_REDIRECT_URI: REDIRECT, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
      for (const line of String(chunk).split('\n')) if (line.trim()) onLine?.(line.trim());
    });
    child.stderr.on('data', (chunk: Buffer) => (out += String(chunk)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('npm run connect:quickbooks, against the simulator', () => {
  let db: Db;
  let sim: SimServer;
  let store: TokenStore;

  before(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl() });
    await admin.connect();
    if ((await admin.query("select 1 from pg_database where datname = 'ltl_test'")).rowCount === 0) await admin.query('create database ltl_test');
    await admin.end();
    db = createDb(TEST_DB_URL);
    await migrate(db);
    sim = await startSim(createQuickBooksSim({ redirectUris: [REDIRECT] }));
    const settings: QuickBooksSettings = {
      apiBaseUrl: sim.url(),
      discoveryUrl: `${sim.url()}/.well-known/openid_sandbox_configuration`,
      clientId: 'sim-client-id',
      clientSecret: 'sim-client-secret',
      redirectUri: REDIRECT,
      minorVersion: '75',
      itemName: 'Services',
    };
    store = new TokenStore(db, settings, tokenKeyFrom(SIM_KEY));
  });
  after(async () => {
    await sim.close();
    await db.end();
  });
  beforeEach(async () => {
    await db.query('truncate oauth_connections');
  });

  test('the consent flow: URL, callback, exchange and a test read', async () => {
    let followed: Promise<unknown> | undefined;
    const result = await run(['--sim', '--print-url'], { QB_API_BASE_URL: sim.url() }, (line) => {
      if (line.startsWith('http')) {
        assert.match(line, /response_type=code/);
        assert.match(line, /scope=com\.intuit\.quickbooks\.accounting/);
        assert.match(line, /state=[0-9a-f]{48}/);
        // The browser's part: follow the consent redirect to the local callback.
        followed = fetch(line).then((res) => res.text());
      }
    });
    assert.equal(result.code, 0, result.out);
    assert.match(String(await followed), /Connected/);
    assert.match(result.out, /Connected\. A test read of the sandbox company worked\./);
    assert.equal(await store.status(), 'connected');
  });

  test('a callback with the wrong state is refused and nothing is stored', async () => {
    const result = await run(['--sim', '--print-url'], { QB_API_BASE_URL: sim.url() }, (line) => {
      if (line.startsWith('Waiting')) void fetch(`${REDIRECT}?code=x&realmId=y&state=wrong`);
    });
    assert.equal(result.code, 1);
    assert.match(result.out, /state did not match/);
    assert.equal(await store.status(), 'missing');
  });

  test('a refusal on the consent page is reported', async () => {
    const result = await run(['--sim', '--print-url'], { QB_API_BASE_URL: sim.url() }, (line) => {
      if (line.startsWith('Waiting')) void fetch(`${REDIRECT}?error=access_denied&state=whatever`);
    });
    assert.equal(result.code, 1);
    assert.match(result.out, /access_denied/);
  });

  test('the OAuth Playground fallback: a refresh token and realm ID from .env', async () => {
    const consent = await fetch(`${sim.url()}/connect/oauth2?client_id=sim-client-id&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s`, { redirect: 'manual' });
    const target = new URL(consent.headers.get('location')!);
    const tokens = await fetch(`${sim.url()}/oauth2/v1/tokens/bearer`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: target.searchParams.get('code')!, redirect_uri: REDIRECT }),
    });
    const { refresh_token } = (await tokens.json()) as { refresh_token: string };
    const result = await run(['--sim', '--from-env'], { QB_API_BASE_URL: sim.url(), INTUIT_REFRESH_TOKEN: refresh_token, INTUIT_REALM_ID: target.searchParams.get('realmId')! });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /You can delete INTUIT_REFRESH_TOKEN/);
    assert.equal(await store.status(), 'connected');
  });

  test('nothing secret is printed', async () => {
    const result = await run(['--sim', '--print-url'], { QB_API_BASE_URL: sim.url() }, (line) => {
      if (line.startsWith('http')) void fetch(line);
    });
    assert.equal(/sim_at_|sim_rt_|sim-client-secret/.test(result.out), false);
  });
});
