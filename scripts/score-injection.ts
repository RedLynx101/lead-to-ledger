// Measures the model alone against the held-out injection leads, with rules bypassed. In
// the full path, rules sort most of these before the model sees them, so a full run says
// little about the model itself. This one is scored separately.
//
//   LLM_MODEL=<name> node scripts/score-injection.ts --label <name>
//
// Same guards as a held-out run: it needs a clean commit, each attempt is logged, and it
// prints no lead text. Nothing here is for tuning.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { llmSettings, ROOT, triageConfig } from '../src/config.ts';
import type { LabeledLead } from '../src/leads/types.ts';
import { summarizeInjection } from '../src/triage/injection-metrics.ts';
import type { InjectionRow } from '../src/triage/injection-metrics.ts';
import { runPipeline, SYSTEM_PROMPT } from '../src/triage/pipeline.ts';

const { values: args } = parseArgs({ options: { label: { type: 'string' } } });
if (!args.label) {
  console.error('usage: node scripts/score-injection.ts --label <name>');
  process.exit(2);
}

const git = (...params: string[]) => execFileSync('git', params, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
if (git('status', '--porcelain') !== '') {
  console.error('commit first: this run has to tie to one commit');
  process.exit(2);
}

const OUT_DIR = path.join(ROOT, 'results/scoring');
const stem = `injection-${args.label}`;
if (existsSync(path.join(OUT_DIR, `${stem}.json`))) {
  console.error(`${stem} has already been scored`);
  process.exit(2);
}

const HELDOUT_LOG = path.join(OUT_DIR, 'heldout-runs.log');
const llm = llmSettings();
const leadsFile = path.join(ROOT, 'data/leads/test.synthetic.jsonl');
const leadsText = readFileSync(leadsFile, 'utf8');
const leads = leadsText.trim().split('\n').map((line) => JSON.parse(line) as LabeledLead).filter((lead) => lead.label.tags.includes('injection'));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const RETRY_WAIT_MS = Number(process.env.SCORE_RETRY_WAIT_MS ?? 20_000);
const MAX_RETRIES_PER_LEAD = 6;

const startedAt = new Date().toISOString();
appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at: startedAt, event: 'injection_start', commit, model: llm.model, prompt_version: triageConfig.prompt_version, leads: leads.length })}\n`);

const rows: InjectionRow[] = [];
let totalRetries = 0;
for (const lead of leads) {
  // Null means no rule matched, so this goes straight to the model.
  let { decision, classifier } = await runPipeline(lead.form, llm, { rule: null });
  let retries = 0;
  while (decision.outcome === 'model_unavailable' && retries < MAX_RETRIES_PER_LEAD) {
    retries += 1;
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    ({ decision, classifier } = await runPipeline(lead.form, llm, { rule: null }));
  }
  totalRetries += retries;
  if (decision.outcome === 'model_unavailable') {
    appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at: new Date().toISOString(), event: 'injection_aborted', commit, scored: rows.length, reason: decision.detail })}\n`);
    console.error(`stopped: the model server stayed down (${decision.detail})`);
    process.exit(3);
  }
  rows.push({
    id: lead.id,
    template_id: lead.generator.template_id,
    difficulty: lead.label.difficulty,
    label_category: lead.label.category,
    label_priority: lead.label.priority,
    outcome: decision.outcome,
    predicted_category: decision.category,
    predicted_priority: decision.priority,
    raw_category: classifier?.status === 'ok' ? classifier.output.category : null,
    confidence: decision.confidence,
    needs_review: decision.needsReview,
    latency_ms: classifier?.latencyMs ?? null,
    retries,
  });
}

const finishedAt = new Date().toISOString();
const summary = summarizeInjection(rows);
const meta = {
  synthetic: true,
  split: 'test',
  subset: 'leads tagged injection, rules bypassed',
  model: llm.model,
  prompt_version: triageConfig.prompt_version,
  prompt_sha256: sha256(SYSTEM_PROMPT),
  git_commit: commit,
  leads_sha256: sha256(leadsText),
  retries_after_server_failure: totalRetries,
  started_at: startedAt,
  finished_at: finishedAt,
};
writeFileSync(path.join(OUT_DIR, `${stem}.json`), `${JSON.stringify({ meta, summary, leads: rows }, null, 2)}\n`);
appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at: finishedAt, event: 'injection_finish', commit, file: `results/scoring/${stem}.json`, model: llm.model, steered: summary.attacks.steered, attacks: summary.attacks.n })}\n`);
console.log(JSON.stringify({ file: `results/scoring/${stem}.json`, model: llm.model, ...summary }, null, 1));
