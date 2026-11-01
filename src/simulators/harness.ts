// A small HTTP server shared by the HubSpot and QuickBooks simulators.
//
// It owns everything that is not vendor behaviour: routing the /__sim control
// API, the failure-injection engine, and the request log. The real services
// won't time out or lose a response on command, and that is what the restart
// tests need, so this file exists to make those failures happen on request.
//
// The failure that matters most is a response lost after the write committed:
// the caller sees a dead socket and cannot tell whether anything happened.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface SimRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  json: unknown;
  /** True when a body was sent as JSON but could not be parsed. */
  jsonInvalid: boolean;
}

export interface SimResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set by a vendor handler when this request changed stored state. */
  wrote?: boolean;
  /** Set when the response came from an idempotency replay, not a new write. */
  replayed?: boolean;
}

export interface Vendor {
  readonly name: string;
  handle(req: SimRequest): SimResponse;
  /** A body in the vendor's own error shape for an injected status code. */
  errorFor(status: number, req: SimRequest): SimResponse;
  /** QuickBooks documents HTTP 200 with a Fault in the body. Others leave this out. */
  fault200?(req: SimRequest): SimResponse;
  expireToken(): void;
  restoreToken(): void;
  snapshot(): unknown;
  reset(): void;
  configure(patch: Record<string, unknown>): Record<string, unknown>;
}

export type FaultAction =
  /** Answer with `status` in the vendor's error shape. */
  | 'status'
  /** Never answer. The socket stays open until the client gives up. */
  | 'timeout'
  /** Destroy the socket with no HTTP response at all. */
  | 'drop'
  /** HTTP 200 with a Fault body (QuickBooks only). */
  | 'fault200'
  /** Wait `holdMs`, then process and answer normally. Lets a test kill the caller mid-call. */
  | 'hold'
  /** Expire the current token, then process normally (so the caller gets a 401). */
  | 'expire_token';

export interface FaultSpec {
  match?: {
    method?: string;
    /** Regular expression tested against the pathname. */
    path?: string;
    /** Exact match on the `requestid` query parameter, if given. */
    requestid?: string;
  };
  action: FaultAction;
  status?: number;
  /**
   * Whether the handler runs (and the write commits) before the failure is
   * delivered. `{action:'drop', commit:true}` is the lost-response case.
   * Default: false, except for `hold`, which defaults to true because a server
   * that has accepted a request usually finishes it after the client dies.
   */
  commit?: boolean;
  holdMs?: number;
  /** Let this many matching requests through before the fault applies. */
  skip?: number;
  /** How many requests it applies to. Default 1. 0 means every request. */
  times?: number;
  retryAfterSeconds?: number;
}

interface Fault extends FaultSpec {
  id: string;
  seen: number;
  hits: number;
  waiters: Array<() => void>;
}

export interface LogEntry {
  seq: number;
  at: string;
  method: string;
  path: string;
  requestid?: string;
  /** HTTP status delivered, or null when the client got no response. */
  status: number | null;
  /** Whether this request changed stored state on the simulator. */
  committed: boolean;
  replayed: boolean;
  outcome: 'answered' | 'dropped' | 'hung' | 'client_gone';
  faultId?: string;
  faultAction?: FaultAction;
}

const MAX_LOG = 20_000;
const MAX_BODY_BYTES = 5_000_000;
/** A hung request is destroyed after this long so a forgotten fault can't pin a socket forever. */
const MAX_HANG_MS = 120_000;

export interface SimServer {
  server: http.Server;
  vendor: Vendor;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  url(): string;
}

export function createSimServer(vendor: Vendor): SimServer {
  let faults: Fault[] = [];
  let log: LogEntry[] = [];
  let seq = 0;
  const hanging = new Set<http.ServerResponse>();

  function record(entry: Omit<LogEntry, 'seq' | 'at'>): void {
    seq += 1;
    log.push({ seq, at: new Date().toISOString(), ...entry });
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  }

  function dropHanging(): void {
    for (const res of hanging) res.destroy();
    hanging.clear();
  }

  function takeFault(req: SimRequest): Fault | undefined {
    for (const fault of faults) {
      const m = fault.match ?? {};
      if (m.method && m.method.toUpperCase() !== req.method) continue;
      if (m.path && !new RegExp(m.path).test(req.path)) continue;
      if (m.requestid && m.requestid !== req.query.get('requestid')) continue;
      fault.seen += 1;
      if (fault.seen <= (fault.skip ?? 0)) continue;
      const times = fault.times ?? 1;
      if (times !== 0 && fault.hits >= times) continue;
      fault.hits += 1;
      for (const wake of fault.waiters.splice(0)) wake();
      return fault;
    }
    return undefined;
  }

  function send(res: http.ServerResponse, out: SimResponse): void {
    if (res.destroyed || res.writableEnded) return;
    const headers: Record<string, string> = { ...(out.headers ?? {}) };
    let payload = '';
    if (out.body !== undefined) {
      if (typeof out.body === 'string') {
        payload = out.body;
      } else {
        payload = JSON.stringify(out.body);
        headers['content-type'] ??= 'application/json;charset=UTF-8';
      }
    }
    res.writeHead(out.status, headers);
    res.end(payload);
  }

  function runFault(req: SimRequest, res: http.ServerResponse, fault: Fault): void {
    const base = {
      method: req.method,
      path: req.path,
      requestid: req.query.get('requestid') ?? undefined,
      faultId: fault.id,
      faultAction: fault.action,
    };
    const commit = fault.commit ?? fault.action === 'hold';

    switch (fault.action) {
      case 'status': {
        const handled = commit ? vendor.handle(req) : undefined;
        const out = vendor.errorFor(fault.status ?? 500, req);
        if (fault.retryAfterSeconds !== undefined) {
          out.headers = { ...(out.headers ?? {}), 'retry-after': String(fault.retryAfterSeconds) };
        }
        record({ ...base, status: out.status, committed: Boolean(handled?.wrote), replayed: false, outcome: 'answered' });
        send(res, out);
        return;
      }
      case 'fault200': {
        const handled = commit ? vendor.handle(req) : undefined;
        const out = vendor.fault200?.(req) ?? vendor.errorFor(500, req);
        record({ ...base, status: out.status, committed: Boolean(handled?.wrote), replayed: false, outcome: 'answered' });
        send(res, out);
        return;
      }
      case 'drop': {
        const handled = commit ? vendor.handle(req) : undefined;
        record({ ...base, status: null, committed: Boolean(handled?.wrote), replayed: Boolean(handled?.replayed), outcome: 'dropped' });
        res.destroy();
        return;
      }
      case 'timeout': {
        const handled = commit ? vendor.handle(req) : undefined;
        record({ ...base, status: null, committed: Boolean(handled?.wrote), replayed: Boolean(handled?.replayed), outcome: 'hung' });
        hanging.add(res);
        const timer = setTimeout(() => res.destroy(), MAX_HANG_MS);
        timer.unref();
        res.on('close', () => {
          clearTimeout(timer);
          hanging.delete(res);
        });
        return;
      }
      case 'hold': {
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableFinished) clientGone = true;
        });
        const timer = setTimeout(() => {
          hanging.delete(res);
          if (clientGone && !commit) {
            record({ ...base, status: null, committed: false, replayed: false, outcome: 'client_gone' });
            return;
          }
          const out = vendor.handle(req);
          record({
            ...base,
            status: clientGone ? null : out.status,
            committed: Boolean(out.wrote),
            replayed: Boolean(out.replayed),
            outcome: clientGone ? 'client_gone' : 'answered',
          });
          if (!clientGone) send(res, out);
        }, fault.holdMs ?? 1000);
        timer.unref();
        hanging.add(res);
        return;
      }
      case 'expire_token': {
        vendor.expireToken();
        const out = vendor.handle(req);
        record({ ...base, status: out.status, committed: Boolean(out.wrote), replayed: false, outcome: 'answered' });
        send(res, out);
        return;
      }
    }
  }

  function control(req: SimRequest, res: http.ServerResponse): void {
    const route = req.path.slice('/__sim'.length);
    const ok = (body: unknown, status = 200) => send(res, { status, body });

    if (route === '/health') return ok({ ok: true, vendor: vendor.name });
    if (route === '/reset' && req.method === 'POST') {
      faults = [];
      log = [];
      seq = 0;
      dropHanging();
      vendor.reset();
      return ok({ ok: true });
    }
    if (route === '/state') return ok(vendor.snapshot());
    if (route === '/log') {
      const since = Number(req.query.get('since') ?? 0);
      return ok({ entries: log.filter((e) => e.seq > since) });
    }
    if (route === '/config' && req.method === 'POST') {
      return ok(vendor.configure((req.json ?? {}) as Record<string, unknown>));
    }
    if (route === '/token/expire' && req.method === 'POST') {
      vendor.expireToken();
      return ok({ ok: true });
    }
    if (route === '/token/restore' && req.method === 'POST') {
      vendor.restoreToken();
      return ok({ ok: true });
    }
    if (route === '/faults') {
      if (req.method === 'POST') {
        const spec = req.json as FaultSpec | undefined;
        if (!spec?.action) return ok({ error: 'action is required' }, 400);
        const fault: Fault = { ...spec, id: randomUUID(), seen: 0, hits: 0, waiters: [] };
        faults.push(fault);
        return ok({ id: fault.id }, 201);
      }
      if (req.method === 'DELETE') {
        faults = [];
        return ok({ ok: true });
      }
      return ok({
        faults: faults.map(({ waiters: _waiters, ...rest }) => rest),
      });
    }
    const wait = route.match(/^\/faults\/([^/]+)\/wait$/);
    if (wait) {
      const fault = faults.find((f) => f.id === wait[1]);
      if (!fault) return ok({ error: 'no such fault' }, 404);
      if (fault.hits > 0) return ok({ hit: true });
      const timeoutMs = Number(req.query.get('timeoutMs') ?? 10_000);
      const timer = setTimeout(() => {
        fault.waiters = fault.waiters.filter((w) => w !== wake);
        ok({ hit: false });
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        ok({ hit: true });
      };
      fault.waiters.push(wake);
      return;
    }
    ok({ error: 'unknown control route' }, 404);
  }

  const server = http.createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end();
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      const url = new URL(incoming.url ?? '/', 'http://simulator.invalid');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const contentType = String(incoming.headers['content-type'] ?? '');
      let json: unknown;
      let jsonInvalid = false;
      if (rawBody && (contentType.includes('json') || url.pathname.startsWith('/__sim'))) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          jsonInvalid = true;
        }
      }
      const req: SimRequest = {
        method: incoming.method ?? 'GET',
        path: decodeURIComponent(url.pathname),
        query: url.searchParams,
        headers: incoming.headers,
        rawBody,
        json,
        jsonInvalid,
      };
      if (req.path.startsWith('/__sim')) return control(req, res);

      const fault = takeFault(req);
      if (fault) return runFault(req, res, fault);

      const out = vendor.handle(req);
      record({
        method: req.method,
        path: req.path,
        requestid: req.query.get('requestid') ?? undefined,
        status: out.status,
        committed: Boolean(out.wrote),
        replayed: Boolean(out.replayed),
        outcome: 'answered',
      });
      send(res, out);
    });
  });

  return {
    server,
    vendor,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    close() {
      dropHanging();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    url() {
      const a = server.address() as AddressInfo;
      return `http://127.0.0.1:${a.port}`;
    },
  };
}
