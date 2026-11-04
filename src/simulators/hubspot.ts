// HubSpot CRM simulator, written from HubSpot's developer docs.
//
// It covers only what this repo calls. docs/simulator-sources.md lists where
// each behaviour came from and which ones are guesses. A simulator only proves
// the code matches a reading of the docs, so milestone 4 checks it against
// responses saved from a real HubSpot test account.
//
// Behaviours chosen because they break naive integrations:
// - No idempotency key exists. Duplicate email is a 409; batch upsert by email
//   is the closest thing to a safe retry.
// - Search reads a lagging index ("It may take a few moments for newly created
//   or updated CRM objects to appear in search results"), so search-before-create
//   can miss a record that was committed a moment ago.
// - Search has its own stricter rate limit and no rate limit headers.

import { randomUUID } from 'node:crypto';
import type { SimRequest, SimResponse, Vendor } from './harness.ts';

type ObjectType = 'contacts' | 'deals';

interface PropertyDef {
  name: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'enumeration' | 'bool';
  fieldType: string;
  groupName: string;
  options?: Array<{ label: string; value: string; displayOrder?: number; hidden?: boolean }>;
  hasUniqueValue?: boolean;
  readOnlyValue?: boolean;
  description?: string;
  hubspotDefined?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface CrmRecord {
  id: string;
  type: ObjectType;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** The copy that search sees. Writes reach it after `searchLagMs`. */
  indexed: Record<string, string | null> | null;
  indexQueue: Array<{ at: number; snapshot: Record<string, string | null> }>;
}

export interface HubSpotConfig {
  token: string;
  /** How long a write takes to become visible to search. HubSpot publishes no number. */
  searchLagMs: number;
  enforceRateLimits: boolean;
  /** Free and Starter private-app limit: 100 requests per 10 seconds. */
  rateLimitPer10s: number;
  /** Search API limit: 5 requests per second per account. */
  searchLimitPerSecond: number;
}

const DEFAULT_CONFIG: HubSpotConfig = {
  token: 'sim-hubspot-token',
  searchLagMs: 1500,
  enforceRateLimits: true,
  rateLimitPer10s: 100,
  searchLimitPerSecond: 5,
};

const CONTACT_DEFAULTS = ['createdate', 'email', 'firstname', 'hs_object_id', 'lastmodifieddate', 'lastname'];
const DEAL_DEFAULTS = ['amount', 'closedate', 'createdate', 'dealname', 'dealstage', 'hs_lastmodifieddate', 'hs_object_id', 'pipeline'];

const STAGES = [
  ['appointmentscheduled', 'Appointment Scheduled', '0.2', 'false'],
  ['qualifiedtobuy', 'Qualified To Buy', '0.4', 'false'],
  ['presentationscheduled', 'Presentation Scheduled', '0.6', 'false'],
  ['decisionmakerboughtin', 'Decision Maker Bought-In', '0.8', 'false'],
  ['contractsent', 'Contract Sent', '0.9', 'false'],
  ['closedwon', 'Closed Won', '1.0', 'true'],
  ['closedlost', 'Closed Lost', '0.0', 'true'],
] as const;

function seedProperties(): Map<ObjectType, Map<string, PropertyDef>> {
  const str = (name: string, groupName: string, fieldType = 'text'): PropertyDef => ({
    name,
    label: name,
    type: 'string',
    fieldType,
    groupName,
    hubspotDefined: true,
  });
  const readOnlyDate = (name: string, groupName: string): PropertyDef => ({
    name,
    label: name,
    type: 'datetime',
    fieldType: 'date',
    groupName,
    hubspotDefined: true,
    readOnlyValue: true,
  });
  const contacts: PropertyDef[] = [
    str('email', 'contactinformation'),
    str('firstname', 'contactinformation'),
    str('lastname', 'contactinformation'),
    str('phone', 'contactinformation', 'phonenumber'),
    str('company', 'contactinformation'),
    str('website', 'contactinformation'),
    str('jobtitle', 'contactinformation'),
    str('city', 'contactinformation'),
    str('state', 'contactinformation'),
    str('message', 'contactinformation', 'textarea'),
    {
      name: 'lifecyclestage',
      label: 'Lifecycle Stage',
      type: 'enumeration',
      fieldType: 'radio',
      groupName: 'contactinformation',
      hubspotDefined: true,
      options: ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other'].map(
        (value) => ({ label: value, value }),
      ),
    },
    {
      name: 'hs_lead_status',
      label: 'Lead Status',
      type: 'enumeration',
      fieldType: 'radio',
      groupName: 'contactinformation',
      hubspotDefined: true,
      options: ['NEW', 'OPEN', 'IN_PROGRESS', 'OPEN_DEAL', 'UNQUALIFIED', 'ATTEMPTED_TO_CONTACT', 'CONNECTED', 'BAD_TIMING'].map((value) => ({
        label: value,
        value,
      })),
    },
    str('hubspot_owner_id', 'contactinformation'),
    { ...str('hs_object_id', 'contactinformation'), readOnlyValue: true },
    readOnlyDate('createdate', 'contactinformation'),
    readOnlyDate('lastmodifieddate', 'contactinformation'),
  ];
  const deals: PropertyDef[] = [
    str('dealname', 'dealinformation'),
    {
      name: 'dealstage',
      label: 'Deal Stage',
      type: 'enumeration',
      fieldType: 'radio',
      groupName: 'dealinformation',
      hubspotDefined: true,
      options: STAGES.map(([value, label]) => ({ label, value })),
    },
    str('pipeline', 'dealinformation'),
    { name: 'amount', label: 'Amount', type: 'number', fieldType: 'number', groupName: 'dealinformation', hubspotDefined: true },
    { name: 'closedate', label: 'Close Date', type: 'datetime', fieldType: 'date', groupName: 'dealinformation', hubspotDefined: true },
    str('description', 'dealinformation', 'textarea'),
    str('hubspot_owner_id', 'dealinformation'),
    { ...str('hs_object_id', 'dealinformation'), readOnlyValue: true },
    readOnlyDate('createdate', 'dealinformation'),
    readOnlyDate('hs_lastmodifieddate', 'dealinformation'),
  ];
  return new Map<ObjectType, Map<string, PropertyDef>>([
    ['contacts', new Map(contacts.map((p) => [p.name, p]))],
    ['deals', new Map(deals.map((p) => [p.name, p]))],
  ]);
}

function hsError(status: number, category: string, message: string, extra: Record<string, unknown> = {}): SimResponse {
  return { status, body: { status: 'error', message, correlationId: randomUUID(), category, ...extra } };
}

function validationError(failures: Array<{ name: string; code: string; message: string }>): SimResponse {
  const detail = failures.map((f) => ({
    isValid: false,
    message: f.message,
    error: f.code,
    name: f.name,
    details: [],
  }));
  return hsError(400, 'VALIDATION_ERROR', `Property values were not valid: ${JSON.stringify(detail)}`, {
    errors: failures.map((f) => ({ message: f.message, code: f.code, context: { propertyName: [f.name] } })),
  });
}

function asType(name: string): ObjectType | undefined {
  if (name === 'contacts' || name === '0-1' || name === 'contact') return 'contacts';
  if (name === 'deals' || name === '0-3' || name === 'deal') return 'deals';
  return undefined;
}

function compare(actual: string | null | undefined, op: string, wanted: string | undefined, values: string[] | undefined, high: string | undefined): boolean {
  const has = actual !== null && actual !== undefined && actual !== '';
  if (op === 'HAS_PROPERTY') return has;
  if (op === 'NOT_HAS_PROPERTY') return !has;
  if (!has && op !== 'NEQ' && op !== 'NOT_IN' && op !== 'NOT_CONTAINS_TOKEN') return false;

  const a = String(actual ?? '').toLowerCase();
  const norm = (v: string | undefined) => String(v ?? '').toLowerCase();
  const num = (v: string): number => {
    const n = Number(v);
    return Number.isNaN(n) ? Date.parse(v) : n;
  };
  const ordered = (cmp: (x: number, y: number) => boolean, v: string | undefined) => {
    const x = num(a);
    const y = num(norm(v));
    return !Number.isNaN(x) && !Number.isNaN(y) && cmp(x, y);
  };

  switch (op) {
    case 'EQ':
      return a === norm(wanted);
    case 'NEQ':
      return a !== norm(wanted);
    case 'GT':
      return ordered((x, y) => x > y, wanted);
    case 'GTE':
      return ordered((x, y) => x >= y, wanted);
    case 'LT':
      return ordered((x, y) => x < y, wanted);
    case 'LTE':
      return ordered((x, y) => x <= y, wanted);
    case 'BETWEEN':
      return ordered((x, y) => x >= y, wanted) && ordered((x, y) => x <= y, high);
    case 'IN':
      return (values ?? []).map(norm).includes(a);
    case 'NOT_IN':
      return !(values ?? []).map(norm).includes(a);
    case 'CONTAINS_TOKEN':
      return a.split(/\W+/).includes(norm(wanted).replace(/\*/g, ''));
    case 'NOT_CONTAINS_TOKEN':
      return !a.split(/\W+/).includes(norm(wanted).replace(/\*/g, ''));
    default:
      return false;
  }
}

export function createHubSpotSim(overrides: Partial<HubSpotConfig> = {}): Vendor {
  const config: HubSpotConfig = { ...DEFAULT_CONFIG, ...overrides };
  let properties = seedProperties();
  let groups = new Map<ObjectType, Set<string>>([
    ['contacts', new Set(['contactinformation'])],
    ['deals', new Set(['dealinformation'])],
  ]);
  let records = new Map<string, CrmRecord>();
  // Stored as "deals:1" -> {"contacts:2"} in both directions.
  let associations = new Map<string, Set<string>>();
  let nextId = 10_001;
  let tokenExpired = false;
  let generalHits: number[] = [];
  let searchHits: number[] = [];
  /** Every property name written, per record. Used to prove what the AI step did not touch. */
  let writeLog: Array<{ type: ObjectType; id: string; properties: string[]; at: string }> = [];

  const nowIso = () => new Date().toISOString();

  function live(type: ObjectType): CrmRecord[] {
    return [...records.values()].filter((r) => r.type === type && !r.archived);
  }

  function queueIndex(record: CrmRecord): void {
    const snapshot = { ...record.properties };
    if (config.searchLagMs <= 0) {
      record.indexed = snapshot;
      record.indexQueue = [];
      return;
    }
    record.indexQueue.push({ at: Date.now() + config.searchLagMs, snapshot });
  }

  function flushIndex(record: CrmRecord): void {
    const now = Date.now();
    while (record.indexQueue.length > 0 && record.indexQueue[0].at <= now) {
      record.indexed = record.indexQueue.shift()!.snapshot;
    }
  }

  function checkProperties(type: ObjectType, input: Record<string, unknown>, recordId?: string): SimResponse | undefined {
    const defs = properties.get(type)!;
    const failures: Array<{ name: string; code: string; message: string }> = [];
    for (const [name, raw] of Object.entries(input)) {
      const def = defs.get(name);
      if (!def) {
        failures.push({ name, code: 'PROPERTY_DOESNT_EXIST', message: `Property "${name}" does not exist` });
        continue;
      }
      if (def.readOnlyValue) {
        failures.push({ name, code: 'READ_ONLY_VALUE', message: `${name} is a read only property; its value cannot be set.` });
        continue;
      }
      if (raw === null || raw === '') continue;
      const value = String(raw);
      if (def.type === 'enumeration') {
        const allowed = new Set((def.options ?? []).map((o) => o.value));
        const given = def.fieldType === 'checkbox' ? value.split(';') : [value];
        for (const v of given) {
          if (!allowed.has(v)) {
            failures.push({ name, code: 'INVALID_OPTION', message: `${v} was not one of the allowed options` });
          }
        }
      } else if (def.type === 'number' && Number.isNaN(Number(value))) {
        failures.push({ name, code: 'INVALID_FLOAT', message: `${value} was not a valid number` });
      } else if (def.type === 'bool' && value !== 'true' && value !== 'false') {
        failures.push({ name, code: 'INVALID_BOOLEAN', message: `${value} was not a valid boolean` });
      }
      if (name === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        failures.push({ name, code: 'INVALID_EMAIL', message: `Email address ${value} is invalid` });
      }
    }
    if (failures.length > 0) return validationError(failures);

    // Uniqueness: email on contacts, plus any property created with hasUniqueValue.
    for (const [name, raw] of Object.entries(input)) {
      const def = defs.get(name)!;
      const unique = def.hasUniqueValue || (type === 'contacts' && name === 'email');
      if (!unique || raw === null || raw === '') continue;
      const value = String(raw).toLowerCase();
      const holder = live(type).find((r) => r.id !== recordId && r.properties[name]?.toLowerCase() === value);
      if (holder) {
        const message =
          name === 'email' ? `Contact already exists. Existing ID: ${holder.id}` : `A ${type.slice(0, -1)} with the value "${raw}" for property "${name}" already exists. Existing ID: ${holder.id}`;
        return hsError(409, 'CONFLICT', message);
      }
    }
    return undefined;
  }

  function applyProperties(record: CrmRecord, input: Record<string, unknown>): void {
    const defs = properties.get(record.type)!;
    for (const [name, raw] of Object.entries(input)) {
      if (raw === null || raw === '') {
        record.properties[name] = null;
      } else {
        const value = String(raw);
        record.properties[name] = defs.get(name)?.type === 'string' && name === 'email' ? value.toLowerCase() : value;
      }
    }
    const now = nowIso();
    record.updatedAt = now;
    record.properties[record.type === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate'] = now;
    writeLog.push({ type: record.type, id: record.id, properties: Object.keys(input), at: now });
    queueIndex(record);
  }

  function createRecord(type: ObjectType, input: Record<string, unknown>): CrmRecord {
    const id = String(nextId++);
    const now = nowIso();
    const record: CrmRecord = {
      id,
      type,
      properties: { hs_object_id: id, createdate: now },
      createdAt: now,
      updatedAt: now,
      archived: false,
      indexed: null,
      indexQueue: [],
    };
    records.set(`${type}:${id}`, record);
    applyProperties(record, input);
    return record;
  }

  function findRecord(type: ObjectType, idValue: string, idProperty: string | null): CrmRecord | undefined {
    if (idProperty && idProperty !== 'hs_object_id') {
      const value = idValue.toLowerCase();
      return live(type).find((r) => r.properties[idProperty]?.toLowerCase() === value);
    }
    const record = records.get(`${type}:${idValue}`);
    return record && !record.archived ? record : undefined;
  }

  function linkedIds(type: ObjectType, id: string, to: ObjectType): string[] {
    const links = associations.get(`${type}:${id}`) ?? new Set<string>();
    return [...links].filter((key) => key.startsWith(`${to}:`)).map((key) => key.split(':')[1]);
  }

  function associate(fromType: ObjectType, fromId: string, toType: ObjectType, toId: string): void {
    const a = `${fromType}:${fromId}`;
    const b = `${toType}:${toId}`;
    if (!associations.has(a)) associations.set(a, new Set());
    if (!associations.has(b)) associations.set(b, new Set());
    associations.get(a)!.add(b);
    associations.get(b)!.add(a);
  }

  function serialize(record: CrmRecord, requested: string[] | undefined, withAssociations: ObjectType[] = []): Record<string, unknown> {
    const names = requested ?? (record.type === 'contacts' ? CONTACT_DEFAULTS : DEAL_DEFAULTS);
    const defs = properties.get(record.type)!;
    const props: Record<string, string | null> = {};
    for (const name of names) {
      // Defined properties with no value come back as null; undefined ones are omitted.
      if (defs.has(name)) props[name] = record.properties[name] ?? null;
    }
    const out: Record<string, unknown> = {
      id: record.id,
      properties: props,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: record.archived,
    };
    if (withAssociations.length > 0) {
      const assoc: Record<string, unknown> = {};
      for (const to of withAssociations) {
        const ids = linkedIds(record.type, record.id, to);
        if (ids.length > 0) {
          const singular = (t: ObjectType) => t.slice(0, -1);
          assoc[to] = { results: ids.map((id) => ({ id, type: `${singular(record.type)}_to_${singular(to)}` })) };
        }
      }
      if (Object.keys(assoc).length > 0) out.associations = assoc;
    }
    return out;
  }

  function requestedProperties(req: SimRequest): string[] | undefined {
    const raw = req.query.get('properties');
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  }

  function requestedAssociations(req: SimRequest): ObjectType[] {
    const raw = req.query.get('associations');
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => asType(s.trim()))
      .filter((t): t is ObjectType => Boolean(t));
  }

  function rateHeaders(remaining: number): Record<string, string> {
    return {
      'x-hubspot-ratelimit-interval-milliseconds': '10000',
      'x-hubspot-ratelimit-max': String(config.rateLimitPer10s),
      'x-hubspot-ratelimit-remaining': String(Math.max(0, remaining)),
    };
  }

  function rateLimited(policyName: string, message: string): SimResponse {
    return {
      status: 429,
      body: {
        status: 'error',
        message,
        errorType: 'RATE_LIMIT',
        correlationId: randomUUID(),
        requestId: randomUUID(),
        policyName,
      },
    };
  }

  function handleSearch(type: ObjectType, req: SimRequest): SimResponse {
    const body = (req.json ?? {}) as {
      filterGroups?: Array<{ filters?: Array<{ propertyName: string; operator: string; value?: string; values?: string[]; highValue?: string }> }>;
      sorts?: Array<string | { propertyName: string; direction?: string }>;
      properties?: string[];
      limit?: number;
      after?: string | number;
      query?: string;
    };
    const limit = body.limit ?? 10;
    if (limit > 200) return hsError(400, 'VALIDATION_ERROR', 'limit must be 200 or less');
    const groupsIn = body.filterGroups ?? [];
    const filterCount = groupsIn.reduce((n, g) => n + (g.filters?.length ?? 0), 0);
    if (groupsIn.length > 5 || filterCount > 18 || groupsIn.some((g) => (g.filters?.length ?? 0) > 6)) {
      return hsError(400, 'VALIDATION_ERROR', 'Too many filters: up to 5 groups, 6 filters per group, 18 in total');
    }
    const defs = properties.get(type)!;
    for (const group of groupsIn) {
      for (const f of group.filters ?? []) {
        if (!defs.has(f.propertyName)) {
          return hsError(400, 'VALIDATION_ERROR', `Unknown property in filter: ${f.propertyName}`);
        }
      }
    }

    const visible: CrmRecord[] = [];
    for (const record of live(type)) {
      flushIndex(record);
      if (record.indexed) visible.push(record);
    }
    let matches = visible.filter((record) => {
      if (groupsIn.length === 0) return true;
      return groupsIn.some((group) =>
        (group.filters ?? []).every((f) => compare(record.indexed![f.propertyName], f.operator, f.value, f.values, f.highValue)),
      );
    });
    if (body.query) {
      const needle = body.query.toLowerCase();
      matches = matches.filter((r) => Object.values(r.indexed!).some((v) => v?.toLowerCase().includes(needle)));
    }

    // Oldest first unless `sorts` says otherwise.
    const sort = body.sorts?.[0];
    const sortName = typeof sort === 'string' ? sort.replace(/^-/, '') : (sort?.propertyName ?? 'createdate');
    const descending = typeof sort === 'string' ? sort.startsWith('-') : sort?.direction === 'DESCENDING';
    matches.sort((x, y) => {
      const a = x.indexed![sortName] ?? '';
      const b = y.indexed![sortName] ?? '';
      const c = a < b ? -1 : a > b ? 1 : Number(x.id) - Number(y.id);
      return descending ? -c : c;
    });

    const offset = Number(body.after ?? 0);
    if (offset + limit > 10_000) {
      return hsError(400, 'VALIDATION_ERROR', 'Search paging is capped at 10,000 results per query');
    }
    const page = matches.slice(offset, offset + limit);
    const out: Record<string, unknown> = {
      total: matches.length,
      results: page.map((r) => {
        const names = body.properties ?? (type === 'contacts' ? CONTACT_DEFAULTS : DEAL_DEFAULTS);
        const props: Record<string, string | null> = {};
        for (const name of names) if (defs.has(name)) props[name] = r.indexed![name] ?? null;
        return { id: r.id, properties: props, createdAt: r.createdAt, updatedAt: r.updatedAt, archived: false };
      }),
    };
    if (offset + limit < matches.length) out.paging = { next: { after: String(offset + limit) } };
    return { status: 200, body: out };
  }

  function handleBatchUpsert(type: ObjectType, req: SimRequest): SimResponse {
    const body = (req.json ?? {}) as { inputs?: Array<{ id?: string; idProperty?: string; properties?: Record<string, unknown> }>; idProperty?: string };
    const inputs = body.inputs ?? [];
    if (inputs.length === 0) return hsError(400, 'VALIDATION_ERROR', 'inputs is required');
    if (inputs.length > 100) return hsError(400, 'VALIDATION_ERROR', 'Batch limit is 100 inputs');

    // Partial upserts are not supported with email, so one bad input fails the whole call.
    const startedAt = nowIso();
    for (const input of inputs) {
      const idProperty = input.idProperty ?? body.idProperty;
      if (!idProperty || !input.id) return hsError(400, 'VALIDATION_ERROR', 'Each input needs id and idProperty');
      const def = properties.get(type)!.get(idProperty);
      if (!def || !(def.hasUniqueValue || idProperty === 'email')) {
        return hsError(400, 'VALIDATION_ERROR', `${idProperty} is not a unique identifier property`);
      }
      const existing = findRecord(type, input.id, idProperty);
      const failed = checkProperties(type, { ...(input.properties ?? {}), [idProperty]: input.id }, existing?.id);
      if (failed) return failed;
    }
    const results = inputs.map((input) => {
      const idProperty = (input.idProperty ?? body.idProperty)!;
      const existing = findRecord(type, input.id!, idProperty);
      if (existing) {
        applyProperties(existing, input.properties ?? {});
        return { ...serialize(existing, undefined), new: false };
      }
      const created = createRecord(type, { ...(input.properties ?? {}), [idProperty]: input.id });
      return { ...serialize(created, undefined), new: true };
    });
    return { status: 200, wrote: true, body: { status: 'COMPLETE', results, startedAt, completedAt: nowIso() } };
  }

  function handleBatchRead(type: ObjectType, req: SimRequest): SimResponse {
    const body = (req.json ?? {}) as { inputs?: Array<{ id: string }>; idProperty?: string; properties?: string[] };
    const results: unknown[] = [];
    for (const input of body.inputs ?? []) {
      const record = findRecord(type, input.id, body.idProperty ?? null);
      if (record) results.push(serialize(record, body.properties));
    }
    return { status: 200, body: { status: 'COMPLETE', results, startedAt: nowIso(), completedAt: nowIso() } };
  }

  function handleObjects(type: ObjectType, rest: string[], req: SimRequest): SimResponse {
    const [first, second, third, fourth, fifth] = rest;

    if (first === 'search' && req.method === 'POST') return handleSearch(type, req);
    if (first === 'batch' && second === 'upsert' && req.method === 'POST') return handleBatchUpsert(type, req);
    if (first === 'batch' && second === 'read' && req.method === 'POST') return handleBatchRead(type, req);

    if (!first) {
      if (req.method === 'POST') {
        const body = (req.json ?? {}) as {
          properties?: Record<string, unknown>;
          associations?: Array<{ to?: { id?: string }; types?: Array<{ associationCategory: string; associationTypeId: number }> }>;
        };
        const props = body.properties ?? {};
        if (type === 'deals') {
          // The wording is what the real API returned on 2026-11-03 for a deal with no pipeline.
          const missing = ['dealname', 'dealstage', 'pipeline'].filter((k) => !props[k]);
          if (missing.length > 0) return hsError(400, 'VALIDATION_ERROR', `Cannot create object with type: DEAL. The following required properties were missing: [${missing.join(', ')}]`);
        }
        const failed = checkProperties(type, props);
        if (failed) return failed;
        for (const assoc of body.associations ?? []) {
          const typeId = assoc.types?.[0]?.associationTypeId;
          const toType = typeId === 3 ? 'contacts' : typeId === 4 ? 'deals' : undefined;
          if (!toType || !assoc.to?.id || !findRecord(toType, assoc.to.id, null)) {
            return hsError(400, 'VALIDATION_ERROR', `Association target not found or type not supported: ${assoc.to?.id}`);
          }
        }
        const record = createRecord(type, props);
        for (const assoc of body.associations ?? []) {
          const toType = assoc.types?.[0]?.associationTypeId === 3 ? 'contacts' : 'deals';
          associate(type, record.id, toType, assoc.to!.id!);
        }
        return { status: 201, wrote: true, body: serialize(record, Object.keys(record.properties)) };
      }
      if (req.method === 'GET') {
        const limit = Math.min(Number(req.query.get('limit') ?? 10), 100);
        const after = Number(req.query.get('after') ?? 0);
        const all = live(type).sort((a, b) => Number(a.id) - Number(b.id));
        const remaining = all.filter((r) => Number(r.id) > after);
        const page = remaining.slice(0, limit);
        const out: Record<string, unknown> = { results: page.map((r) => serialize(r, requestedProperties(req))) };
        if (remaining.length > limit) out.paging = { next: { after: page[page.length - 1].id } };
        return { status: 200, body: out };
      }
    }

    if (first && !second) {
      const idProperty = req.query.get('idProperty');
      const record = findRecord(type, first, idProperty);
      if (!record) {
        // The real API answered a GET for a missing contact with 404 and an empty body (2026-11-03).
        // What a PATCH to a missing record returns wasn't checked, so it keeps the documented-looking body.
        if (req.method === 'GET') return { status: 404 };
        return hsError(404, 'OBJECT_NOT_FOUND', 'Object not found.  objectId are usually numeric.', { context: { id: [first] } });
      }
      if (req.method === 'GET') {
        return { status: 200, body: serialize(record, requestedProperties(req), requestedAssociations(req)) };
      }
      if (req.method === 'PATCH') {
        const props = ((req.json ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
        const failed = checkProperties(type, props, record.id);
        if (failed) return failed;
        applyProperties(record, props);
        return { status: 200, wrote: true, body: serialize(record, Object.keys(record.properties)) };
      }
      if (req.method === 'DELETE') {
        record.archived = true;
        record.updatedAt = nowIso();
        return { status: 204, wrote: true };
      }
    }

    // GET .../{id}/associations/{toType}
    if (first && second === 'associations' && third && !fourth && req.method === 'GET') {
      const to = asType(third);
      const record = findRecord(type, first, null);
      if (!to || !record) return hsError(404, 'OBJECT_NOT_FOUND', 'Object not found');
      const typeId = type === 'deals' ? 3 : 4;
      return {
        status: 200,
        body: {
          results: linkedIds(type, first, to).map((id) => ({
            toObjectId: Number(id),
            associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId, label: null }],
          })),
        },
      };
    }

    // PUT .../{id}/associations/default/{toType}/{toId}
    if (first && second === 'associations' && third === 'default' && fourth && fifth && req.method === 'PUT') {
      const to = asType(fourth);
      if (!to || !findRecord(type, first, null) || !findRecord(to, fifth, null)) {
        return hsError(404, 'OBJECT_NOT_FOUND', 'Object not found');
      }
      associate(type, first, to, fifth);
      return { status: 200, wrote: true, body: { status: 'COMPLETE', results: [{ from: { id: first }, to: { id: fifth } }] } };
    }

    return hsError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
  }

  function handleProperties(type: ObjectType, rest: string[], req: SimRequest): SimResponse {
    const defs = properties.get(type)!;
    const [first, second] = rest;

    if (first === 'groups') {
      if (req.method === 'POST') {
        const body = (req.json ?? {}) as { name?: string; label?: string };
        if (!body.name) return hsError(400, 'VALIDATION_ERROR', 'name is required');
        if (groups.get(type)!.has(body.name)) {
          return hsError(409, 'OBJECT_ALREADY_EXISTS', `A property group named ${body.name} already exists.`);
        }
        groups.get(type)!.add(body.name);
        return { status: 201, wrote: true, body: { name: body.name, label: body.label ?? body.name, displayOrder: -1, archived: false } };
      }
      if (req.method === 'GET') {
        return { status: 200, body: { results: [...groups.get(type)!].map((name) => ({ name, label: name, archived: false })) } };
      }
    }

    if (!first) {
      if (req.method === 'GET') return { status: 200, body: { results: [...defs.values()] } };
      if (req.method === 'POST') {
        const body = (req.json ?? {}) as Partial<PropertyDef>;
        const missing = ['groupName', 'name', 'label', 'type', 'fieldType'].filter((k) => !(body as Record<string, unknown>)[k]);
        if (missing.length > 0) return hsError(400, 'VALIDATION_ERROR', `Missing required fields: ${missing.join(', ')}`);
        if (defs.has(body.name!)) {
          return hsError(409, 'OBJECT_ALREADY_EXISTS', `A property named '${body.name}' already exists.`);
        }
        if (!groups.get(type)!.has(body.groupName!)) {
          return hsError(400, 'VALIDATION_ERROR', `Property group ${body.groupName} does not exist.`);
        }
        const compatible: Record<string, string[]> = {
          bool: ['booleancheckbox', 'calculation_equation'],
          enumeration: ['booleancheckbox', 'checkbox', 'radio', 'select', 'calculation_equation'],
          date: ['date'],
          datetime: ['date'],
          string: ['file', 'text', 'textarea', 'calculation_equation', 'html', 'phonenumber'],
          number: ['number', 'calculation_equation'],
        };
        if (!compatible[body.type!]?.includes(body.fieldType!)) {
          return hsError(400, 'VALIDATION_ERROR', `fieldType ${body.fieldType} is not valid for type ${body.type}`);
        }
        if (body.type === 'enumeration' && !(body.options?.length)) {
          return hsError(400, 'VALIDATION_ERROR', 'Enumeration properties need options');
        }
        if (body.hasUniqueValue && [...defs.values()].filter((p) => p.hasUniqueValue).length >= 10) {
          return hsError(400, 'VALIDATION_ERROR', 'Each object can have up to ten unique value properties');
        }
        const now = nowIso();
        const def: PropertyDef = { ...(body as PropertyDef), hubspotDefined: false, createdAt: now, updatedAt: now };
        defs.set(def.name, def);
        return { status: 201, wrote: true, body: def };
      }
    }

    if (first && !second) {
      const def = defs.get(first);
      if (!def) return hsError(404, 'OBJECT_NOT_FOUND', `Property ${first} does not exist`);
      if (req.method === 'GET') return { status: 200, body: def };
    }
    return hsError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
  }

  function handlePipelines(rest: string[]): SimResponse {
    const pipeline = {
      id: 'default',
      label: 'Sales Pipeline',
      displayOrder: 0,
      archived: false,
      stages: STAGES.map(([id, label, probability, isClosed], displayOrder) => ({
        id,
        label,
        displayOrder,
        archived: false,
        metadata: { isClosed, probability },
      })),
    };
    if (rest[0] === undefined) return { status: 200, body: { results: [pipeline] } };
    if (rest[0] === 'default') return { status: 200, body: pipeline };
    return hsError(404, 'OBJECT_NOT_FOUND', 'Pipeline not found');
  }

  const vendor: Vendor = {
    name: 'hubspot',

    handle(req) {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Bearer ')) {
        return hsError(401, 'INVALID_AUTHENTICATION', 'Authentication credentials not found. Send a Bearer token in the Authorization header.');
      }
      if (auth.slice('Bearer '.length) !== config.token) {
        return hsError(401, 'INVALID_AUTHENTICATION', 'The access token is not valid.');
      }
      if (tokenExpired) {
        return hsError(401, 'EXPIRED_AUTHENTICATION', 'The access token is expired or has been rotated.');
      }
      if (req.jsonInvalid) return hsError(400, 'VALIDATION_ERROR', 'Invalid input JSON.');

      // Legacy /crm/v3/{area}/... and date-based /crm/{area}/{yyyy-mm}/... both resolve here.
      const m = req.path.match(/^\/crm\/(?:v3\/(objects|properties|pipelines)|(objects|properties|pipelines)\/\d{4}-\d{2}(?:-beta)?)\/(.*)$/);
      if (!m) return hsError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
      const area = m[1] ?? m[2];
      const parts = m[3].split('/').filter(Boolean);
      const isSearch = area === 'objects' && parts[1] === 'search';

      if (config.enforceRateLimits) {
        const now = Date.now();
        if (isSearch) {
          // Search has its own limit and returns no rate limit headers.
          searchHits = searchHits.filter((t) => now - t < 1000);
          if (searchHits.length >= config.searchLimitPerSecond) {
            return rateLimited('SECONDLY', 'You have reached your secondly limit.');
          }
          searchHits.push(now);
        } else {
          generalHits = generalHits.filter((t) => now - t < 10_000);
          if (generalHits.length >= config.rateLimitPer10s) {
            return rateLimited('TEN_SECONDLY_ROLLING', 'You have reached your ten_secondly_rolling limit.');
          }
          generalHits.push(now);
        }
      }

      const type = asType(parts[0] ?? '');
      if (!type) return hsError(404, 'NOT_FOUND', `Unknown object type: ${parts[0]}`);
      const rest = parts.slice(1);

      let out: SimResponse;
      if (area === 'objects') out = handleObjects(type, rest, req);
      else if (area === 'properties') out = handleProperties(type, rest, req);
      else out = handlePipelines(rest);

      if (!isSearch && config.enforceRateLimits) {
        out.headers = { ...(out.headers ?? {}), ...rateHeaders(config.rateLimitPer10s - generalHits.length) };
      }
      return out;
    },

    errorFor(status) {
      if (status === 429) return rateLimited('TEN_SECONDLY_ROLLING', 'You have reached your ten_secondly_rolling limit.');
      if (status === 401) return hsError(401, 'EXPIRED_AUTHENTICATION', 'The access token is expired or has been rotated.');
      if (status === 403) return hsError(403, 'MISSING_SCOPES', 'This app does not have the scopes this request requires.');
      if (status === 423) return hsError(423, 'LOCKED', 'Too many requests while the account is syncing. Wait at least 2 seconds.');
      // A gateway in front of the API answers with HTML, so a client can't assume JSON on 5xx.
      if (status === 502 || status === 503 || status === 504) {
        return {
          status,
          headers: { 'content-type': 'text/html' },
          body: `<html><head><title>${status}</title></head><body>Bad gateway</body></html>`,
        };
      }
      if (status >= 500) return hsError(status, 'INTERNAL_ERROR', 'internal error');
      return hsError(status, 'VALIDATION_ERROR', 'injected error');
    },

    expireToken() {
      tokenExpired = true;
    },
    restoreToken() {
      tokenExpired = false;
    },

    snapshot() {
      const summarize = (type: ObjectType) =>
        live(type).map((r) => ({
          id: r.id,
          properties: r.properties,
          associations: linkedIds(type, r.id, type === 'deals' ? 'contacts' : 'deals'),
        }));
      return {
        contacts: summarize('contacts'),
        deals: summarize('deals'),
        customProperties: Object.fromEntries(
          [...properties].map(([type, defs]) => [type, [...defs.values()].filter((p) => !p.hubspotDefined).map((p) => p.name)]),
        ),
        writeLog,
      };
    },

    reset() {
      properties = seedProperties();
      groups = new Map([
        ['contacts', new Set(['contactinformation'])],
        ['deals', new Set(['dealinformation'])],
      ]);
      records = new Map();
      associations = new Map();
      nextId = 10_001;
      tokenExpired = false;
      generalHits = [];
      searchHits = [];
      writeLog = [];
      Object.assign(config, DEFAULT_CONFIG, overrides);
    },

    configure(patch) {
      Object.assign(config, patch);
      const { token: _token, ...visible } = config;
      return visible;
    },
  };

  return vendor;
}
