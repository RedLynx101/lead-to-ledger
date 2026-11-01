// Moves triage between shadow and live. Nothing writes to ai_ fields until this runs.
//
//   node scripts/set-mode.ts shadow
//   node scripts/set-mode.ts live --report results/scoring/test-final.json --signed-off-by "Name"
//
// Live needs a person's name and a scored run on the held-out set that met the pass
// bar. If it didn't, live still needs --below-bar "why", which is recorded. Rollback to
// shadow needs nothing and takes effect on the next lead.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../src/config.ts';
import { createDb, migrate } from '../src/db.ts';
import { recordModeChange } from '../src/triage/service.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    report: { type: 'string' },
    'signed-off-by': { type: 'string' },
    'below-bar': { type: 'string' },
  },
});

const mode = positionals[0];
if (mode !== 'shadow' && mode !== 'live') {
  console.error('usage: node scripts/set-mode.ts shadow | live --report <file> --signed-off-by "<name>" [--below-bar "<why>"]');
  process.exit(2);
}

const db = createDb();
await migrate(db);

if (mode === 'shadow') {
  await recordModeChange(db, { mode });
  console.log('mode: shadow. Nothing is written to ai_ fields from the next lead on.');
  await db.end();
  process.exit(0);
}

const fail = async (message: string) => {
  console.error(message);
  await db.end();
  process.exit(1);
};

if (!values['signed-off-by']) await fail('live needs --signed-off-by: a person signs off, not a script.');
if (!values.report) await fail('live needs --report: a scored run on the held-out set.');

const reportPath = path.resolve(ROOT, values.report!);
const text = readFileSync(reportPath, 'utf8');
const report = JSON.parse(text) as { meta: { split: string; synthetic: boolean }; metrics: { pass_bar: { passed: boolean; checks: Record<string, { pass: boolean }> } } };

if (report.meta.split !== 'test') await fail('the report must be a scored run on the held-out test split, not the dev split.');

if (!report.metrics.pass_bar.passed && !values['below-bar']) {
  const failed = Object.entries(report.metrics.pass_bar.checks).filter(([, c]) => !c.pass).map(([name]) => name);
  await fail(`refused: that run missed the pass bar on ${failed.join(', ')}. To go live anyway, say why with --below-bar. It is recorded.`);
}

await recordModeChange(db, {
  mode,
  signedOffBy: values['signed-off-by'],
  reportFile: path.relative(ROOT, reportPath).replaceAll('\\', '/'),
  reportSha256: createHash('sha256').update(text).digest('hex'),
  belowBarNote: report.metrics.pass_bar.passed ? null : values['below-bar'],
});
console.log(`mode: live, signed off by ${values['signed-off-by']}.${report.metrics.pass_bar.passed ? '' : ' Below the pass bar; the reason is recorded.'}`);
await db.end();
