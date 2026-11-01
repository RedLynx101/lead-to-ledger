// QuickBooks Online simulator, written from Intuit's developer docs.
//
// It covers the OAuth 2.0 flow and the Accounting API calls this repo makes.
// docs/simulator-sources.md lists where each behaviour came from and which are
// unverified. Milestone 4 checks it against the real sandbox.
//
// The behaviour that matters most is `requestid`. Intuit's docs say a repeated
// request ID returns the original response, and also list error 600 "Duplicate
// Request ID". Whether that holds for each record type is the question the real
// sandbox has to answer, so the simulator makes it a per-record-type setting and
// the restart tests run against all three modes:
//   replay           returns the first response (what the docs describe)
//   duplicate_error  answers Fault 600
//   ignored          creates a second record
//
// The same goes for DocNumber: by default it is not unique, so it can't stop a
// duplicate by itself. `rejectDuplicateDocNum` turns on error 6140.

import { randomBytes, randomUUID } from 'node:crypto';
import type { SimRequest, SimResponse, Vendor } from './harness.ts';

type RequestIdMode = 'replay' | 'duplicate_error' | 'ignored';
type WriteEntity = 'customer' | 'invoice';

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  redirectUris: string[];
  requestid: Record<WriteEntity, RequestIdMode>;
  /** Preferences.SalesFormsPrefs.CustomTxnNumbers */
  customTxnNumbers: boolean;
  rejectDuplicateDocNum: boolean;
  /**
   * How long a new record stays out of query results. Intuit's docs don't say a query
   * sees a write at once, and the worker's lookups depend on it, so it can be delayed.
   */
  queryLagMs: number;
  accessTokenTtlSeconds: number;
  /**
   * 'every_refresh' invalidates the old refresh token on each use, the harshest
   * reading of the docs. Intuit says the value changes every 24 hours and that a
   * second refresh with the same value returns invalid_grant.
   */
  refreshRotation: 'every_refresh' | 'after_24h';
  enforceRateLimits: boolean;
  /** Documented elsewhere as 500 requests per minute per realm; a secondary source, not re-verified. */
  rateLimitPerMinute: number;
}

const DEFAULT_CONFIG: QuickBooksConfig = {
  clientId: 'sim-client-id',
  clientSecret: 'sim-client-secret',
  realmId: '9130000000000001',
  redirectUris: ['http://localhost:8765/callback'],
  requestid: { customer: 'replay', invoice: 'replay' },
  customTxnNumbers: false,
  rejectDuplicateDocNum: false,
  queryLagMs: 0,
  accessTokenTtlSeconds: 3600,
  refreshRotation: 'every_refresh',
  enforceRateLimits: true,
  rateLimitPerMinute: 500,
};

type Entity = Record<string, unknown> & { Id: string; SyncToken: string; MetaData: { CreateTime: string; LastUpdatedTime: string } };

function timestamp(): string {
  // Intuit returns local time with an offset, for example 2026-07-24T10:33:39.11-07:00.
  const d = new Date(Date.now() - 7 * 3600_000);
  return `${d.toISOString().slice(0, 23)}-07:00`;
}

function fault(status: number, type: string, code: string, message: string, detail = '', element?: string): SimResponse {
  const error: Record<string, string> = { Message: message, Detail: detail, code };
  if (element) error.element = element;
  return { status, body: { Fault: { Error: [error], type }, time: timestamp() } };
}

function validationFault(code: string, message: string, detail = '', element?: string): SimResponse {
  return fault(400, 'ValidationFault', code, message, detail, element);
}

// Shapes below this line are from error text reported by other integrators, not
// Intuit's error page, which shows only the XML format. See simulator-sources.md.
function authFailure(detail: string): SimResponse {
  return {
    status: 401,
    body: {
      fault: {
        error: [{ message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', detail, code: '3200' }],
        type: 'AUTHENTICATION',
      },
      time: timestamp(),
    },
  };
}

function throttled(): SimResponse {
  return fault(429, 'ThrottleExceeded', '3001', 'message=ThrottleExceeded; errorCode=003001; statusCode=429', 'The request limit was reached.');
}

function systemFault(status: number): SimResponse {
  return fault(status, 'SystemFault', '10000', 'An application error has occurred while processing your request.', 'System Failure Error: simulated');
}

function gatewayPage(status: number): SimResponse {
  return {
    status,
    headers: { 'content-type': 'text/html' },
    body: `<html><head><title>${status}</title></head><body>Service temporarily unavailable</body></html>`,
  };
}

// ---- Query language -------------------------------------------------------

interface ParsedQuery {
  count: boolean;
  entity: string;
  where: Array<{ property: string; op: string; values: string[] }>;
  orderBy?: { property: string; descending: boolean };
  startPosition: number;
  maxResults: number;
}

function tokenize(input: string): string[] | undefined {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "'") {
      let value = '';
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else if (input[i] === "'") {
          closed = true;
          i += 1;
          break;
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (!closed) return undefined;
      tokens.push(`'${value}`);
    } else if ('(),*'.includes(ch)) {
      tokens.push(ch);
      i += 1;
    } else if ('<>='.includes(ch)) {
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=') {
        tokens.push(two);
        i += 2;
      } else {
        tokens.push(ch);
        i += 1;
      }
    } else {
      let word = '';
      while (i < input.length && !/[\s(),*<>=']/.test(input[i])) {
        word += input[i];
        i += 1;
      }
      tokens.push(word);
    }
  }
  return tokens;
}

function parseQuery(text: string): ParsedQuery | string {
  const tokens = tokenize(text);
  if (!tokens) return 'Unterminated string';
  let pos = 0;
  const peek = () => tokens[pos]?.toUpperCase();
  const next = () => tokens[pos++];
  const literal = (t: string | undefined) => (t?.startsWith("'") ? t.slice(1) : t);

  if (peek() !== 'SELECT') return "Expected 'select'";
  next();
  let count = false;
  if (peek() === '*') {
    next();
  } else if (peek() === 'COUNT') {
    next();
    if (next() !== '(' || next() !== '*' || next() !== ')') return 'Malformed count(*)';
    count = true;
  } else {
    return 'Projections are not supported';
  }
  if (peek() !== 'FROM') return "Expected 'from'";
  next();
  const entity = next();
  if (!entity) return 'Missing entity name';

  const where: ParsedQuery['where'] = [];
  if (peek() === 'WHERE') {
    next();
    for (;;) {
      const property = next();
      const op = next()?.toUpperCase();
      if (!property || !op) return 'Malformed where clause';
      if (!['=', '<', '>', '<=', '>=', 'LIKE', 'IN'].includes(op)) return `Unsupported operator: ${op}`;
      if (op === 'IN') {
        if (next() !== '(') return 'Expected ( after IN';
        const values: string[] = [];
        for (;;) {
          const v = next();
          if (v === undefined) return 'Unterminated IN list';
          values.push(literal(v)!);
          const sep = next();
          if (sep === ')') break;
          if (sep !== ',') return 'Malformed IN list';
        }
        where.push({ property, op, values });
      } else {
        const v = next();
        if (v === undefined) return 'Missing value';
        where.push({ property, op, values: [literal(v)!] });
      }
      if (peek() === 'AND') {
        next();
        continue;
      }
      if (peek() === 'OR') return 'OR is not supported';
      break;
    }
  }

  let orderBy: ParsedQuery['orderBy'];
  if (peek() === 'ORDERBY') {
    next();
    const property = next();
    if (!property) return 'Malformed orderby';
    let descending = false;
    if (peek() === 'DESC' || peek() === 'ASC') descending = next().toUpperCase() === 'DESC';
    orderBy = { property, descending };
  }
  let startPosition = 1;
  let maxResults = 100;
  while (peek() === 'STARTPOSITION' || peek() === 'MAXRESULTS') {
    const key = next().toUpperCase();
    const value = Number(next());
    if (!Number.isInteger(value) || value < 1) return `${key} must be a positive integer`;
    if (key === 'STARTPOSITION') startPosition = value;
    else maxResults = Math.min(value, 1000);
  }
  if (pos < tokens.length) return `Unexpected token: ${tokens[pos]}`;
  return { count, entity, where, orderBy, startPosition, maxResults };
}

/** Case-insensitive attribute lookup with dotted paths and reference unwrapping. */
function readAttribute(entity: Record<string, unknown>, path: string): string | undefined {
  let current: unknown = entity;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    const key = Object.keys(current).find((k) => k.toLowerCase() === part.toLowerCase());
    if (!key) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (current !== null && typeof current === 'object') {
    const ref = current as Record<string, unknown>;
    if ('value' in ref) return String(ref.value);
    if ('Address' in ref) return String(ref.Address);
    return undefined;
  }
  return current === undefined || current === null ? undefined : String(current);
}

function matches(actual: string | undefined, op: string, values: string[]): boolean {
  if (actual === undefined) return false;
  // Attribute values are not case sensitive in the query language.
  const a = actual.toLowerCase();
  const v = values.map((x) => x.toLowerCase());
  const ordered = (cmp: (n: number) => boolean) => {
    const x = Number(a);
    const y = Number(v[0]);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return cmp(x - y);
    return cmp(a < v[0] ? -1 : a > v[0] ? 1 : 0);
  };
  switch (op) {
    case '=':
      return a === v[0];
    case 'IN':
      return v.includes(a);
    case '<':
      return ordered((n) => n < 0);
    case '>':
      return ordered((n) => n > 0);
    case '<=':
      return ordered((n) => n <= 0);
    case '>=':
      return ordered((n) => n >= 0);
    case 'LIKE': {
      const pattern = v[0].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
      return new RegExp(`^${pattern}$`).test(a);
    }
    default:
      return false;
  }
}

// ---- The simulator --------------------------------------------------------

export interface QuickBooksVendor extends Vendor {
  /** Exposed so a test can read the current configuration without going over HTTP. */
  readonly config: QuickBooksConfig;
}

export function createQuickBooksSim(overrides: Partial<QuickBooksConfig> = {}): QuickBooksVendor {
  const config: QuickBooksConfig = { ...structuredClone(DEFAULT_CONFIG), ...overrides };

  let customers = new Map<string, Entity>();
  let invoices = new Map<string, Entity>();
  let items = new Map<string, Entity>();
  let requestIds = new Map<string, SimResponse>();
  let requestIdHits = 0;
  let nextId = 1;
  let nextDocNumber = 1001;
  let codes = new Map<string, { redirectUri: string; used: boolean }>();
  let refreshTokens = new Map<string, { issuedAt: number; valid: boolean }>();
  let accessTokens = new Map<string, number>();
  let tokensForcedExpired = false;
  let hits: number[] = [];
  const visibleToQueryAt = new WeakMap<object, number>();

  function makeEntity<T extends Record<string, unknown>>(fields: T): Entity & T {
    const now = timestamp();
    const entity = {
      ...fields,
      domain: 'QBO',
      sparse: false,
      Id: String(nextId++),
      SyncToken: '0',
      MetaData: { CreateTime: now, LastUpdatedTime: now },
    };
    visibleToQueryAt.set(entity, Date.now() + config.queryLagMs);
    return entity;
  }

  function seed(): void {
    const item = makeEntity({
      Name: 'Services',
      FullyQualifiedName: 'Services',
      Active: true,
      Type: 'Service',
      UnitPrice: 0,
      IncomeAccountRef: { value: '1', name: 'Services' },
    });
    items.set(item.Id, item);
    // Sample data ships with a sandbox company, so the sim seeds a record too.
    // A duplicate count that assumes an empty company would be wrong.
    const sample = makeEntity({
      DisplayName: 'Sample Customer (seed data)',
      FullyQualifiedName: 'Sample Customer (seed data)',
      Active: true,
      Balance: 0,
      BalanceWithJobs: 0,
      CurrencyRef: { value: 'USD', name: 'United States Dollar' },
      PreferredDeliveryMethod: 'Print',
      Job: false,
      BillWithParent: false,
      Taxable: false,
    });
    customers.set(sample.Id, sample);
  }
  seed();

  function issueTokens(existingRefresh?: string): Record<string, unknown> {
    const access = `sim_at_${randomBytes(24).toString('hex')}`;
    accessTokens.set(access, Date.now() + config.accessTokenTtlSeconds * 1000);
    let refresh = existingRefresh;
    if (!refresh) {
      refresh = `sim_rt_${randomBytes(24).toString('hex')}`;
      refreshTokens.set(refresh, { issuedAt: Date.now(), valid: true });
    }
    return {
      token_type: 'bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refresh,
      x_refresh_token_expires_in: 8_640_000,
      access_token: access,
    };
  }

  function basicAuthOk(req: SimRequest): boolean {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded === `${config.clientId}:${config.clientSecret}`;
  }

  function handleConnect(req: SimRequest): SimResponse {
    const q = req.query;
    if (q.get('client_id') !== config.clientId) {
      return { status: 400, body: { error: 'invalid_client', error_description: 'Unknown client_id' } };
    }
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!config.redirectUris.includes(redirectUri)) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'redirect_uri is not registered for this app' } };
    }
    if (q.get('response_type') !== 'code' || !q.get('state')) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'response_type=code and state are required' } };
    }
    const target = new URL(redirectUri);
    target.searchParams.set('state', q.get('state')!);
    if (!(q.get('scope') ?? '').split(' ').includes('com.intuit.quickbooks.accounting')) {
      target.searchParams.set('error', 'invalid_scope');
    } else if (q.get('sim_consent') === 'deny') {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = `sim_code_${randomBytes(16).toString('hex')}`;
      codes.set(code, { redirectUri, used: false });
      target.searchParams.set('code', code);
      target.searchParams.set('realmId', config.realmId);
    }
    return { status: 302, headers: { location: target.toString() } };
  }

  function handleToken(req: SimRequest): SimResponse {
    if (!basicAuthOk(req)) return { status: 401, body: { error: 'invalid_client' } };
    const form = new URLSearchParams(req.rawBody);
    const grant = form.get('grant_type');

    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const stored = codes.get(code);
      if (!stored || stored.redirectUri !== form.get('redirect_uri')) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Unknown code or mismatched redirect_uri' } };
      }
      if (stored.used) {
        // Docs: a second exchange returns invalid_grant and may revoke what the first one issued.
        for (const entry of refreshTokens.values()) entry.valid = false;
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Code already used' } };
      }
      stored.used = true;
      return { status: 200, wrote: true, body: issueTokens() };
    }

    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const entry = refreshTokens.get(presented);
      if (!entry || !entry.valid) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Incorrect or invalid refresh token' } };
      }
      const rotate = config.refreshRotation === 'every_refresh' || Date.now() - entry.issuedAt > 24 * 3600_000;
      if (rotate) entry.valid = false;
      tokensForcedExpired = false;
      return { status: 200, wrote: true, body: issueTokens(rotate ? undefined : presented) };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  function validateNameFields(body: Record<string, unknown>): SimResponse | undefined {
    for (const name of ['DisplayName', 'Title', 'GivenName', 'MiddleName', 'FamilyName', 'Suffix']) {
      const value = body[name];
      if (typeof value === 'string' && /[:\t\n]/.test(value)) {
        return validationFault('2040', 'Invalid String', `${name} must not contain a colon, tab or newline`, name);
      }
    }
    if (typeof body.DisplayName === 'string' && body.DisplayName.length > 500) {
      return validationFault('2050', 'Invalid String Length', 'DisplayName: maximum of 500 chars', 'DisplayName');
    }
    return undefined;
  }

  function createCustomer(body: Record<string, unknown>): SimResponse {
    const invalid = validateNameFields(body);
    if (invalid) return invalid;
    const parts = ['Title', 'GivenName', 'MiddleName', 'FamilyName', 'Suffix'].map((k) => body[k]).filter(Boolean);
    const displayName = (body.DisplayName as string | undefined) ?? parts.join(' ');
    if (!displayName) {
      return validationFault('6080', 'No Name Provided', 'DisplayName or a name component is required');
    }
    const email = (body.PrimaryEmailAddr as { Address?: string } | undefined)?.Address;
    if (email !== undefined && !(email.includes('@') && email.includes('.'))) {
      return validationFault('2210', 'Invalid Email Address Format', `Supplied value: ${email}`, 'PrimaryEmailAddr');
    }
    const clash = [...customers.values()].find((c) => String(c.DisplayName).toLowerCase() === displayName.toLowerCase());
    if (clash) {
      return validationFault('6240', 'Duplicate Name Exists Error', `The name supplied already exists. The customer ID is: ${clash.Id}`);
    }
    const customer = makeEntity({
      ...body,
      DisplayName: displayName,
      FullyQualifiedName: displayName,
      Active: true,
      Balance: 0,
      BalanceWithJobs: 0,
      CurrencyRef: { value: 'USD', name: 'United States Dollar' },
      PreferredDeliveryMethod: 'Print',
      Job: false,
      BillWithParent: false,
      Taxable: true,
    });
    customers.set(customer.Id, customer);
    return { status: 200, wrote: true, body: { Customer: customer, time: timestamp() } };
  }

  function createInvoice(body: Record<string, unknown>, req: SimRequest): SimResponse {
    const customerRef = body.CustomerRef as { value?: string } | undefined;
    if (!customerRef?.value) {
      return validationFault('2020', 'Required param missing, need to supply the required value for the API', 'Required parameter CustomerRef is missing in the request', 'CustomerRef');
    }
    const customer = customers.get(String(customerRef.value));
    if (!customer) return validationFault('2500', 'Invalid Reference Id', `Invalid Reference Id: CustomerRef ${customerRef.value}`, 'CustomerRef');
    if (customer.Active === false) return validationFault('6250', 'InvalidSalesCustomer', `The specified customer (${customer.Id}) is inactive`);

    const lines = body.Line as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(lines) || lines.length === 0) {
      return validationFault('2020', 'Required param missing, need to supply the required value for the API', 'Required parameter Line is missing in the request', 'Line');
    }
    let total = 0;
    const outLines: Array<Record<string, unknown>> = [];
    for (const [index, line] of lines.entries()) {
      const amount = Number(line.Amount);
      if (Number.isNaN(amount)) return validationFault('2140', 'Invalid Amount', 'Line.Amount is required');
      if (amount < 0) return validationFault('2290', 'NegativeAmount', 'Negative amounts are not supported on transaction lines');
      if (line.DetailType !== 'SalesItemLineDetail') {
        return validationFault('2170', 'Invalid Enumeration', 'This simulator only accepts SalesItemLineDetail lines');
      }
      const detail = (line.SalesItemLineDetail ?? {}) as { ItemRef?: { value?: string; name?: string }; Qty?: number; UnitPrice?: number };
      const itemId = detail.ItemRef?.value;
      const item = itemId ? items.get(String(itemId)) : undefined;
      if (!item) return validationFault('2500', 'Invalid Reference Id', `Invalid Reference Id: ItemRef ${itemId}`, 'ItemRef');
      if (detail.Qty !== undefined && detail.UnitPrice !== undefined && Math.abs(detail.Qty * detail.UnitPrice - amount) > 0.005) {
        return validationFault('6070', 'Amount calculation incorrect in the request', `The amount isn't equal to Qty * UnitPrice. Supplied value: ${amount}`);
      }
      total += amount;
      outLines.push({
        ...line,
        Id: String(index + 1),
        LineNum: index + 1,
        SalesItemLineDetail: { TaxCodeRef: { value: 'NON' }, ...detail, ItemRef: { name: item.Name, value: item.Id } },
      });
    }
    outLines.push({ DetailType: 'SubTotalLineDetail', Amount: total, SubTotalLineDetail: {} });

    let docNumber = body.DocNumber as string | undefined;
    if (docNumber !== undefined) {
      if (String(docNumber).length > 21) {
        return validationFault('2050', 'Invalid String Length', 'DocNumber: maximum of 21 chars', 'DocNumber');
      }
      const allowDuplicate = (req.query.get('include') ?? '').split(',').includes('allowduplicatedocnum');
      if (config.rejectDuplicateDocNum && !allowDuplicate) {
        const clash = [...invoices.values()].some((i) => i.DocNumber === docNumber);
        if (clash) return validationFault('6140', 'Duplicate Doc Num', 'The specified number is already in use. Specify a different number.');
      }
    } else if (!config.customTxnNumbers) {
      docNumber = String(nextDocNumber++);
    }

    const txnDate = (body.TxnDate as string | undefined) ?? timestamp().slice(0, 10);
    const due = new Date(`${txnDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    const invoice = makeEntity({
      ...body,
      TxnDate: txnDate,
      DueDate: (body.DueDate as string | undefined) ?? due.toISOString().slice(0, 10),
      DocNumber: docNumber,
      Line: outLines,
      TotalAmt: total,
      Balance: total,
      Deposit: 0,
      CustomerRef: { value: customer.Id, name: customer.DisplayName },
      TxnTaxDetail: { TotalTax: 0 },
      LinkedTxn: [],
      PrintStatus: 'NeedToPrint',
      EmailStatus: 'NotSet',
      ApplyTaxAfterDiscount: false,
    });
    if (docNumber === undefined) delete (invoice as Record<string, unknown>).DocNumber;
    invoices.set(invoice.Id, invoice);
    customer.Balance = Number(customer.Balance) + total;
    customer.BalanceWithJobs = Number(customer.BalanceWithJobs) + total;
    return { status: 200, wrote: true, body: { Invoice: invoice, time: timestamp() } };
  }

  function sparseUpdate(store: Map<string, Entity>, label: string, body: Record<string, unknown>): SimResponse {
    const existing = store.get(String(body.Id));
    if (!existing) return validationFault('610', 'Object Not Found', `Object Not Found: ${label} ${body.Id}`);
    if (String(body.SyncToken) !== existing.SyncToken) {
      return validationFault('5010', 'Stale Object', `Stale object: ${label} ${body.Id}`);
    }
    const { Id: _id, SyncToken: _sync, MetaData: _meta, sparse: _sparse, ...rest } = body;
    Object.assign(existing, rest);
    existing.SyncToken = String(Number(existing.SyncToken) + 1);
    existing.MetaData = { ...existing.MetaData, LastUpdatedTime: timestamp() };
    return { status: 200, wrote: true, body: { [label]: existing, time: timestamp() } };
  }

  function handleWrite(entity: WriteEntity, req: SimRequest): SimResponse {
    if (req.jsonInvalid || req.json === undefined || typeof req.json !== 'object') {
      return validationFault('2000', 'Request has invalid or unsupported property', 'The request body could not be parsed');
    }
    const requestId = req.query.get('requestid');
    if (requestId !== null && (requestId.length === 0 || requestId.length > 50)) {
      return validationFault('2130', 'Invalid Request Id Format', 'requestid must be 1 to 50 characters');
    }
    const key = requestId ? `${config.realmId}:${requestId}` : undefined;
    const mode = config.requestid[entity];
    if (key && mode !== 'ignored' && requestIds.has(key)) {
      requestIdHits += 1;
      if (mode === 'duplicate_error') {
        return validationFault('600', 'Duplicate Request ID', 'The request ID you are trying to use already exists.');
      }
      return { ...structuredClone(requestIds.get(key)!), wrote: false, replayed: true };
    }

    const body = req.json as Record<string, unknown>;
    const label = entity === 'customer' ? 'Customer' : 'Invoice';
    const store = entity === 'customer' ? customers : invoices;
    let out: SimResponse;
    if (body.Id !== undefined) out = sparseUpdate(store, label, body);
    else out = entity === 'customer' ? createCustomer(body) : createInvoice(body, req);

    // Only successes are remembered. Whether Intuit also replays a failed attempt is unverified.
    if (key && out.status === 200) requestIds.set(key, structuredClone(out));
    return out;
  }

  function handleQuery(text: string): SimResponse {
    const parsed = parseQuery(text);
    if (typeof parsed === 'string') {
      return validationFault('4000', 'Error parsing query', `QueryParserError: ${parsed}`);
    }
    const stores: Record<string, Map<string, Entity>> = { customer: customers, invoice: invoices, item: items };
    const store = stores[parsed.entity.toLowerCase()];
    if (!store) return validationFault('4001', 'Invalid query', `QueryValidationError: unsupported entity ${parsed.entity}`);
    const now = Date.now();
    let rows = [...store.values()].filter((row) => (visibleToQueryAt.get(row) ?? 0) <= now && parsed.where.every((w) => matches(readAttribute(row, w.property), w.op, w.values)));
    if (parsed.count) return { status: 200, body: { QueryResponse: { totalCount: rows.length }, time: timestamp() } };
    if (parsed.orderBy) {
      const { property, descending } = parsed.orderBy;
      rows = rows.sort((a, b) => {
        const x = readAttribute(a, property) ?? '';
        const y = readAttribute(b, property) ?? '';
        const c = x < y ? -1 : x > y ? 1 : 0;
        return descending ? -c : c;
      });
    }
    const total = rows.length;
    const page = rows.slice(parsed.startPosition - 1, parsed.startPosition - 1 + parsed.maxResults);
    if (page.length === 0) return { status: 200, body: { QueryResponse: {}, time: timestamp() } };
    const name = parsed.entity[0].toUpperCase() + parsed.entity.slice(1).toLowerCase();
    return {
      status: 200,
      body: { QueryResponse: { [name]: page, startPosition: parsed.startPosition, maxResults: page.length, totalCount: total }, time: timestamp() },
    };
  }

  function handleApi(req: SimRequest, parts: string[]): SimResponse {
    const [resource, id] = parts;
    if (resource === 'query') {
      if (req.method === 'GET') return handleQuery(req.query.get('query') ?? '');
      if (req.method === 'POST') return handleQuery(req.rawBody);
    }
    if (resource === 'customer' || resource === 'invoice' || resource === 'item') {
      if (req.method === 'POST' && !id && resource !== 'item') return handleWrite(resource, req);
      if (req.method === 'GET' && id) {
        const store = resource === 'customer' ? customers : resource === 'invoice' ? invoices : items;
        const found = store.get(id);
        if (!found) return validationFault('610', 'Object Not Found', `Object Not Found: ${resource} ${id}`);
        const label = resource[0].toUpperCase() + resource.slice(1);
        return { status: 200, body: { [label]: found, time: timestamp() } };
      }
    }
    if (resource === 'preferences' && req.method === 'GET') {
      return {
        status: 200,
        body: {
          Preferences: {
            Id: '1',
            SyncToken: '0',
            SalesFormsPrefs: { CustomTxnNumbers: config.customTxnNumbers, AllowDeposit: true },
          },
          time: timestamp(),
        },
      };
    }
    if (resource === 'companyinfo' && req.method === 'GET') {
      return {
        status: 200,
        body: { CompanyInfo: { Id: '1', SyncToken: '0', CompanyName: 'Simulated Sandbox Company', Country: 'US' }, time: timestamp() },
      };
    }
    return fault(404, 'ValidationFault', '2000', 'Invalid or unsupported object name', `No route for ${req.method} ${req.path}`);
  }

  const vendor: QuickBooksVendor = {
    name: 'quickbooks',
    config,

    handle(req) {
      if (req.path === '/connect/oauth2' && req.method === 'GET') return handleConnect(req);
      if (req.path === '/oauth2/v1/tokens/bearer' && req.method === 'POST') return handleToken(req);
      if (req.path === '/v2/oauth2/tokens/revoke' && req.method === 'POST') {
        if (!basicAuthOk(req)) return { status: 401, body: { error: 'invalid_client' } };
        const token = ((req.json as { token?: string } | undefined)?.token ?? new URLSearchParams(req.rawBody).get('token')) as string | null;
        if (token) {
          accessTokens.delete(token);
          const entry = refreshTokens.get(token);
          if (entry) entry.valid = false;
        }
        return { status: 200, wrote: true };
      }
      if (req.path === '/.well-known/openid_sandbox_configuration') {
        const host = String(req.headers.host ?? 'localhost');
        return {
          status: 200,
          body: {
            issuer: `http://${host}`,
            authorization_endpoint: `http://${host}/connect/oauth2`,
            token_endpoint: `http://${host}/oauth2/v1/tokens/bearer`,
            revocation_endpoint: `http://${host}/v2/oauth2/tokens/revoke`,
          },
        };
      }

      const m = req.path.match(/^\/v3\/company\/([^/]+)\/(.+)$/);
      if (!m) return fault(404, 'ValidationFault', '2000', 'Invalid or unsupported object name', `No route for ${req.method} ${req.path}`);

      const auth = String(req.headers.authorization ?? '');
      if (!/^bearer /i.test(auth)) return authFailure('Token invalid');
      const expires = accessTokens.get(auth.slice(7));
      if (expires === undefined) return authFailure('Token invalid');
      if (tokensForcedExpired || Date.now() > expires) return authFailure('Token expired');

      if (m[1] !== config.realmId) {
        return fault(403, 'AuthorizationFault', '3100', 'Authorization Failure', 'This token is not authorized for that company');
      }

      if (config.enforceRateLimits) {
        const now = Date.now();
        hits = hits.filter((t) => now - t < 60_000);
        if (hits.length >= config.rateLimitPerMinute) return throttled();
        hits.push(now);
      }

      const out = handleApi(req, m[2].split('/').filter(Boolean));
      // The API answers XML unless the caller asks for JSON. A client that forgets
      // the Accept header should fail here rather than in the real sandbox.
      if (!String(req.headers.accept ?? '').includes('json')) {
        return {
          ...out,
          headers: { ...(out.headers ?? {}), 'content-type': 'application/xml' },
          body: `<IntuitResponse xmlns="http://schema.intuit.com/finance/v3" time="${timestamp()}"><Note>simulated XML body: send Accept: application/json</Note></IntuitResponse>`,
        };
      }
      out.headers = { ...(out.headers ?? {}), intuit_tid: `sim-${randomUUID()}` };
      return out;
    },

    errorFor(status) {
      if (status === 429) return throttled();
      if (status === 401) return authFailure('Token expired');
      if (status === 403) return fault(403, 'AuthorizationFault', '3100', 'Authorization Failure', 'Insufficient scope');
      if (status === 502 || status === 503 || status === 504) return gatewayPage(status);
      if (status >= 500) return systemFault(status);
      return validationFault('2000', 'Injected validation fault');
    },

    fault200() {
      return systemFault(200);
    },

    expireToken() {
      tokensForcedExpired = true;
    },
    restoreToken() {
      tokensForcedExpired = false;
    },

    snapshot() {
      return {
        customers: [...customers.values()],
        invoices: [...invoices.values()],
        items: [...items.values()],
        requestIdsStored: requestIds.size,
        requestIdHits,
      };
    },

    reset() {
      customers = new Map();
      invoices = new Map();
      items = new Map();
      requestIds = new Map();
      requestIdHits = 0;
      nextId = 1;
      nextDocNumber = 1001;
      codes = new Map();
      refreshTokens = new Map();
      accessTokens = new Map();
      tokensForcedExpired = false;
      hits = [];
      Object.assign(config, structuredClone(DEFAULT_CONFIG), overrides);
      seed();
    },

    configure(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'requestid') Object.assign(config.requestid, value);
        else (config as unknown as Record<string, unknown>)[key] = value;
      }
      const { clientSecret: _secret, ...visible } = config;
      return visible as unknown as Record<string, unknown>;
    },
  };

  return vendor;
}
