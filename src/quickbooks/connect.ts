// Connecting to QuickBooks. The real flow needs a person's consent in a browser, so it
// lives in scripts/connect-quickbooks.ts. This file holds the pieces both flows share,
// plus the simulator's version, which consents automatically.

import { randomBytes } from 'node:crypto';
import type { QuickBooksSettings } from '../config.ts';
import { discover } from './tokens.ts';
import type { TokenStore } from './tokens.ts';

export const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

export function newState(): string {
  return randomBytes(24).toString('hex');
}

export async function authorizationUrl(settings: QuickBooksSettings, state: string): Promise<string> {
  const { authorization_endpoint } = await discover(settings);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    scope: ACCOUNTING_SCOPE,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    state,
  }).toString();
  return url.toString();
}

/** The simulator consents with a redirect, so no person or browser is involved. */
export async function connectSimulator(settings: QuickBooksSettings, store: TokenStore): Promise<void> {
  const state = newState();
  const res = await fetch(await authorizationUrl(settings, state), { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`simulator consent failed: HTTP ${res.status}`);
  const target = new URL(location);
  if (target.searchParams.get('state') !== state) throw new Error('simulator consent returned the wrong state');
  await store.exchangeCode(target.searchParams.get('code') ?? '', target.searchParams.get('realmId') ?? '');
}
