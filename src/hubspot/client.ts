// A small HubSpot client. Two things worth noticing:
//
// - HubSpot has no idempotency key. So this client only retries calls that are safe to
//   repeat: reads, PATCH, batch upsert by email, and search. A plain create doesn't
//   retry here; a caller who wants one must look first and handle the 409.
// - writeAiFields refuses any property outside the ai_ list. A bug or a steered model
//   can't reach lifecycle stage, owner, or contact details through this path.

import { AI_FIELD_NAMES } from '../triage/decide.ts';
import type { AiFields } from '../triage/decide.ts';

export interface HubSpotOptions {
  baseUrl: string;
  token: string;
  apiVersion: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Replaced in tests so backoff doesn't slow them down. */
  sleep?: (ms: number) => Promise<void>;
}

export class HubSpotError extends Error {
  readonly status: number | null;
  readonly category: string | null;
  readonly correlationId: string | null;
  readonly retryable: boolean;

  constructor(message: string, fields: { status: number | null; category?: string | null; correlationId?: string | null; retryable: boolean }) {
    super(message);
    this.name = 'HubSpotError';
    this.status = fields.status;
    this.category = fields.category ?? null;
    this.correlationId = fields.correlationId ?? null;
    this.retryable = fields.retryable;
  }
}

export interface CrmRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

const RETRYABLE = new Set([423, 429, 500, 502, 503, 504]);

export function assertOnlyAiFields(fields: Record<string, unknown>): void {
  const allowed = new Set<string>(AI_FIELD_NAMES);
  const bad = Object.keys(fields).filter((name) => !allowed.has(name));
  if (bad.length > 0) throw new Error(`refusing to write non-ai_ properties: ${bad.join(', ')}`);
}

export class HubSpotClient {
  private readonly options: Required<Omit<HubSpotOptions, 'sleep'>> & { sleep: (ms: number) => Promise<void> };

  constructor(options: HubSpotOptions) {
    this.options = {
      timeoutMs: 20_000,
      maxAttempts: 4,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
  }

  private path(area: 'objects' | 'properties' | 'pipelines', rest: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/crm/${area}/${this.options.apiVersion}/${rest}`;
  }

  private async once<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      throw new HubSpotError(`no response from HubSpot (${name})`, { status: null, retryable: true });
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Gateways answer with HTML. Keep the status, ignore the body.
      parsed = undefined;
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { message?: string; category?: string; errorType?: string; correlationId?: string };
      const message = err.message ?? `HTTP ${res.status}`;
      const failure = new HubSpotError(message, {
        status: res.status,
        category: err.category ?? err.errorType ?? null,
        correlationId: err.correlationId ?? null,
        retryable: RETRYABLE.has(res.status),
      });
      (failure as HubSpotError & { retryAfterMs?: number }).retryAfterMs = Number(res.headers.get('retry-after') ?? 0) * 1000;
      throw failure;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  /** Retries only what the caller says is safe to repeat. */
  private async request<T>(method: string, url: string, body: unknown, safeToRepeat: boolean): Promise<T> {
    const attempts = safeToRepeat ? this.options.maxAttempts : 1;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return (await this.once<T>(method, url, body)).body;
      } catch (error) {
        last = error;
        if (!(error instanceof HubSpotError) || !error.retryable || attempt === attempts) throw error;
        const retryAfter = (error as HubSpotError & { retryAfterMs?: number }).retryAfterMs ?? 0;
        const backoff = Math.max(retryAfter, 500 * 2 ** (attempt - 1) + Math.random() * 250);
        await this.options.sleep(backoff);
      }
    }
    throw last;
  }

  /** Create or update by email. Safe to repeat: email is unique on contacts. */
  async upsertContactByEmail(email: string, properties: Record<string, string | boolean | null>): Promise<CrmRecord & { new: boolean }> {
    const body = { inputs: [{ idProperty: 'email', id: email, properties }] };
    const res = await this.request<{ results: Array<CrmRecord & { new: boolean }> }>('POST', this.path('objects', 'contacts/batch/upsert'), body, true);
    return res.results[0];
  }

  async getContactByEmail(email: string, properties: string[] = []): Promise<CrmRecord | null> {
    const query = new URLSearchParams({ idProperty: 'email' });
    if (properties.length > 0) query.set('properties', properties.join(','));
    try {
      return await this.request<CrmRecord>('GET', `${this.path('objects', `contacts/${encodeURIComponent(email)}`)}?${query}`, undefined, true);
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  /** The only write the triage path has. Safe to repeat: same values, same result. */
  async writeAiFields(email: string, fields: AiFields): Promise<CrmRecord> {
    assertOnlyAiFields(fields);
    const url = `${this.path('objects', `contacts/${encodeURIComponent(email)}`)}?idProperty=email`;
    return this.request<CrmRecord>('PATCH', url, { properties: fields }, true);
  }

  /** Deals in a stage, modified at or after a time, oldest first. Lags writes, so callers overlap their cursor. */
  async searchDealsInStage(stage: string, modifiedSinceMs: number, properties: string[], after?: string): Promise<{ results: CrmRecord[]; next?: string }> {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'dealstage', operator: 'EQ', value: stage },
            { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(modifiedSinceMs) },
          ],
        },
      ],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties,
      limit: 100,
      ...(after ? { after } : {}),
    };
    const res = await this.request<{ results: CrmRecord[]; paging?: { next?: { after?: string } } }>('POST', this.path('objects', 'deals/search'), body, true);
    return { results: res.results, next: res.paging?.next?.after };
  }

  async getDeal(id: string, properties: string[]): Promise<CrmRecord | null> {
    const query = new URLSearchParams({ properties: properties.join(','), associations: 'contacts' });
    try {
      return await this.request<CrmRecord>('GET', `${this.path('objects', `deals/${id}`)}?${query}`, undefined, true);
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  async getContact(id: string, properties: string[]): Promise<CrmRecord | null> {
    const query = new URLSearchParams({ properties: properties.join(',') });
    try {
      return await this.request<CrmRecord>('GET', `${this.path('objects', `contacts/${id}`)}?${query}`, undefined, true);
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  /** The worker's only CRM write, limited to ltl_ fields. Safe to repeat: same values, same result. */
  async writeDealLedgerFields(id: string, fields: Record<string, string>): Promise<CrmRecord> {
    const bad = Object.keys(fields).filter((name) => !name.startsWith('ltl_'));
    if (bad.length > 0) throw new Error(`refusing to write non-ltl_ deal properties: ${bad.join(', ')}`);
    return this.request<CrmRecord>('PATCH', this.path('objects', `deals/${id}`), { properties: fields }, true);
  }

  /** For demos and tests. A plain create has no idempotency key, so it doesn't retry. */
  async createDeal(properties: Record<string, string>, contactId?: string): Promise<CrmRecord> {
    const associations = contactId ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }] : [];
    return this.request<CrmRecord>('POST', this.path('objects', 'deals'), { properties, associations }, false);
  }

  /** For demos and tests: moves a deal the way a salesperson would. */
  async updateDeal(id: string, properties: Record<string, string>): Promise<CrmRecord> {
    return this.request<CrmRecord>('PATCH', this.path('objects', `deals/${id}`), { properties }, true);
  }

  async createPropertyGroup(objectType: string, name: string, label: string): Promise<'created' | 'exists'> {
    try {
      await this.request('POST', this.path('properties', `${objectType}/groups`), { name, label }, false);
      return 'created';
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 409) return 'exists';
      throw error;
    }
  }

  async createProperty(objectType: string, definition: Record<string, unknown>): Promise<'created' | 'exists'> {
    try {
      await this.request('POST', this.path('properties', objectType), definition, false);
      return 'created';
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 409) return 'exists';
      throw error;
    }
  }
}
