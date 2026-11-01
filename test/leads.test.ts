// Checks on the generator and on the committed lead files. These read the held-out
// file only through code and never print its text, because the prompt must not be
// tuned against it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createRng, generateLeads, slotsIn, toJsonl, validateTemplates } from '../src/leads/generate.ts';
import { CATEGORIES } from '../src/leads/types.ts';
import type { LabeledLead, LeadTemplate } from '../src/leads/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const readLeads = (file: string): LabeledLead[] => read(file).trim().split('\n').map((line) => JSON.parse(line) as LabeledLead);

const devTemplates = JSON.parse(read('data/templates/dev.templates.json')) as LeadTemplate[];
const devLeads = readLeads('data/leads/dev.synthetic.jsonl');
const hasHeldout = existsSync(path.join(ROOT, 'data/templates/heldout.templates.json')) && existsSync(path.join(ROOT, 'data/leads/test.synthetic.jsonl'));
const testLeads = hasHeldout ? readLeads('data/leads/test.synthetic.jsonl') : [];
const allLeads = [...devLeads, ...testLeads];

describe('generator', () => {
  test('the same seed gives the same bytes', () => {
    const a = toJsonl(generateLeads({ seed: 7, count: 50, split: 'dev', templates: devTemplates }));
    const b = toJsonl(generateLeads({ seed: 7, count: 50, split: 'dev', templates: devTemplates }));
    assert.equal(a, b);
  });

  test('a different seed gives different leads', () => {
    const a = toJsonl(generateLeads({ seed: 7, count: 50, split: 'dev', templates: devTemplates }));
    const b = toJsonl(generateLeads({ seed: 8, count: 50, split: 'dev', templates: devTemplates }));
    assert.notEqual(a, b);
  });

  test('the count is exact and IDs are unique', () => {
    const leads = generateLeads({ seed: 11, count: 73, split: 'test', templates: devTemplates });
    assert.equal(leads.length, 73);
    assert.equal(new Set(leads.map((l) => l.id)).size, 73);
    assert.ok(leads.every((l) => l.id.startsWith('L-TEST-')));
  });

  test('createRng stays in range and is repeatable', () => {
    const rng = createRng(1);
    const values = Array.from({ length: 1000 }, () => rng.next());
    assert.ok(values.every((v) => v >= 0 && v < 1));
    assert.equal(createRng(1).next(), values[0]);
    assert.ok(new Set(values).size > 990);
  });

  test('resubmissions copy their source form and label', () => {
    const leads = generateLeads({ seed: 3, count: 100, split: 'dev', templates: devTemplates });
    const copies = leads.filter((l) => l.generator.resubmission_of);
    assert.equal(copies.length, 3);
    for (const copy of copies) {
      const source = leads.find((l) => l.id === copy.generator.resubmission_of)!;
      assert.deepEqual(copy.form, source.form);
      assert.equal(copy.label.category, source.label.category);
      assert.ok(Date.parse(copy.submitted_at) > Date.parse(source.submitted_at));
    }
  });

  describe('template validation', () => {
    const good: LeadTemplate = {
      id: 'x-1',
      category: 'spam',
      priority: 'low',
      difficulty: 'easy',
      form: { inquiry_type: 'other', region: 'in_area', email_kind: 'freemail', company_kind: 'none', title_kind: 'none' },
      message: 'hello {first}',
    };
    test('a good template passes', () => assert.deepEqual(validateTemplates([good]), []));
    test('it catches an unknown slot by name and does not repeat the text', () => {
      const problems = validateTemplates([{ ...good, message: 'secret words {nope}' }]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /unknown slot "nope"/);
      assert.equal(problems[0].includes('secret words'), false);
    });
    test('it catches duplicate IDs, bad enums, and {company} with no company', () => {
      assert.match(validateTemplates([good, good])[0], /duplicate id/);
      assert.match(validateTemplates([{ ...good, category: 'nope' as LeadTemplate['category'] }])[0], /bad category/);
      assert.match(validateTemplates([{ ...good, message: '{company}' }])[0], /company_kind none/);
    });
    test('it enforces the priority rules in the labeling guide', () => {
      assert.match(validateTemplates([{ ...good, priority: 'high' }])[0], /must be low priority/);
      assert.match(validateTemplates([{ ...good, category: 'sales_ready', priority: 'low' }])[0], /cannot be low/);
      assert.match(validateTemplates([{ ...good, category: 'needs_info', priority: 'high' }])[0], /cannot be high/);
    });
    test('slotsIn finds slots', () => assert.deepEqual(slotsIn('{a_b} x {c}'), ['a_b', 'c']));
  });
});

describe('committed leads', () => {
  test('every dev template passes validation', () => {
    assert.deepEqual(validateTemplates(devTemplates), []);
  });

  test('every lead is marked synthetic, in the file name and in the record', () => {
    assert.ok(allLeads.length > 0);
    assert.ok(allLeads.every((l) => l.synthetic === true));
    const manifest = JSON.parse(read('data/leads/MANIFEST.json')) as { synthetic: boolean; splits: Record<string, { file: string }> };
    assert.equal(manifest.synthetic, true);
    for (const split of Object.values(manifest.splits)) assert.match(split.file, /synthetic/);
  });

  test('every email is on a domain reserved for documentation', () => {
    for (const lead of allLeads) {
      assert.match(lead.form.email, /^[^@\s]+@([a-z0-9-]+\.)*example\.(com|net|org)$/, lead.id);
    }
  });

  test('every phone number is in the 555-01xx block, in the form field and in message text', () => {
    const phone = /\+?1?[-. (]*\d{3}[-. )]*\d{3}[-. ]*\d{4}\b/g;
    for (const lead of allLeads) {
      if (lead.form.phone) assert.match(lead.form.phone, /^\+1-\d{3}-555-01\d{2}$/, lead.id);
      for (const match of lead.form.message.match(phone) ?? []) {
        assert.match(match, /555[-. ]?01\d{2}$/, lead.id);
      }
    }
  });

  test('every URL is on a reserved domain', () => {
    for (const lead of allLeads) {
      for (const url of `${lead.form.website} ${lead.form.message}`.match(/https?:\/\/[^\s)]+/g) ?? []) {
        // A URL can end a sentence, so trailing punctuation isn't part of it.
        const host = new URL(url.replace(/[.,;:!?'"]+$/, '')).hostname;
        assert.match(host, /(^|\.)example\.(com|net|org)$/, lead.id);
      }
    }
  });

  test('form fields carry no label, ID or generator data', () => {
    const allowed = ['company', 'customer_number', 'email', 'first_name', 'hp_field', 'inquiry_type', 'job_title', 'last_name', 'message', 'phone', 'property_city', 'property_state', 'website'];
    for (const lead of allLeads) assert.deepEqual(Object.keys(lead.form).sort(), allowed, lead.id);
  });

  test('no unfilled slots remain in any message', () => {
    for (const lead of allLeads) assert.equal(/\{[a-z_]+\}/.test(lead.form.message), false, lead.id);
  });

  test('the dev set covers every category', () => {
    for (const category of CATEGORIES) {
      assert.ok(devLeads.filter((l) => l.label.category === category).length >= 10, category);
    }
  });

  test('the committed files match a fresh run from the seed', () => {
    const out = execFileSync(process.execPath, ['scripts/gen-leads.ts', '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /match a fresh run/);
  });

  test('the manifest hashes match the files', () => {
    const manifest = JSON.parse(read('data/leads/MANIFEST.json')) as { splits: Record<string, { file: string; sha256: string; count: number }> };
    for (const split of Object.values(manifest.splits)) {
      const text = read(split.file);
      assert.equal(createHash('sha256').update(text).digest('hex'), split.sha256);
      assert.equal(text.trim().split('\n').length, split.count);
    }
  });

  test('the held-out set shares no template, wording or ID with dev', { skip: !hasHeldout }, () => {
    const heldout = JSON.parse(read('data/templates/heldout.templates.json')) as LeadTemplate[];
    const devIds = new Set(devTemplates.map((t) => t.id));
    assert.ok(heldout.every((t) => !devIds.has(t.id)));
    const devText = new Set(devTemplates.map((t) => t.message.trim().toLowerCase()));
    assert.ok(heldout.every((t) => !devText.has(t.message.trim().toLowerCase())));
    assert.ok(testLeads.every((l) => !devIds.has(l.generator.template_id)));
    assert.ok(testLeads.every((l) => l.generator.split === 'test'));
    for (const category of CATEGORIES) {
      assert.ok(testLeads.filter((l) => l.label.category === category).length >= 10, category);
    }
  });
});
