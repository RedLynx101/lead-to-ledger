// Exports the workflow from the running n8n into the repo, dropping fields that only
// mean something on one instance: timestamps, version IDs, and which project owns it.
// test/workflow.test.ts then checks that the exported Code node still matches src/.
//
// Rules changed? Run build:workflow, restart n8n so it imports the new file, then this.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_ID } from './build-workflow.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const raw = execFileSync(
  'docker',
  ['compose', 'exec', '-T', 'n8n', 'sh', '-c', `n8n export:workflow --id=${WORKFLOW_ID} --pretty --output=/tmp/workflow.json >/dev/null 2>&1; cat /tmp/workflow.json`],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 10_000_000 },
);

const parsed = JSON.parse(raw) as Record<string, unknown> | Array<Record<string, unknown>>;
const exported = Array.isArray(parsed) ? parsed[0] : parsed;

const KEEP = ['id', 'name', 'nodes', 'connections', 'settings', 'pinData', 'meta', 'tags'];
const workflow: Record<string, unknown> = { active: false };
for (const key of KEEP) if (exported[key] !== undefined) workflow[key] = exported[key];

writeFileSync(path.join(ROOT, 'n8n/lead-intake.workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`exported ${(workflow.nodes as unknown[]).length} nodes to n8n/lead-intake.workflow.json`);
