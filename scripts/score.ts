// Scores the rules and classifier on a labeled synthetic set.
//
//   node scripts/score.ts --split dev [--label name] [--limit n]
//   node scripts/score.ts --split test --final
//
// Tune against dev as often as needed. The held-out test split is different:
// - It needs --final, and refuses to run with uncommitted changes, so the result ties
//   to one commit of the prompt, rules and pass bar.
// - It runs once. A second run needs --rerun-reason and leaves the first run's files
//   in place. Every attempt is appended to results/scoring/heldout-runs.log.
// - Nothing here prints lead text, in any mode.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { llmSettings, ROOT, rulesConfig, triageConfig } from '../src/config.ts';
import type { LabeledLead } from '../src/leads/types.ts';
import { RULES_VERSION, sortLead } from '../src/rules/rules.ts';
import { computeMetrics, renderReport } from '../src/triage/metrics.ts';
import type { ScoredLead } from '../src/triage/metrics.ts';
import { runPipeline, SYSTEM_PROMPT } from '../src/triage/pipeline.ts';

const { values: args } = parseArgs({
  options: {
    split: { type: 'string' },
    label: { type: 'string' },
    limit: { type: 'string' },
    final: { type: 'boolean', default: false },
    'rerun-reason': { type: 'string' },
    'rules-only': { type: 'boolean', default: false },
  },
});

const split = args.split;
if (split !== 'dev' && split !== 'test') {
  console.error('usage: node scripts/score.ts --split dev|test');
  process.exit(2);
}

const git = (...params: string[]) => execFileSync('git', params, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain') !== '';

const OUT_DIR = path.join(ROOT, 'results/scoring');
mkdirSync(OUT_DIR, { recursive: true });
const HELDOUT_LOG = path.join(OUT_DIR, 'heldout-runs.log');

if (split === 'test') {
  if (!args.final) {
    console.error('the held-out split needs --final');
    process.exit(2);
  }
  if (args['rules-only']) {
    console.error('--rules-only is for dev: a rules-only look at the held-out set would still be a look');
    process.exit(2);
  }
  if (dirty) {
    console.error('commit first: a held-out run has to tie to one commit');
    process.exit(2);
  }
  const already = existsSync(path.join(OUT_DIR, 'test-final.json'));
  if (already && !args['rerun-reason']) {
    console.error('the held-out set has already been scored. A second run needs --rerun-reason and is logged.');
    process.exit(2);
  }
}

const llm = llmSettings();
const leadsFile = path.join(ROOT, `data/leads/${split}.synthetic.jsonl`);
const leadsText = readFileSync(leadsFile, 'utf8');
let leads = leadsText.trim().split('\n').map((line) => JSON.parse(line) as LabeledLead);
if (args.limit) leads = leads.slice(0, Number(args.limit));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const label = args.label ?? (split === 'test' ? (args['rerun-reason'] ? 'rerun' : 'final') : 'run');
const startedAt = new Date().toISOString();
if (split === 'test') {
  appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at: startedAt, event: 'start', commit, model: llm.model, prompt_version: triageConfig.prompt_version, rerun_reason: args['rerun-reason'] ?? null })}\n`);
}

// A model server that crashes or restarts says nothing about the model. So a failed call
// waits and tries again, and a server that stays down stops the run instead of scoring
// the rest of the set as unanswered. Every retry is counted in the results.
const RETRY_WAIT_MS = Number(process.env.SCORE_RETRY_WAIT_MS ?? 20_000);
const MAX_RETRIES_PER_LEAD = 6;

const scored: ScoredLead[] = [];
let totalRetries = 0;
for (const [index, lead] of leads.entries()) {
  const rule = sortLead(lead.form, rulesConfig);
  if (args['rules-only'] && !rule) continue;
  let { decision, classifier } = await runPipeline(lead.form, llm, { rule });
  let retries = 0;
  while (decision.outcome === 'model_unavailable' && retries < MAX_RETRIES_PER_LEAD) {
    retries += 1;
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    ({ decision, classifier } = await runPipeline(lead.form, llm, { rule }));
  }
  totalRetries += retries;
  if (decision.outcome === 'model_unavailable') {
    const at = new Date().toISOString();
    console.error(`stopping at lead ${index + 1}/${leads.length}: the model server stayed down (${decision.detail})`);
    if (split === 'test') {
      appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at, event: 'aborted', commit, scored: scored.length, reason: decision.detail })}\n`);
    }
    process.exit(3);
  }
  scored.push({
    id: lead.id,
    template_id: lead.generator.template_id,
    difficulty: lead.label.difficulty,
    tags: lead.label.tags,
    resubmission: Boolean(lead.generator.resubmission_of),
    label_category: lead.label.category,
    label_priority: lead.label.priority,
    outcome: decision.outcome,
    route: decision.route,
    rule_id: decision.ruleId,
    predicted_category: decision.category,
    predicted_priority: decision.priority,
    raw_category: classifier?.status === 'ok' ? classifier.output.category : null,
    confidence: decision.confidence,
    needs_review: decision.needsReview,
    skip_crm: decision.skipCrm,
    latency_ms: classifier?.latencyMs ?? null,
    retries,
    detail: decision.detail,
  });
  if ((index + 1) % 20 === 0) console.error(`${index + 1}/${leads.length}`);
}

const finishedAt = new Date().toISOString();
const metrics = computeMetrics(scored, triageConfig.pass_bar);
const meta = {
  synthetic: true,
  split,
  label,
  model: llm.model,
  llm_host: new URL(llm.baseUrl).host,
  prompt_version: triageConfig.prompt_version,
  prompt_sha256: sha256(SYSTEM_PROMPT),
  rules_version: RULES_VERSION,
  rules_config_sha256: sha256(JSON.stringify(rulesConfig)),
  confidence_min: triageConfig.confidence_min,
  max_tokens: triageConfig.llm.max_tokens,
  temperature: triageConfig.llm.temperature,
  git_commit: commit,
  git_dirty: dirty,
  leads_file: path.relative(ROOT, leadsFile).replaceAll('\\', '/'),
  leads_sha256: sha256(leadsText),
  limit: args.limit ? Number(args.limit) : null,
  rules_only: args['rules-only'],
  rerun_reason: args['rerun-reason'] ?? null,
  retries_after_server_failure: totalRetries,
  started_at: startedAt,
  finished_at: finishedAt,
};

function nextRerunStem(): string {
  if (args.label) return `test-${args.label}`;
  let n = 1;
  while (existsSync(path.join(OUT_DIR, `test-rerun-${n}.json`))) n += 1;
  return `test-rerun-${n}`;
}
const stem = split === 'test' ? (args['rerun-reason'] ? nextRerunStem() : 'test-final') : `dev-${label}`;
writeFileSync(path.join(OUT_DIR, `${stem}.json`), `${JSON.stringify({ meta, metrics, leads: scored }, null, 2)}\n`);
writeFileSync(path.join(OUT_DIR, `${stem}.md`), renderReport(meta, metrics));
if (split === 'test') {
  appendFileSync(HELDOUT_LOG, `${JSON.stringify({ at: finishedAt, event: 'finish', commit, file: `results/scoring/${stem}.json`, category_accuracy: metrics.category.accuracy, passed: metrics.pass_bar.passed })}\n`);
}

console.log(JSON.stringify({
  file: `results/scoring/${stem}.json`,
  total: metrics.total,
  category_accuracy: metrics.category.accuracy,
  ci95: metrics.category.ci95,
  when_answered: metrics.category_when_answered.accuracy,
  priority_accuracy: metrics.priority.accuracy,
  high_recall: metrics.high_priority.recall,
  rule_share: metrics.routes.rule.share,
  rule_accuracy: metrics.routes.rule.accuracy,
  model_accuracy: metrics.routes.model.accuracy,
  outcomes: metrics.outcomes,
  real_lead_lost: metrics.real_lead_lost,
  junk_promoted: metrics.junk_promoted,
  injection: metrics.injection,
  latency: metrics.latency_ms,
  passed: metrics.pass_bar.passed,
}, null, 1));
