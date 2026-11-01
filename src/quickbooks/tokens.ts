// Stores the QuickBooks connection and refreshes it. Tokens are encrypted at rest and
// never logged.
//
// Intuit rotates refresh tokens and allows one refresh at a time, so a refresh holds a
// row lock across the call. A process that dies after Intuit rotated the token but
// before the new value is saved loses the connection. There's no way to close that gap
// from this side, so the job waits and a person reconnects: it costs a click, not a
// duplicate invoice.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';
import type { QuickBooksSettings } from '../config.ts';

const PROVIDER = 'quickbooks';
const REFRESH_EARLY_MS = 60_000;

export class ReconnectNeeded extends Error {
  constructor(reason: string) {
    super(`QuickBooks needs reconnecting: ${reason}`);
    this.name = 'ReconnectNeeded';
  }
}

export class TokenRefreshFailed extends Error {
  constructor(reason: string) {
    super(`token refresh failed: ${reason}`);
    this.name = 'TokenRefreshFailed';
  }
}

export interface TokenSource {
  accessToken(): Promise<string>;
  /** Refreshes unless someone already replaced `staleAccess`. */
  refresh(staleAccess: string): Promise<string>;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function tokenKeyFrom(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('LTL_TOKEN_KEY must be 32 bytes, base64-encoded');
  return key;
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

export async function discover(settings: QuickBooksSettings): Promise<Endpoints> {
  const res = await fetch(settings.discoveryUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new TokenRefreshFailed(`discovery document returned HTTP ${res.status}`);
  return (await res.json()) as Endpoints;
}

function basicAuth(settings: QuickBooksSettings): string {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}`;
}

async function postTokens(settings: QuickBooksSettings, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token_endpoint } = await discover(settings);
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { authorization: basicAuth(settings), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON error page. The status is enough.
  }
  return { status: res.status, body };
}

export class TokenStore implements TokenSource {
  private readonly db: Db;
  private readonly settings: QuickBooksSettings;
  private readonly key: Buffer;
  private readonly checkpoint: (name: string) => void;

  constructor(db: Db, settings: QuickBooksSettings, key: Buffer, checkpoint: (name: string) => void = () => {}) {
    this.db = db;
    this.settings = settings;
    this.key = key;
    this.checkpoint = checkpoint;
  }

  async status(): Promise<'missing' | 'connected' | 'needs_reconnect'> {
    const res = await this.db.query<{ status: 'connected' | 'needs_reconnect' }>('select status from oauth_connections where provider = $1', [PROVIDER]);
    return res.rows[0]?.status ?? 'missing';
  }

  async realmId(): Promise<string> {
    const res = await this.db.query<{ realm_id_enc: string }>('select realm_id_enc from oauth_connections where provider = $1', [PROVIDER]);
    if (!res.rows[0]) throw new ReconnectNeeded('not connected yet');
    return decrypt(res.rows[0].realm_id_enc, this.key);
  }

  private async save(tokens: TokenResponse, realmEnc: string, runner: { query: Db['query'] } = this.db): Promise<void> {
    await runner.query(
      `insert into oauth_connections (provider, realm_id_enc, access_token_enc, refresh_token_enc, access_expires_at, status)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5), 'connected')
       on conflict (provider) do update set realm_id_enc = excluded.realm_id_enc, access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc, access_expires_at = excluded.access_expires_at, status = 'connected', updated_at = now()`,
      [PROVIDER, realmEnc, encrypt(tokens.access_token, this.key), encrypt(tokens.refresh_token, this.key), tokens.expires_in],
    );
  }

  /** The consent callback landed here. A code works once, so this runs once. */
  async exchangeCode(code: string, realmId: string): Promise<void> {
    const { status, body } = await postTokens(this.settings, { grant_type: 'authorization_code', code, redirect_uri: this.settings.redirectUri });
    if (status !== 200) throw new Error(`Intuit refused the code: HTTP ${status} ${String(body.error ?? '')}`.trim());
    await this.save(body as unknown as TokenResponse, encrypt(realmId, this.key));
  }

  /** For a refresh token obtained another way, such as Intuit's OAuth Playground. */
  async adoptRefreshToken(refreshToken: string, realmId: string): Promise<void> {
    const { status, body } = await postTokens(this.settings, { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (status !== 200) throw new Error(`Intuit refused the refresh token: HTTP ${status} ${String(body.error ?? '')}`.trim());
    await this.save(body as unknown as TokenResponse, encrypt(realmId, this.key));
  }

  async accessToken(): Promise<string> {
    const res = await this.db.query<{ access_token_enc: string; access_expires_at: Date; status: string }>(
      'select access_token_enc, access_expires_at, status from oauth_connections where provider = $1',
      [PROVIDER],
    );
    const row = res.rows[0];
    if (!row) throw new ReconnectNeeded('not connected yet');
    if (row.status !== 'connected') throw new ReconnectNeeded('a refresh was refused');
    const access = decrypt(row.access_token_enc, this.key);
    if (row.access_expires_at.getTime() - Date.now() > REFRESH_EARLY_MS) return access;
    return this.refresh(access);
  }

  async refresh(staleAccess: string): Promise<string> {
    const client = await this.db.connect();
    let committed = false;
    try {
      await client.query('begin');
      const res = await client.query<{ realm_id_enc: string; access_token_enc: string; refresh_token_enc: string; access_expires_at: Date; status: string }>(
        'select * from oauth_connections where provider = $1 for update',
        [PROVIDER],
      );
      const row = res.rows[0];
      if (!row) throw new ReconnectNeeded('not connected yet');
      if (row.status !== 'connected') throw new ReconnectNeeded('a refresh was refused');

      // Another worker refreshed while this one waited for the lock.
      const current = decrypt(row.access_token_enc, this.key);
      if (current !== staleAccess && row.access_expires_at.getTime() - Date.now() > REFRESH_EARLY_MS) {
        await client.query('commit');
        committed = true;
        return current;
      }

      this.checkpoint('before:qb.token_refresh');
      let outcome: { status: number; body: Record<string, unknown> };
      try {
        outcome = await postTokens(this.settings, { grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc, this.key) });
      } catch (error) {
        throw new TokenRefreshFailed((error as Error).name);
      }
      this.checkpoint('after:qb.token_refresh');

      if (outcome.status === 200) {
        const tokens = outcome.body as unknown as TokenResponse;
        await this.save(tokens, row.realm_id_enc, client);
        await client.query('commit');
        committed = true;
        return tokens.access_token;
      }
      if (outcome.status === 400 && outcome.body.error === 'invalid_grant') {
        await client.query("update oauth_connections set status = 'needs_reconnect', updated_at = now() where provider = $1", [PROVIDER]);
        await client.query('commit');
        committed = true;
        throw new ReconnectNeeded('Intuit answered invalid_grant');
      }
      throw new TokenRefreshFailed(`HTTP ${outcome.status}`);
    } finally {
      if (!committed) await client.query('rollback').catch(() => {});
      client.release();
    }
  }
}
