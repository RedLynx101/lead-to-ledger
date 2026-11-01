// A QuickBooks Online client that reports what each failure means for a write, because
// that's the decision the worker has to make:
//
//   not processed      401, 429, a validation fault. Nothing was written.
//   unknown_outcome    a timeout, a dropped connection, a 5xx, or a system fault. It may
//                      have been written. The caller has to look before it writes again.
//
// It doesn't retry writes itself. A 401 is the one exception: the token is refreshed and
// the call repeats once, since a 401 means the call never ran.

import type { TokenSource } from './tokens.ts';

export type QbFailureKind =
  | 'auth'
  | 'forbidden'
  | 'throttled'
  | 'unknown_outcome'
  | 'validation'
  | 'duplicate_name'
  | 'duplicate_doc'
  | 'duplicate_request';

export interface QbFailure {
  ok: false;
  kind: QbFailureKind;
  status: number | null;
  code: string | null;
  message: string;
  retryAfterMs: number;
  tid: string | null;
}

export type QbResult<T> = { ok: true; body: T; tid: string | null } | QbFailure;

export interface QbEntity {
  Id: string;
  SyncToken?: string;
  DisplayName?: string;
  DocNumber?: string;
  TotalAmt?: number;
  Name?: string;
  Active?: boolean;
  [key: string]: unknown;
}

export interface QuickBooksOptions {
  baseUrl: string;
  realmId: () => Promise<string>;
  tokens: TokenSource;
  minorVersion?: string;
  timeoutMs?: number;
}

interface FaultError {
  Message?: string;
  message?: string;
  Detail?: string;
  detail?: string;
  code?: string;
}

/** Intuit's error bodies come in two letter cases, so both are read. */
function readFault(body: unknown): { type: string; error: FaultError } | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const fault = (record.Fault ?? record.fault) as { Error?: FaultError[]; error?: FaultError[]; type?: string } | undefined;
  if (!fault) return null;
  const errors = fault.Error ?? fault.error ?? [];
  return { type: String(fault.type ?? ''), error: errors[0] ?? {} };
}

function failureFrom(status: number, body: unknown, headers: Headers, tid: string | null): QbFailure {
  const fault = readFault(body);
  const code = fault?.error.code ?? null;
  const message = String(fault?.error.Message ?? fault?.error.message ?? `HTTP ${status}`);
  const base = { ok: false as const, status, code, message, retryAfterMs: 0, tid };

  if (status === 401) return { ...base, kind: 'auth' };
  if (status === 403) return { ...base, kind: 'forbidden' };
  if (status === 429) return { ...base, kind: 'throttled', retryAfterMs: Number(headers.get('retry-after') ?? 0) * 1000 };
  if (code === '6240') return { ...base, kind: 'duplicate_name' };
  if (code === '6140') return { ...base, kind: 'duplicate_doc' };
  if (code === '600') return { ...base, kind: 'duplicate_request' };
  // A system fault or 5xx can't prove the write didn't happen, even inside an HTTP 200.
  if (status >= 500 || fault?.type === 'SystemFault' || fault === null) return { ...base, kind: 'unknown_outcome' };
  return { ...base, kind: 'validation' };
}

const escapeQueryValue = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export class QuickBooksClient {
  private readonly options: QuickBooksOptions & { minorVersion: string; timeoutMs: number };

  constructor(options: QuickBooksOptions) {
    this.options = { minorVersion: '75', timeoutMs: 30_000, ...options };
  }

  private async once<T>(method: string, path: string, body: unknown, token: string, params: Record<string, string>): Promise<QbResult<T>> {
    const realm = await this.options.realmId();
    const query = new URLSearchParams({ minorversion: this.options.minorVersion, ...params });
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v3/company/${realm}/${path}?${query}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return { ok: false, kind: 'unknown_outcome', status: null, code: null, message: `no response (${(error as Error).name})`, retryAfterMs: 0, tid: null };
    }
    const tid = res.headers.get('intuit_tid');
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    // Intuit documents that a 200 can carry a Fault, so a 200 alone doesn't mean success.
    if (res.ok && parsed !== undefined && !readFault(parsed)) return { ok: true, body: parsed as T, tid };
    return failureFrom(res.status, parsed, res.headers, tid);
  }

  private async request<T>(method: string, path: string, body?: unknown, params: Record<string, string> = {}): Promise<QbResult<T>> {
    const token = await this.options.tokens.accessToken();
    const first = await this.once<T>(method, path, body, token, params);
    if (first.ok || first.kind !== 'auth') return first;
    const fresh = await this.options.tokens.refresh(token);
    return this.once<T>(method, path, body, fresh, params);
  }

  private async queryRows(entity: string, where: string): Promise<QbResult<QbEntity[]>> {
    const res = await this.request<{ QueryResponse: Record<string, QbEntity[]> }>('GET', 'query', undefined, { query: `SELECT * FROM ${entity} WHERE ${where}` });
    if (!res.ok) return res;
    return { ok: true, body: res.body.QueryResponse?.[entity] ?? [], tid: res.tid };
  }

  findItemByName(name: string) {
    return this.queryRows('Item', `Name = '${escapeQueryValue(name)}'`);
  }

  /** Includes inactive customers: a hidden one still holds its name, and creating it again would fail. */
  findCustomerByDisplayName(name: string) {
    return this.queryRows('Customer', `DisplayName = '${escapeQueryValue(name)}' AND Active IN (true, false)`);
  }

  findInvoicesByDocNumber(docNumber: string) {
    return this.queryRows('Invoice', `DocNumber = '${escapeQueryValue(docNumber)}'`);
  }

  /** Every invoice whose number starts with this prefix. Used to look for duplicates afterwards. */
  findInvoicesByDocPrefix(prefix: string) {
    return this.queryRows('Invoice', `DocNumber LIKE '${escapeQueryValue(prefix)}%' MAXRESULTS 1000`);
  }

  async createCustomer(body: Record<string, unknown>, requestId: string): Promise<QbResult<QbEntity>> {
    const res = await this.request<{ Customer: QbEntity }>('POST', 'customer', body, { requestid: requestId });
    return res.ok ? { ok: true, body: res.body.Customer, tid: res.tid } : res;
  }

  async createInvoice(body: Record<string, unknown>, requestId: string): Promise<QbResult<QbEntity>> {
    const res = await this.request<{ Invoice: QbEntity }>('POST', 'invoice', body, { requestid: requestId });
    return res.ok ? { ok: true, body: res.body.Invoice, tid: res.tid } : res;
  }

  async getInvoice(id: string): Promise<QbResult<QbEntity>> {
    const res = await this.request<{ Invoice: QbEntity }>('GET', `invoice/${id}`);
    return res.ok ? { ok: true, body: res.body.Invoice, tid: res.tid } : res;
  }

  /** A cheap read that proves the connection works. */
  async companyName(): Promise<QbResult<string>> {
    const realm = await this.options.realmId();
    const res = await this.request<{ CompanyInfo: { CompanyName?: string } }>('GET', `companyinfo/${realm}`);
    return res.ok ? { ok: true, body: res.body.CompanyInfo?.CompanyName ?? '', tid: res.tid } : res;
  }
}
