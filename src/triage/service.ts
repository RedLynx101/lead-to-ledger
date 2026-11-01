// The triage step with its durable row. n8n calls this once per lead; if it calls again
// for the same key, the row answers instead of the model.
//
// The order matters for restarts. The claim goes on disk before the model is called,
// the decision goes on disk before the write, and the write is safe to repeat. A crash
// at any point leaves a row that a retry can pick up without a second model call once
// a decision has been stored.

import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import type { LlmSettings } from '../config.ts';
import { triageConfig } from '../config.ts';
import { HubSpotClient, HubSpotError } from '../hubspot/client.ts';
import type { RuleDecision } from '../rules/rules.ts';
import type { AiFields, TriageDecision } from './decide.ts';
import { runPipeline } from './pipeline.ts';
import type { PipelineForm } from './pipeline.ts';

export type TriageMode = 'shadow' | 'live';

// Longer than n8n's 10-minute wait, so a lead still queued for the model isn't taken over.
const LEASE_SECONDS = 900;

// One model call at a time. A local model on one GPU answers a burst of concurrent calls
// by timing out on most of them, and scoring ran one at a time, so this is also what
// was measured.
let modelQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = modelQueue.then(task, task);
  modelQueue = run.catch(() => undefined);
  return run;
}

/** Same email and same message is the same submission, whenever it arrives. */
export function submissionKey(form: { email: string; message: string }): string {
  const normalized = `${form.email.trim().toLowerCase()}\n${form.message.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 40);
}

export async function raiseAlert(db: Db, kind: string, key: string | null, detail: string | null): Promise<void> {
  await db.query('insert into alerts (kind, key, detail) values ($1, $2, $3)', [kind, key, detail]);
}

/** Shadow unless a signed-off change says otherwise. No row means shadow. */
export async function currentMode(db: Db): Promise<TriageMode> {
  const res = await db.query<{ value: { mode: TriageMode } }>("select value from settings where name = 'triage_mode'");
  return res.rows[0]?.value.mode === 'live' ? 'live' : 'shadow';
}

export interface TriageRow {
  key: string;
  status: 'claimed' | 'done' | 'write_failed';
  attempts: number;
  route: 'rule' | 'model' | null;
  rule_id: string | null;
  outcome: string | null;
  category: string | null;
  priority: string | null;
  summary: string | null;
  confidence: string | null;
  needs_review: boolean | null;
  skip_crm: boolean;
  fields: AiFields | null;
  mode: TriageMode | null;
  wrote_to_crm: boolean;
  model: string | null;
  latency_ms: number | null;
  detail: string | null;
}

type Claim =
  | { kind: 'new' }
  | { kind: 'retry'; row: TriageRow }
  | { kind: 'duplicate'; row: TriageRow };

/**
 * Takes the row for this key, or finds out someone else has it. A finished row is a
 * duplicate, with one exception: a lead the model never answered can be tried again. An
 * expired lease or a failed write can be taken over, once, by the update's WHERE clause,
 * so two callers can't both proceed.
 */
async function claim(db: Db, key: string): Promise<Claim> {
  const inserted = await db.query(
    `insert into triage_runs (key, status, lease_expires_at) values ($1, 'claimed', now() + make_interval(secs => $2))
     on conflict (key) do nothing returning key`,
    [key, LEASE_SECONDS],
  );
  if (inserted.rowCount === 1) return { kind: 'new' };

  const taken = await db.query<TriageRow>(
    `update triage_runs set status = 'claimed', attempts = attempts + 1, updated_at = now(),
            lease_expires_at = now() + make_interval(secs => $2)
     where key = $1 and (status = 'write_failed'
                         or (status = 'claimed' and lease_expires_at < now())
                         or (status = 'done' and outcome = 'model_unavailable'))
     returning *`,
    [key, LEASE_SECONDS],
  );
  if (taken.rowCount === 1) return { kind: 'retry', row: taken.rows[0] };

  const existing = await db.query<TriageRow>('select * from triage_runs where key = $1', [key]);
  return { kind: 'duplicate', row: existing.rows[0] };
}

export interface TriageDeps {
  db: Db;
  hubspot: HubSpotClient;
  llm: LlmSettings;
}

export interface TriageInput {
  submission_key?: string;
  form: PipelineForm;
  /** The n8n rules node's answer. Null means no rule matched. */
  rule: RuleDecision | null;
}

export interface TriageResult {
  key: string;
  duplicate: boolean;
  outcome: string | null;
  route: string | null;
  category: string | null;
  priority: string | null;
  needs_review: boolean | null;
  mode: TriageMode | null;
  wrote_to_crm: boolean;
}

function toResult(row: TriageRow, duplicate: boolean): TriageResult {
  return {
    key: row.key,
    duplicate,
    outcome: row.outcome,
    route: row.route,
    category: row.category,
    priority: row.priority,
    needs_review: row.needs_review,
    mode: row.mode,
    wrote_to_crm: row.wrote_to_crm,
  };
}

function decisionFromRow(row: TriageRow): TriageDecision {
  return {
    outcome: row.outcome as TriageDecision['outcome'],
    route: row.route as TriageDecision['route'],
    ruleId: row.rule_id,
    category: row.category as TriageDecision['category'],
    priority: row.priority as TriageDecision['priority'],
    summary: row.summary,
    confidence: row.confidence === null ? null : Number(row.confidence),
    needsReview: Boolean(row.needs_review),
    fields: row.fields ?? {},
    skipCrm: row.skip_crm,
    alert: null,
    detail: row.detail,
  };
}

export async function triage(deps: TriageDeps, input: TriageInput): Promise<TriageResult> {
  const { db, hubspot, llm } = deps;
  const key = input.submission_key ?? submissionKey(input.form);

  const claimed = await claim(db, key);
  if (claimed.kind === 'duplicate') return toResult(claimed.row, true);

  // A retry with a stored decision skips the model: it already answered.
  let decision: TriageDecision;
  let latencyMs: number | null = null;
  if (claimed.kind === 'retry' && claimed.row.outcome && claimed.row.outcome !== 'model_unavailable') {
    decision = decisionFromRow(claimed.row);
  } else {
    const result = input.rule
      ? await runPipeline(input.form, llm, { rule: input.rule })
      : await oneAtATime(() => runPipeline(input.form, llm, { rule: input.rule }));
    decision = result.decision;
    latencyMs = result.classifier?.latencyMs ?? null;
  }

  // Read the mode on every lead, so a rollback takes effect on the next one.
  const mode = await currentMode(db);
  const decided = await db.query<TriageRow>(
    `update triage_runs set route = $2, rule_id = $3, outcome = $4, category = $5, priority = $6, summary = $7,
            confidence = $8, needs_review = $9, skip_crm = $10, fields = $11, mode = $12, model = $13,
            prompt_version = $14, latency_ms = coalesce($15, latency_ms), detail = $16, updated_at = now()
     where key = $1 returning *`,
    [
      key,
      decision.route,
      decision.ruleId,
      decision.outcome,
      decision.category,
      decision.priority,
      decision.summary,
      decision.confidence,
      decision.needsReview,
      decision.skipCrm,
      JSON.stringify(decision.fields),
      mode,
      decision.route === 'model' ? llm.model : null,
      triageConfig.prompt_version,
      latencyMs,
      decision.detail,
    ],
  );
  let row = decided.rows[0];

  if (decision.alert) await raiseAlert(db, decision.alert, key, decision.detail);

  const hasFields = Object.keys(decision.fields).length > 0;
  if (mode === 'live' && hasFields && !decision.skipCrm) {
    try {
      await hubspot.writeAiFields(input.form.email, decision.fields);
    } catch (error) {
      const detail = error instanceof HubSpotError ? `${error.status ?? 'no response'} ${error.category ?? ''}`.trim() : (error as Error).message;
      await raiseAlert(db, 'crm_write_failed', key, detail);
      const failed = await db.query<TriageRow>(
        "update triage_runs set status = 'write_failed', detail = $2, updated_at = now() where key = $1 returning *",
        [key, detail],
      );
      return toResult(failed.rows[0], false);
    }
    const written = await db.query<TriageRow>(
      "update triage_runs set status = 'done', wrote_to_crm = true, written_at = now(), updated_at = now() where key = $1 returning *",
      [key],
    );
    row = written.rows[0];
  } else {
    const closed = await db.query<TriageRow>("update triage_runs set status = 'done', updated_at = now() where key = $1 returning *", [key]);
    row = closed.rows[0];
  }
  return toResult(row, false);
}

/** Tries failed CRM writes again, using the stored answer. Called by the app's re-drive loop. */
export async function retryFailedWrites(deps: TriageDeps, options: { olderThanSeconds?: number; maxAttempts?: number } = {}): Promise<number> {
  const pending = await deps.db.query<{ key: string; form: PipelineForm }>(
    `select t.key, s.form from triage_runs t join lead_submissions s using (key)
     where t.status = 'write_failed' and t.attempts < $1 and t.updated_at < now() - make_interval(secs => $2)
     order by t.updated_at limit 25`,
    [options.maxAttempts ?? 6, options.olderThanSeconds ?? 60],
  );
  let written = 0;
  for (const row of pending.rows) {
    const result = await triage(deps, { submission_key: row.key, form: row.form, rule: null });
    if (result.wrote_to_crm) written += 1;
  }
  return written;
}

export async function recordModeChange(
  db: Db,
  change: { mode: TriageMode; signedOffBy?: string | null; reportFile?: string | null; reportSha256?: string | null; belowBarNote?: string | null },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into settings (name, value) values ('triage_mode', $1)
       on conflict (name) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify({ mode: change.mode })],
    );
    await client.query(
      'insert into mode_changes (mode, signed_off_by, report_file, report_sha256, below_bar_note) values ($1, $2, $3, $4, $5)',
      [change.mode, change.signedOffBy ?? null, change.reportFile ?? null, change.reportSha256 ?? null, change.belowBarNote ?? null],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
