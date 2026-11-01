// The durable row and the rules around it. Every state change is a conditional update, so
// two workers, a replay or a dead process can't move a job the wrong way.

import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { digestOf } from './payload.ts';
import type { InvoicePayload, PayloadResult } from './payload.ts';

export type JobStatus = 'awaiting_approval' | 'queued' | 'running' | 'done' | 'needs_person';

export interface InvoiceJob {
  id: string;
  deal_id: string;
  status: JobStatus;
  payload: InvoicePayload;
  digest: string;
  problem: string | null;
  approval_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  not_before: Date | null;
  attempts: number;
  qb_customer_id: string | null;
  qb_invoice_id: string | null;
  written_back_at: Date | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

type Runner = Pick<Db, 'query'>;

export class LostLease extends Error {
  constructor() {
    super('another worker holds this job now');
    this.name = 'LostLease';
  }
}

export async function recordEvent(runner: Runner, jobId: string, event: string, detail?: Record<string, unknown>): Promise<void> {
  await runner.query('insert into job_events (job_id, event, detail) values ($1, $2, $3)', [jobId, event, detail ? JSON.stringify(detail) : null]);
}

export async function raiseJobAlert(runner: Runner, kind: string, jobId: string | null, detail: string): Promise<void> {
  await runner.query('insert into alerts (kind, key, detail) values ($1, $2, $3)', [kind, jobId, detail.slice(0, 500)]);
}

async function inTransaction<T>(db: Db, work: (client: Runner) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const out = await work(client);
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const NO_PAYLOAD_DIGEST = 'no-payload';

/**
 * Called each time the poller sees a won deal. One deal, one job, however many polls see
 * it. If what would be sent has changed, an approval no longer counts.
 */
export async function upsertJobFromDeal(db: Db, dealId: string, result: PayloadResult): Promise<'created' | 'unchanged' | 'updated' | 'flagged'> {
  return inTransaction(db, async (client) => {
    const found = await client.query<InvoiceJob>('select * from invoice_jobs where deal_id = $1 for update', [dealId]);
    const job = found.rows[0];
    const digest = result.ok ? digestOf(result.payload) : NO_PAYLOAD_DIGEST;
    const payload = result.ok ? result.payload : { deal_id: dealId };

    if (!job) {
      const created = await client.query<InvoiceJob>(
        `insert into invoice_jobs (deal_id, status, payload, digest, problem) values ($1, $2, $3, $4, $5) returning *`,
        [dealId, result.ok ? 'awaiting_approval' : 'needs_person', JSON.stringify(payload), digest, result.ok ? null : `deal: ${result.problem}`],
      );
      await recordEvent(client, created.rows[0].id, 'created', { digest });
      if (!result.ok) await raiseJobAlert(client, 'deal_needs_fixing', created.rows[0].id, result.problem);
      return 'created';
    }

    if (digest === job.digest) return 'unchanged';

    const waitingOnAPerson = job.status === 'awaiting_approval' || job.status === 'queued' || (job.status === 'needs_person' && job.problem?.startsWith('deal:'));
    if (waitingOnAPerson) {
      const wasApproved = job.status === 'queued';
      await client.query(
        `update invoice_jobs set payload = $2, digest = $3, status = $4, problem = $5, approval_id = null, not_before = null, updated_at = now() where id = $1`,
        [job.id, JSON.stringify(payload), digest, result.ok ? 'awaiting_approval' : 'needs_person', result.ok ? null : `deal: ${result.problem}`],
      );
      await recordEvent(client, job.id, 'content_changed', { digest, was_approved: wasApproved });
      if (wasApproved) await raiseJobAlert(client, 'changed_after_approval', job.id, 'The deal changed after it was approved, so it needs approving again.');
      return 'updated';
    }

    // Too late to change anything. A person should know, once per change.
    const seen = await client.query("select 1 from job_events where job_id = $1 and event = 'changed_too_late' and detail->>'digest' = $2", [job.id, digest]);
    if (seen.rowCount === 0) {
      await recordEvent(client, job.id, 'changed_too_late', { digest, status: job.status });
      await raiseJobAlert(client, 'deal_changed_after_start', job.id, `The deal changed while the job was ${job.status}. The invoice was not updated.`);
    }
    return 'flagged';
  });
}

export type ApprovalResult = { ok: true; approvalId: string } | { ok: false; reason: 'no_name' | 'not_found' | 'not_awaiting_approval' | 'stale_digest' };

/** A person's yes, to this job and exactly this content. */
export async function approveJob(db: Db, jobId: string, digest: string, approvedBy: string): Promise<ApprovalResult> {
  const name = approvedBy.trim();
  if (!name) return { ok: false, reason: 'no_name' };
  return inTransaction<ApprovalResult>(db, async (client) => {
    const found = await client.query<InvoiceJob>('select * from invoice_jobs where id = $1 for update', [jobId]);
    const job = found.rows[0];
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.status !== 'awaiting_approval') {
      await recordEvent(client, job.id, 'approval_refused', { reason: 'not_awaiting_approval', status: job.status, by: name });
      return { ok: false, reason: 'not_awaiting_approval' };
    }
    if (job.digest !== digest) {
      await recordEvent(client, job.id, 'approval_refused', { reason: 'stale_digest', by: name });
      return { ok: false, reason: 'stale_digest' };
    }
    const approval = await client.query<{ id: string }>('insert into approvals (job_id, digest, approved_by) values ($1, $2, $3) returning id', [job.id, digest, name]);
    await client.query("update invoice_jobs set status = 'queued', approval_id = $2, updated_at = now() where id = $1", [job.id, approval.rows[0].id]);
    await recordEvent(client, job.id, 'approved', { by: name, digest });
    return { ok: true, approvalId: approval.rows[0].id };
  });
}

export interface ClaimedJob extends InvoiceJob {
  lease_token: string;
}

/**
 * Takes the next job: queued and due, or running on a lease that expired because its
 * worker died. SKIP LOCKED plus the status check means only one worker gets each job.
 * The approval is checked and spent here, in the same transaction.
 */
export async function claimNext(db: Db, leaseSeconds: number): Promise<ClaimedJob | null> {
  for (;;) {
    const outcome = await inTransaction<ClaimedJob | 'refused' | null>(db, async (client) => {
      const picked = await client.query<InvoiceJob>(
        `select * from invoice_jobs
         where (status = 'queued' and coalesce(not_before, now()) <= now())
            or (status = 'running' and lease_expires_at < now())
         order by created_at for update skip locked limit 1`,
      );
      const job = picked.rows[0];
      if (!job) return null;

      const refuse = async (reason: string, nextStatus: JobStatus, problem: string | null): Promise<'refused'> => {
        await client.query('update invoice_jobs set status = $2, problem = $3, approval_id = null, updated_at = now() where id = $1', [job.id, nextStatus, problem]);
        await recordEvent(client, job.id, 'claim_refused', { reason });
        await raiseJobAlert(client, 'claim_refused', job.id, reason);
        return 'refused';
      };

      if (!job.approval_id) return refuse('no approval', 'awaiting_approval', null);
      const found = await client.query<{ id: string; job_id: string; digest: string; consumed_at: Date | null }>('select * from approvals where id = $1 for update', [job.approval_id]);
      const approval = found.rows[0];
      if (!approval || approval.job_id !== job.id) return refuse('approval belongs to another job', 'awaiting_approval', null);
      if (approval.digest !== job.digest) return refuse('content changed after approval', 'awaiting_approval', null);
      // A finished job that comes back was put back by hand. Its approval is spent.
      if (approval.consumed_at && job.finished_at) return refuse('approval already used', 'needs_person', 'approval already used');

      await client.query('update approvals set consumed_at = coalesce(consumed_at, now()) where id = $1', [approval.id]);
      const lease = randomUUID();
      const claimed = await client.query<ClaimedJob>(
        `update invoice_jobs set status = 'running', lease_token = $2, lease_expires_at = now() + make_interval(secs => $3),
                attempts = attempts + 1, not_before = null, updated_at = now()
         where id = $1 returning *`,
        [job.id, lease, leaseSeconds],
      );
      await recordEvent(client, job.id, 'claimed', { attempt: claimed.rows[0].attempts, after_dead_worker: job.status === 'running' });
      return claimed.rows[0];
    });
    if (outcome !== 'refused') return outcome;
  }
}

/** Any update by a worker whose lease was taken over fails here, so a stale worker stops. */
async function fenced(db: Db, job: ClaimedJob, set: string, params: unknown[] = []): Promise<void> {
  const res = await db.query(`update invoice_jobs set ${set}, updated_at = now() where id = $1 and lease_token = $2`, [job.id, job.lease_token, ...params]);
  if (res.rowCount === 0) throw new LostLease();
}

export const renewLease = (db: Db, job: ClaimedJob, leaseSeconds: number) =>
  fenced(db, job, "lease_expires_at = now() + make_interval(secs => $3)", [leaseSeconds]);

export const saveCustomerId = (db: Db, job: ClaimedJob, id: string) => fenced(db, job, 'qb_customer_id = $3', [id]);
export const saveInvoiceId = (db: Db, job: ClaimedJob, id: string) => fenced(db, job, 'qb_invoice_id = $3', [id]);
export const markWrittenBack = (db: Db, job: ClaimedJob) => fenced(db, job, 'written_back_at = now()');

export async function finishJob(db: Db, job: ClaimedJob): Promise<void> {
  await fenced(db, job, "status = 'done', finished_at = now(), lease_token = null, lease_expires_at = null, problem = null");
  await recordEvent(db, job.id, 'done');
}

export async function releaseForRetry(db: Db, job: ClaimedJob, delayMs: number, reason: string, options: { countAttempt?: boolean } = {}): Promise<void> {
  const uncount = options.countAttempt === false ? ', attempts = attempts - 1' : '';
  await fenced(db, job, `status = 'queued', lease_token = null, lease_expires_at = null, not_before = now() + make_interval(secs => $3)${uncount}`, [delayMs / 1000]);
  await recordEvent(db, job.id, 'released', { reason, delay_ms: delayMs });
}

export async function sendToPerson(db: Db, job: ClaimedJob, problem: string): Promise<void> {
  await fenced(db, job, "status = 'needs_person', lease_token = null, lease_expires_at = null, problem = $3", [problem]);
  await recordEvent(db, job.id, 'needs_person', { problem });
  await raiseJobAlert(db, 'job_needs_person', job.id, problem);
}

export async function backToApproval(db: Db, job: ClaimedJob, reason: string, fresh?: { payload: InvoicePayload; digest: string }): Promise<void> {
  if (fresh) {
    await fenced(db, job, "status = 'awaiting_approval', approval_id = null, lease_token = null, lease_expires_at = null, payload = $3, digest = $4", [JSON.stringify(fresh.payload), fresh.digest]);
  } else {
    await fenced(db, job, "status = 'awaiting_approval', approval_id = null, lease_token = null, lease_expires_at = null");
  }
  await recordEvent(db, job.id, 'back_to_approval', { reason });
  await raiseJobAlert(db, 'changed_after_approval', job.id, reason);
}

export interface ExternalCall {
  job_id: string;
  call: string;
  idempotency_key: string;
  status: 'intent' | 'confirmed';
  attempts: number;
  last_attempt_at: Date;
  response_id: string | null;
  confirmed_by: string | null;
}

export async function getCall(db: Db, jobId: string, call: string): Promise<ExternalCall | null> {
  const res = await db.query<ExternalCall>('select * from external_calls where job_id = $1 and call = $2', [jobId, call]);
  return res.rows[0] ?? null;
}

/** On disk before the call goes out. Finding this row at 'intent' later means the outcome is unknown. */
export async function markIntent(db: Db, jobId: string, call: string, key: string): Promise<void> {
  await db.query(
    `insert into external_calls (job_id, call, idempotency_key, status) values ($1, $2, $3, 'intent')
     on conflict (job_id, call) do update set attempts = external_calls.attempts + 1, last_attempt_at = now()
     where external_calls.status = 'intent'`,
    [jobId, call, key],
  );
}

export async function confirmCall(db: Db, jobId: string, call: string, key: string, responseId: string, confirmedBy: 'response' | 'lookup'): Promise<void> {
  await db.query(
    `insert into external_calls (job_id, call, idempotency_key, status, response_id, confirmed_by) values ($1, $2, $3, 'confirmed', $4, $5)
     on conflict (job_id, call) do update set status = 'confirmed', response_id = excluded.response_id, confirmed_by = excluded.confirmed_by`,
    [jobId, call, key, responseId, confirmedBy],
  );
}

export async function advanceCursor(db: Db, name: string, cursorMs: number): Promise<void> {
  await db.query(
    `insert into poll_cursors (name, cursor_ms) values ($1, $2)
     on conflict (name) do update set cursor_ms = greatest(poll_cursors.cursor_ms, excluded.cursor_ms), updated_at = now()`,
    [name, cursorMs],
  );
}

export async function readCursor(db: Db, name: string): Promise<number> {
  const res = await db.query<{ cursor_ms: string }>('select cursor_ms from poll_cursors where name = $1', [name]);
  return res.rows[0] ? Number(res.rows[0].cursor_ms) : 0;
}
