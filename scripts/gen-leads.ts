// Builds data/leads/*.jsonl and data/leads/MANIFEST.json from the templates.
//
//   node scripts/gen-leads.ts                    write the files
//   node scripts/gen-leads.ts --check            confirm committed files match a fresh run
//   node scripts/gen-leads.ts --validate-heldout check held-out templates; prints IDs and counts only
//
// The held-out wording is written separately from the prompt and rules, and whoever
// tunes those must not read it. So nothing here prints message text, in any mode.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateLeads, GENERATOR_VERSION, toJsonl, validateTemplates } from '../src/leads/generate.ts';
import type { LabeledLead, LeadTemplate } from '../src/leads/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_TEMPLATES = path.join(ROOT, 'data/templates/dev.templates.json');
const HELDOUT_TEMPLATES = path.join(ROOT, 'data/templates/heldout.templates.json');
const LEADS_DIR = path.join(ROOT, 'data/leads');

const SPLITS = {
  dev: { seed: 20261101, count: 160, templates: DEV_TEMPLATES, out: 'dev.synthetic.jsonl' },
  test: { seed: 20261102, count: 240, templates: HELDOUT_TEMPLATES, out: 'test.synthetic.jsonl' },
} as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function tally<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function build(split: 'dev' | 'test') {
  const spec = SPLITS[split];
  const templateText = readFileSync(spec.templates, 'utf8');
  const templates = JSON.parse(templateText) as LeadTemplate[];
  const leads = generateLeads({ seed: spec.seed, count: spec.count, split, templates });
  const jsonl = toJsonl(leads);
  const summary = {
    file: `data/leads/${spec.out}`,
    seed: spec.seed,
    count: leads.length,
    template_count: templates.length,
    sha256: sha256(jsonl),
    templates_sha256: sha256(templateText),
    categories: tally(leads.map((l: LabeledLead) => l.label.category)),
    priorities: tally(leads.map((l: LabeledLead) => l.label.priority)),
    difficulties: tally(leads.map((l: LabeledLead) => l.label.difficulty)),
    resubmissions: leads.filter((l: LabeledLead) => l.generator.resubmission_of).length,
  };
  return { spec, jsonl, summary };
}

function manifest(splits: Record<string, unknown>) {
  return {
    synthetic: true,
    note: 'Every lead is generated, not collected. Labels come from the template author following docs/labeling-guide.md, not from a sales team. Category shares were chosen to give each category enough examples and say nothing about a real inbox.',
    generator_version: GENERATOR_VERSION,
    splits,
  };
}

const args = new Set(process.argv.slice(2));

if (args.has('--validate-heldout')) {
  if (!existsSync(HELDOUT_TEMPLATES)) {
    console.error('data/templates/heldout.templates.json does not exist yet');
    process.exit(1);
  }
  const templates = JSON.parse(readFileSync(HELDOUT_TEMPLATES, 'utf8')) as LeadTemplate[];
  const problems = validateTemplates(templates);
  console.log(`templates: ${templates.length}`);
  console.log('by category:', tally(templates.map((t) => t.category)));
  console.log('by difficulty:', tally(templates.map((t) => t.difficulty)));
  console.log('by priority:', tally(templates.map((t) => t.priority)));
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const dev = JSON.parse(readFileSync(DEV_TEMPLATES, 'utf8')) as LeadTemplate[];
  const devIds = new Set(dev.map((t) => t.id));
  const clash = templates.filter((t) => devIds.has(t.id)).map((t) => t.id);
  if (clash.length > 0) {
    console.error(`ids also used in the dev templates: ${clash.join(', ')}`);
    process.exit(1);
  }
  const devMessages = new Set(dev.map((t) => t.message.trim().toLowerCase()));
  const sameText = templates.filter((t) => devMessages.has(t.message.trim().toLowerCase())).map((t) => t.id);
  if (sameText.length > 0) {
    console.error(`message text identical to a dev template: ${sameText.join(', ')}`);
    process.exit(1);
  }
  console.log('ok');
  process.exit(0);
}

const hasHeldout = existsSync(HELDOUT_TEMPLATES);
if (!hasHeldout) console.warn('no held-out templates yet: only the dev split will be built');

const dev = build('dev');
const test = hasHeldout ? build('test') : undefined;
const manifestText = `${JSON.stringify(manifest({ dev: dev.summary, ...(test ? { test: test.summary } : {}) }), null, 2)}\n`;

if (args.has('--check')) {
  const outputs: Array<[string, string]> = [
    [path.join(LEADS_DIR, dev.spec.out), dev.jsonl],
    [path.join(LEADS_DIR, 'MANIFEST.json'), manifestText],
  ];
  if (test) outputs.push([path.join(LEADS_DIR, test.spec.out), test.jsonl]);
  let ok = true;
  for (const [file, expected] of outputs) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== expected) {
      console.error(`does not match a fresh run: ${path.relative(ROOT, file)}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log('committed leads match a fresh run');
  process.exit(0);
}

writeFileSync(path.join(LEADS_DIR, dev.spec.out), dev.jsonl);
if (test) writeFileSync(path.join(LEADS_DIR, test.spec.out), test.jsonl);
writeFileSync(path.join(LEADS_DIR, 'MANIFEST.json'), manifestText);
console.log(`dev: ${dev.summary.count} leads from ${dev.summary.template_count} templates`);
if (test) console.log(`test: ${test.summary.count} leads from ${test.summary.template_count} templates`);
