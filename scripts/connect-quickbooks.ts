// Connects this repo to a QuickBooks sandbox company. Needs Postgres running and the
// Intuit keys in .env. Tokens go into Postgres, encrypted, and are never printed.
//
//   node scripts/connect-quickbooks.ts              opens your browser for the consent click
//   node scripts/connect-quickbooks.ts --print-url  prints the consent URL instead of opening it
//   node scripts/connect-quickbooks.ts --from-env   uses INTUIT_REFRESH_TOKEN and INTUIT_REALM_ID
//                                                   from .env, if localhost isn't accepted and
//                                                   you got them from Intuit's OAuth Playground
//   node scripts/connect-quickbooks.ts --sim        connects to the local simulator instead

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { quickbooksSettings, ROOT } from '../src/config.ts';
import { createDb, migrate } from '../src/db.ts';
import { QuickBooksClient } from '../src/quickbooks/client.ts';
import { authorizationUrl, connectSimulator, newState } from '../src/quickbooks/connect.ts';
import { tokenKeyFrom, TokenStore } from '../src/quickbooks/tokens.ts';

const { values: args } = parseArgs({
  options: {
    'print-url': { type: 'boolean', default: false },
    'from-env': { type: 'boolean', default: false },
    sim: { type: 'boolean', default: false },
  },
});

if (!args.sim) process.env.LTL_TARGET = 'real';

if (!process.env.LTL_TOKEN_KEY) {
  if (args.sim) {
    // The same fixed key docker-compose.yml uses for the simulator's made-up tokens.
    process.env.LTL_TOKEN_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
  } else {
    // The key that encrypts real tokens at rest. Generated once and kept in .env, not shown.
    const key = randomBytes(32).toString('base64');
    appendFileSync(path.join(ROOT, '.env'), `\nLTL_TOKEN_KEY=${key}\n`);
    process.env.LTL_TOKEN_KEY = key;
  }
}

const settings = quickbooksSettings();
const db = createDb();
try {
  await migrate(db);
} catch {
  console.error('Could not reach Postgres. Start it with: docker compose up -d postgres');
  process.exit(1);
}
const store = new TokenStore(db, settings, tokenKeyFrom(process.env.LTL_TOKEN_KEY));

async function checkConnection(): Promise<void> {
  const qb = new QuickBooksClient({ baseUrl: settings.apiBaseUrl, realmId: () => store.realmId(), tokens: store, minorVersion: settings.minorVersion });
  const res = await qb.companyName();
  if (!res.ok) throw new Error(`connected, but a test read failed: ${res.kind} ${res.code ?? res.status ?? ''}`);
  console.log('Connected. A test read of the sandbox company worked.');
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command[0] as string, command[1] as string[], { stdio: 'ignore', detached: true }).unref();
}

function waitForCallback(state: string): Promise<{ code: string; realmId: string }> {
  const redirect = new URL(settings.redirectUri);
  const port = Number(redirect.port || 80);
  return new Promise((resolve, reject) => {
    const servers: http.Server[] = [];
    const closeAll = () => {
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    };
    const timer = setTimeout(() => {
      closeAll();
      reject(new Error('Nothing came back within 5 minutes. Run this again when you are ready to click.'));
    }, 300_000);
    const handler: http.RequestListener = (req, res) => {
      const url = new URL(req.url ?? '/', settings.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>QuickBooks connection</title><p style="font:16px system-ui;margin:40px">${message}</p>`);
        clearTimeout(timer);
      };
      const error = url.searchParams.get('error');
      if (error) {
        finish(false, 'QuickBooks did not grant access. You can close this tab and try again.');
        closeAll();
        reject(new Error(`Intuit answered ${error}`));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        finish(false, 'That response did not match this request. You can close this tab and try again.');
        closeAll();
        reject(new Error('state did not match, so the response was ignored'));
        return;
      }
      finish(true, 'Connected. You can close this tab.');
      closeAll();
      resolve({ code: url.searchParams.get('code') ?? '', realmId: url.searchParams.get('realmId') ?? '' });
    };
    // A browser may resolve localhost to either address.
    for (const host of ['127.0.0.1', '::1']) {
      const server = http.createServer(handler);
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (host === '127.0.0.1') {
          clearTimeout(timer);
          reject(new Error(`Could not listen on ${redirect.host}: ${error.code}`));
        }
      });
      server.listen(port, host);
      servers.push(server);
    }
  });
}

try {
  if (args.sim) {
    await connectSimulator(settings, store);
    await checkConnection();
  } else if (args['from-env']) {
    const refresh = process.env.INTUIT_REFRESH_TOKEN;
    const realm = process.env.INTUIT_REALM_ID;
    if (!refresh || !realm) throw new Error('Put INTUIT_REFRESH_TOKEN and INTUIT_REALM_ID in .env first.');
    await store.adoptRefreshToken(refresh, realm);
    await checkConnection();
    console.log('You can delete INTUIT_REFRESH_TOKEN and INTUIT_REALM_ID from .env now.');
  } else {
    const state = newState();
    const url = await authorizationUrl(settings, state);
    const callback = waitForCallback(state);
    if (args['print-url']) {
      console.log(`Open this in the browser where you're signed in to Intuit:\n${url}`);
    } else {
      openBrowser(url);
      console.log('Your browser should open on Intuit\'s consent page. Pick the sandbox company and click Connect.');
      console.log('If nothing opens, stop this and run it again with --print-url.');
    }
    console.log(`Waiting for the redirect to ${settings.redirectUri}`);
    const { code, realmId } = await callback;
    await store.exchangeCode(code, realmId);
    await checkConnection();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
