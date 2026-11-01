// Checks the committed n8n workflow against its source. It holds a copy of the rules, so
// this is what stops the copy drifting from what was tested and scored.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { codeNodeSource, WORKFLOW_ID } from '../scripts/build-workflow.ts';
import { rulesConfig } from '../src/config.ts';
import { contactProperties } from '../src/leads/contact.ts';
import type { LabeledLead } from '../src/leads/types.ts';
import { sortLead } from '../src/rules/rules.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown> & { jsCode?: string };
  onError?: string;
}
interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

const loaded = JSON.parse(readFileSync(path.join(ROOT, 'n8n/lead-intake.workflow.json'), 'utf8')) as Workflow | Workflow[];
const workflow = Array.isArray(loaded) ? loaded[0] : loaded;
const node = (name: string) => workflow.nodes.find((n) => n.name === name)!;
const text = JSON.stringify(workflow);

describe('the n8n workflow', () => {
  test('has the ID compose publishes', () => {
    assert.equal(workflow.id, WORKFLOW_ID);
    assert.ok(readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').includes(`--id=${WORKFLOW_ID}`));
  });

  test('its Code node matches the rules in src/', () => {
    assert.equal(node('Sort with rules').parameters.jsCode, codeNodeSource());
  });

  test('its Code node agrees with the TypeScript rules on every dev lead', () => {
    const run = new vm.Script(`(function ($json) {\n${codeNodeSource()}\n})`).runInNewContext({});
    const leads = readFileSync(path.join(ROOT, 'data/leads/dev.synthetic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LabeledLead);
    for (const lead of leads) {
      const result = run({ body: { submission_key: 'k', synthetic: true, form: lead.form } }).json;
      assert.deepEqual(JSON.parse(JSON.stringify(result.rule)), JSON.parse(JSON.stringify(sortLead(lead.form, rulesConfig))), lead.id);
      assert.deepEqual(JSON.parse(JSON.stringify(result.contact_input.properties)), JSON.parse(JSON.stringify(contactProperties(lead.form, true))), lead.id);
      assert.equal(result.contact_input.id, lead.form.email);
    }
  });

  test('every connection points at a node that exists', () => {
    const names = new Set(workflow.nodes.map((n) => n.name));
    for (const [from, outputs] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from), from);
      for (const branch of outputs.main) for (const edge of branch) assert.ok(names.has(edge.node), edge.node);
    }
  });

  test('the contact reaches the CRM before the AI step, so a dead model cannot lose it', () => {
    const edge = workflow.connections['Upsert contact in HubSpot'].main[0][0].node;
    assert.equal(edge, 'Triage: rules result or model');
    const skip = workflow.connections['Skip the CRM?'].main;
    assert.equal(skip[1][0].node, 'Upsert contact in HubSpot');
    assert.equal(skip[0][0].node, 'Triage: rules result or model');
  });

  test('failures have somewhere to go', () => {
    assert.equal(node('Upsert contact in HubSpot').onError, 'continueErrorOutput');
    assert.equal(node('Triage: rules result or model').onError, 'continueErrorOutput');
    assert.equal(workflow.connections['Upsert contact in HubSpot'].main[1][0].node, 'Alert: contact upsert failed');
    assert.equal(workflow.connections['Triage: rules result or model'].main[1][0].node, 'Alert: AI step down');
  });

  test('it holds no credentials: targets and tokens come from the environment', () => {
    assert.ok(text.includes('$env.HUBSPOT_TOKEN'));
    assert.ok(text.includes('$env.LTL_INTERNAL_TOKEN'));
    assert.equal(text.includes('sim-hubspot-token'), false);
    assert.equal(text.includes('Bearer pat-'), false);
    assert.equal(text.includes('local-only'), false);
  });

  test('it never writes an ai_ field or a CRM process field directly', () => {
    const upsert = JSON.stringify(node('Upsert contact in HubSpot').parameters);
    assert.equal(upsert.includes('ai_'), false);
    assert.equal(upsert.includes('lifecyclestage'), false);
    assert.equal(codeNodeSource().includes('ai_category'), false);
    assert.equal(codeNodeSource().includes('lifecyclestage: '), false);
  });

  test('compose binds every port to 127.0.0.1 and turns telemetry off', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const ports = [...compose.matchAll(/^\s+- "([^"]*:\d+:\d+|[^"]*:\$\{[^}]+\}:\d+)"$/gm)].map((m) => m[1]);
    assert.ok(ports.length >= 5);
    assert.ok(ports.every((p) => p.startsWith('127.0.0.1:')), ports.join(' '));
    assert.match(compose, /N8N_DIAGNOSTICS_ENABLED: "false"/);
    assert.match(compose, /N8N_VERSION_NOTIFICATIONS_ENABLED: "false"/);
    assert.match(compose, /N8N_TEMPLATES_ENABLED: "false"/);
    assert.match(compose, /n8nio\/n8n:\d+\.\d+\.\d+/);
  });
});
