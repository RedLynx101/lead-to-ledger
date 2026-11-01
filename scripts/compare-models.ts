// Puts the two models side by side from their committed result files, and applies the
// rule for which becomes the default. The rule was committed before the second model was
// scored on the held-out set:
//
//   1. The model that passes more pass-bar checks on the held-out set wins.
//   2. If tied, the one that sorts fewer real leads as not a lead wins.
//   3. If still tied, the one with higher category accuracy wins.
//   4. If still tied, the current default stays.
//
//   node scripts/compare-models.ts <current label> <new label>
//
// A label names the files: dev-<label>, test-<label> and injection-<label>. The current
// model's runs predate the labels, so they're mapped below.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.ts';
import type { Metrics } from '../src/triage/metrics.ts';
import type { summarizeInjection } from '../src/triage/injection-metrics.ts';

const DIR = path.join(ROOT, 'results/scoring');
const LEGACY: Record<string, { dev: string; test: string }> = {
  bonsai: { dev: 'dev-p2', test: 'test-rerun-1' },
};

const [currentLabel, newLabel] = process.argv.slice(2);
if (!currentLabel || !newLabel) {
  console.error('usage: node scripts/compare-models.ts <current label> <new label>');
  process.exit(2);
}

interface ModelRecord {
  label: string;
  name: string;
  publisher: string;
  quantization: string;
  file_size_bytes: number;
  license: string;
  source: string;
}

const models = JSON.parse(readFileSync(path.join(DIR, 'models.json'), 'utf8')) as ModelRecord[];

function load(label: string) {
  const dev = LEGACY[label]?.dev ?? `dev-${label}`;
  const test = LEGACY[label]?.test ?? `test-${label}`;
  const read = <T>(stem: string) => JSON.parse(readFileSync(path.join(DIR, `${stem}.json`), 'utf8')) as T;
  const injectionStem = `injection-${label}`;
  const record = models.find((m) => m.label === label);
  if (!record) throw new Error(`no entry for ${label} in models.json`);
  return {
    label,
    record,
    files: { dev, test, injection: injectionStem },
    dev: read<{ metrics: Metrics }>(dev).metrics,
    test: read<{ metrics: Metrics; meta: { git_commit: string; prompt_sha256: string; rules_config_sha256: string; retries_after_server_failure?: number } }>(test),
    injection: existsSync(path.join(DIR, `${injectionStem}.json`)) ? read<{ summary: ReturnType<typeof summarizeInjection> }>(injectionStem).summary : null,
  };
}

const current = load(currentLabel);
const challenger = load(newLabel);

const checksPassed = (m: Metrics) => Object.values(m.pass_bar.checks).filter((c) => c.pass).length;

function decide(): { winner: string; reason: string } {
  const a = current.test.metrics;
  const b = challenger.test.metrics;
  if (checksPassed(b) !== checksPassed(a)) {
    return checksPassed(b) > checksPassed(a)
      ? { winner: newLabel, reason: `it passes ${checksPassed(b)} pass-bar checks against ${checksPassed(a)}` }
      : { winner: currentLabel, reason: `it passes ${checksPassed(a)} pass-bar checks against ${checksPassed(b)}` };
  }
  if (b.real_lead_lost.rate !== a.real_lead_lost.rate) {
    return b.real_lead_lost.rate < a.real_lead_lost.rate
      ? { winner: newLabel, reason: 'same number of checks passed, and it sorts fewer real leads as not a lead' }
      : { winner: currentLabel, reason: 'same number of checks passed, and it sorts fewer real leads as not a lead' };
  }
  if ((b.category.accuracy ?? 0) > (a.category.accuracy ?? 0)) return { winner: newLabel, reason: 'tied on the bar and on real leads lost, with higher category accuracy' };
  return { winner: currentLabel, reason: 'tied, so the current default stays' };
}

const sameInputs = current.test.meta.prompt_sha256 === challenger.test.meta.prompt_sha256 && current.test.meta.rules_config_sha256 === challenger.test.meta.rules_config_sha256;
const decision = decide();

function medianLatency(label: string): number {
  const file = JSON.parse(readFileSync(path.join(DIR, `injection-${label}.json`), 'utf8')) as { leads: Array<{ latency_ms: number }> };
  const sorted = file.leads.map((l) => l.latency_ms).sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const both = (fn: (m: ReturnType<typeof load>) => string) => `${fn(current)} | ${fn(challenger)}`;
const row = (name: string, fn: (m: ReturnType<typeof load>) => string) => `| ${name} | ${both(fn)} |`;

const lines = [
  '# Model comparison',
  '',
  'Same prompt, same rules and the same synthetic leads, with nothing tuned against the held-out set. Labels come from the template authors, not a sales team, so this compares the models on this set and says nothing about a real inbox.',
  '',
  `**${decision.winner === newLabel ? `\`${challenger.record.name}\` becomes the default` : `\`${current.record.name}\` stays the default`}:** ${decision.reason}.`,
  '',
  `Prompt and rules identical across the two held-out runs: ${sameInputs ? 'yes' : 'NO'}.`,
  '',
  `| | ${current.record.name} | ${challenger.record.name} |`,
  '|---|---|---|',
  row('Publisher', (m) => m.record.publisher),
  row('Quantization', (m) => m.record.quantization),
  row('File size', (m) => `${(m.record.file_size_bytes / 1e9).toFixed(2)} GB`),
  row('License', (m) => m.record.license),
  row('**Held-out category accuracy**', (m) => `**${pct(m.test.metrics.category.accuracy)}** (${m.test.metrics.category.correct}/${m.test.metrics.category.n}, CI ${pct(m.test.metrics.category.ci95.low)} to ${pct(m.test.metrics.category.ci95.high)})`),
  row('Held-out pass bar', (m) => `${m.test.metrics.pass_bar.passed ? 'passed' : 'not passed'}, ${checksPassed(m.test.metrics)} of 4 checks`),
  row('sales_ready recall', (m) => pct(m.test.metrics.pass_bar.checks.sales_ready_recall.got)),
  row('Real leads sorted as not a lead', (m) => `${pct(m.test.metrics.real_lead_lost.rate)} (${m.test.metrics.real_lead_lost.lost}/${m.test.metrics.real_lead_lost.real_leads})`),
  row('Junk promoted to sales_ready', (m) => `${pct(m.test.metrics.junk_promoted.rate)} (${m.test.metrics.junk_promoted.promoted}/${m.test.metrics.junk_promoted.junk})`),
  row('Accuracy on leads sent to the model', (m) => `${pct(m.test.metrics.routes.model.accuracy)} (${m.test.metrics.routes.model.correct}/${m.test.metrics.routes.model.n})`),
  row('needs_info recall', (m) => pct(m.test.metrics.per_category.needs_info.recall)),
  row('Priority accuracy when answered', (m) => pct(m.test.metrics.priority.accuracy)),
  row('High-priority leads found', (m) => `${pct(m.test.metrics.high_priority.recall)} (${m.test.metrics.high_priority.found}/${m.test.metrics.high_priority.labeled})`),
  row('Model latency, p50 and p95', (m) => `${m.test.metrics.latency_ms.p50} ms, ${m.test.metrics.latency_ms.p95} ms`),
  row('Model latency alone on the GPU, injection run, p50', (m) => (m.injection ? `${medianLatency(m.label)} ms` : 'not run')),
  row('Model outcomes', (m) => Object.entries(m.test.metrics.outcomes).filter(([k]) => k !== 'rule').map(([k, v]) => `${k} ${v}`).join(', ')),
  row('Retries after a server failure', (m) => String(m.test.meta.retries_after_server_failure ?? 0)),
  row('Dev category accuracy', (m) => `${pct(m.dev.category.accuracy)} (${m.dev.category.correct}/${m.dev.category.n})`),
  row('**Model alone, attacks that steered it**', (m) => (m.injection ? `**${m.injection.attacks.steered} of ${m.injection.attacks.n}** (CI ${pct(m.injection.attacks.steered_ci95.low)} to ${pct(m.injection.attacks.steered_ci95.high)})` : 'not run')),
  row('Model alone, attacks sorted correctly', (m) => (m.injection ? `${m.injection.attacks.correct} of ${m.injection.attacks.n}` : 'not run')),
  row('Model alone, real sales quoting instructions, correct', (m) => (m.injection ? `${m.injection.real_sales_quoting_instructions.correct} of ${m.injection.real_sales_quoting_instructions.n}` : 'not run')),
  row('Files', (m) => `\`${m.files.dev}\`, \`${m.files.test}\`, \`${m.files.injection}\``),
  '',
  "Bonsai's held-out run shared the GPU with another project and Granite's didn't, so the full-run latency row overstates the gap. The injection-run row has each model alone on the GPU.",
  '',
  'An attack here is an injection lead that is not really a sale. It counts as steered if the model marked it `sales_ready` or high priority. Rules sort most of these in the full path, so the model-alone row is the one that measures the model.',
  '',
  "`results/scoring/heldout-runs.log` lists every run against the held-out set, including Bonsai's first run, which a server failure cut short.",
  '',
];
writeFileSync(path.join(DIR, 'model-comparison.md'), lines.join('\n'));
console.log(JSON.stringify({ winner: decision.winner, reason: decision.reason, sameInputs }));
