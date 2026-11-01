// The strict schema the model answers against. The same object is sent to the model
// server as response_format and checked again here, because a server's strict mode
// is a convenience, not a guarantee.

import { Ajv } from 'ajv';

export const TRIAGE_CATEGORIES = ['sales_ready', 'needs_info', 'not_a_fit', 'existing_customer', 'vendor_pitch', 'job_seeker', 'spam'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

export interface TriageOutput {
  category: TriageCategory;
  priority: TriagePriority;
  summary: string;
  confidence: number;
}

export const SUMMARY_MAX = 240;

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: [...TRIAGE_CATEGORIES] },
    priority: { type: 'string', enum: [...TRIAGE_PRIORITIES] },
    summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['category', 'priority', 'summary', 'confidence'],
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(TRIAGE_SCHEMA);

export function checkOutput(value: unknown): { ok: true; output: TriageOutput } | { ok: false; problems: string[] } {
  if (validate(value)) return { ok: true, output: value as unknown as TriageOutput };
  return { ok: false, problems: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`) };
}
