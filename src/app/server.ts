// The web form, the triage API that n8n calls, and a status page. Bound to localhost
// outside Docker; compose publishes it on 127.0.0.1 only.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hubspotSettings, llmSettings, ROOT } from '../config.ts';
import { createDb, migrate } from '../db.ts';
import { HubSpotClient } from '../hubspot/client.ts';
import { ensureProperties } from '../hubspot/properties.ts';
import { approveJob } from '../worker/jobs.ts';
import { APPROVAL_MESSAGES, listJobs, renderApprovalsPage } from './approvals.ts';
import { handOffPending, receiveLead } from './intake.ts';
import { renderStatusPage, statusData } from './status.ts';
import { currentMode, raiseAlert, retryFailedWrites, triage } from '../triage/service.ts';
import type { TriageInput } from '../triage/service.ts';

const PORT = Number(process.env.LTL_APP_PORT ?? 4000);
const HOST = process.env.LTL_APP_HOST ?? '127.0.0.1';
const WEBHOOK_URL = process.env.LTL_WEBHOOK_URL ?? 'http://127.0.0.1:5678/webhook/lead-intake';
const INTERNAL_TOKEN = process.env.LTL_INTERNAL_TOKEN ?? 'local-only';
const REDRIVE_MS = Number(process.env.LTL_REDRIVE_MS ?? 15_000);

const db = createDb();
await migrate(db);

const hubspot = new HubSpotClient(hubspotSettings());
const llm = llmSettings();
const formPage = readFileSync(path.join(ROOT, 'src/app/form.html'), 'utf8');

if (process.env.LTL_AUTO_SETUP === 'true') {
  await ensureProperties(hubspot).catch((error) => console.error('property setup failed:', (error as Error).message));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 200_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://app.invalid');
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, 200, formPage);
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true, mode: await currentMode(db) });
    if (req.method === 'GET' && url.pathname === '/status') return sendHtml(res, 200, renderStatusPage(await statusData(db)));
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await statusData(db));
    if (req.method === 'GET' && url.pathname === '/approvals') {
      return sendHtml(res, 200, renderApprovalsPage(await listJobs(db), APPROVAL_MESSAGES[url.searchParams.get('notice') ?? '']));
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') return sendJson(res, 200, { jobs: await listJobs(db) });

    const approve = url.pathname.match(/^\/approvals\/([0-9a-f-]{36})\/approve$/);
    if (approve && req.method === 'POST') {
      const fields = new URLSearchParams(await readBody(req));
      const result = await approveJob(db, approve[1], fields.get('digest') ?? '', fields.get('approved_by') ?? '');
      res.writeHead(303, { location: result.ok ? '/approvals' : `/approvals?notice=${result.reason}` });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/submit') {
      const raw = await readBody(req);
      const isJson = String(req.headers['content-type'] ?? '').includes('json');
      const fields = isJson ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
      const result = await receiveLead(db, fields, { webhookUrl: WEBHOOK_URL });
      if (!result.ok) {
        if (isJson) return sendJson(res, 400, result);
        return sendHtml(res, 400, formPage.replace('<!--notice-->', `<p class="notice error">${result.error}</p>`));
      }
      if (isJson) return sendJson(res, 200, result);
      return sendHtml(res, 200, formPage.replace('<!--notice-->', '<p class="notice">Thanks. Your message is in. Someone will be in touch.</p>'));
    }

    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      if (req.headers['x-ltl-internal'] !== INTERNAL_TOKEN) return sendJson(res, 401, { error: 'unauthorized' });
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Record<string, unknown>;

      if (url.pathname === '/api/triage') {
        const result = await triage({ db, hubspot, llm }, body as unknown as TriageInput);
        return sendJson(res, 200, result);
      }
      if (url.pathname === '/api/alert') {
        const kind = String(body.kind ?? 'unknown');
        const key = body.key ? String(body.key) : null;
        await raiseAlert(db, kind, key, body.detail ? String(body.detail).slice(0, 500) : null);
        // A failed contact upsert goes back in the queue: replaying it is safe.
        if (kind === 'crm_upsert_failed' && key) {
          await db.query('update lead_submissions set handed_off_at = null where key = $1', [key]);
        }
        return sendJson(res, 200, { ok: true });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(`${req.method} ${url.pathname} failed:`, (error as Error).message);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

const timer = setInterval(() => {
  handOffPending(db, { webhookUrl: WEBHOOK_URL }).catch((error) => console.error('redrive failed:', (error as Error).message));
  retryFailedWrites({ db, hubspot, llm }).catch((error) => console.error('write retry failed:', (error as Error).message));
}, REDRIVE_MS);
timer.unref();

server.listen(PORT, HOST, () => console.log(`app on ${HOST}:${PORT}, model ${llm.model}`));

async function stop(): Promise<void> {
  clearInterval(timer);
  server.closeAllConnections();
  server.close();
  await db.end();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
