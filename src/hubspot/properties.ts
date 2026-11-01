// The custom properties this repo adds to HubSpot, and the contact fields the form may
// set. Everything else on a contact, like lifecycle stage, lead status and owner, is
// left to the CRM's own process.

import { TRIAGE_CATEGORIES, TRIAGE_PRIORITIES } from '../triage/schema.ts';
import type { HubSpotClient } from './client.ts';

export const AI_GROUP = { name: 'ai_triage', label: 'AI triage' };

const options = (values: readonly string[]) => values.map((value, displayOrder) => ({ label: value, value, displayOrder }));

export const CONTACT_PROPERTIES = [
  { groupName: AI_GROUP.name, name: 'ai_category', label: 'AI category', type: 'enumeration', fieldType: 'select', options: options(TRIAGE_CATEGORIES) },
  { groupName: AI_GROUP.name, name: 'ai_priority', label: 'AI priority', type: 'enumeration', fieldType: 'select', options: options(TRIAGE_PRIORITIES) },
  { groupName: AI_GROUP.name, name: 'ai_summary', label: 'AI summary', type: 'string', fieldType: 'textarea' },
  { groupName: AI_GROUP.name, name: 'ai_confidence', label: 'AI confidence', type: 'number', fieldType: 'number' },
  {
    groupName: AI_GROUP.name,
    name: 'ai_needs_review',
    label: 'AI needs review',
    type: 'bool',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
  { groupName: AI_GROUP.name, name: 'ai_source', label: 'AI source', type: 'enumeration', fieldType: 'select', options: options(['rule', 'model']) },
  { groupName: AI_GROUP.name, name: 'ai_model', label: 'AI model', type: 'string', fieldType: 'text' },
  {
    groupName: AI_GROUP.name,
    name: 'ltl_synthetic',
    label: 'Synthetic test data',
    type: 'bool',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
];

export async function ensureProperties(client: HubSpotClient): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  results[`group:${AI_GROUP.name}`] = await client.createPropertyGroup('contacts', AI_GROUP.name, AI_GROUP.label);
  for (const definition of CONTACT_PROPERTIES) {
    results[definition.name] = await client.createProperty('contacts', definition);
  }
  return results;
}
