// Turns a rule hit or a classifier result into exactly what may land in the CRM.
// Plain code, no model, so each failure row in the README maps to a branch here.
//
//   invalid JSON or unknown category -> no AI answer written, flagged for review
//   low confidence                   -> a summary but no category, flagged for review
//   model down                       -> nothing written, alert raised
//   text that tries to steer a reader -> kept, but flagged for review

import type { ClassifierResult } from './classifier.ts';
import type { RuleDecision } from '../rules/rules.ts';
import type { TriageCategory, TriagePriority } from './schema.ts';

export type Outcome = 'rule' | 'ok' | 'low_confidence' | 'invalid_output' | 'model_unavailable';

/** The only properties this code path may send to the CRM. */
export const AI_FIELD_NAMES = ['ai_category', 'ai_priority', 'ai_summary', 'ai_confidence', 'ai_needs_review', 'ai_source', 'ai_model'] as const;
export type AiFieldName = (typeof AI_FIELD_NAMES)[number];
export type AiFields = Partial<Record<AiFieldName, string | number | boolean>>;

export interface TriageDecision {
  outcome: Outcome;
  route: 'rule' | 'model';
  ruleId: string | null;
  category: TriageCategory | null;
  priority: TriagePriority | null;
  summary: string | null;
  confidence: number | null;
  needsReview: boolean;
  /** Exactly what a live write would send. Empty means nothing is written. */
  fields: AiFields;
  skipCrm: boolean;
  alert: string | null;
  detail: string | null;
}

// A coarse flag, not a defense: the defense is that output can only land in ai_ fields,
// from a fixed list. This just makes sure a person looks at an obvious attempt.
const STEERING = /\b(ignore|disregard|forget)\b.{0,40}\b(instruction|prompt|rule)s?\b|\b(system|assistant)\s*:|\b(classify|mark|label|set|flag|treat)\b.{0,40}\b(sales_ready|high priority|priority (to )?high|qualified|hot lead)\b|\b(note|message|instruction)s? (to|for) (any |the )?(ai|bot|assistant|model|classifier|llm)\b/i;

export function looksLikeSteering(message: string): boolean {
  return STEERING.test(message);
}

function cleanSummary(summary: string): string {
  return summary
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Priorities the labeling guide fixes by category, enforced whatever the model said. */
function normalizePriority(category: TriageCategory, priority: TriagePriority): TriagePriority {
  switch (category) {
    case 'not_a_fit':
    case 'vendor_pitch':
    case 'job_seeker':
    case 'spam':
      return 'low';
    case 'sales_ready':
    case 'existing_customer':
      return priority === 'low' ? 'normal' : priority;
    case 'needs_info':
      return priority === 'high' ? 'normal' : priority;
  }
}

export function decideFromRule(rule: RuleDecision): TriageDecision {
  const fields: AiFields = rule.skip_crm
    ? {}
    : { ai_category: rule.category, ai_priority: rule.priority, ai_summary: rule.reason, ai_needs_review: false, ai_source: 'rule' };
  return {
    outcome: 'rule',
    route: 'rule',
    ruleId: rule.rule_id,
    category: rule.category as TriageCategory,
    priority: rule.priority as TriagePriority,
    summary: rule.reason,
    confidence: null,
    needsReview: false,
    fields,
    skipCrm: rule.skip_crm,
    alert: null,
    detail: null,
  };
}

export function decideFromModel(result: ClassifierResult, options: { model: string; confidenceMin: number; message: string }): TriageDecision {
  const base = { route: 'model' as const, ruleId: null, skipCrm: false };

  if (result.status === 'unavailable') {
    return {
      ...base,
      outcome: 'model_unavailable',
      category: null,
      priority: null,
      summary: null,
      confidence: null,
      needsReview: false,
      fields: {},
      alert: 'model_unavailable',
      detail: result.reason,
    };
  }
  if (result.status === 'invalid') {
    return {
      ...base,
      outcome: 'invalid_output',
      category: null,
      priority: null,
      summary: null,
      confidence: null,
      needsReview: true,
      fields: { ai_needs_review: true, ai_source: 'model', ai_model: options.model },
      alert: null,
      detail: `${result.reason}: ${result.problems.join('; ').slice(0, 300)}`,
    };
  }

  const { output } = result;
  const summary = cleanSummary(output.summary);
  const steering = looksLikeSteering(options.message);

  if (output.confidence < options.confidenceMin) {
    return {
      ...base,
      outcome: 'low_confidence',
      category: null,
      priority: null,
      summary,
      confidence: output.confidence,
      needsReview: true,
      fields: { ai_summary: summary, ai_confidence: output.confidence, ai_needs_review: true, ai_source: 'model', ai_model: options.model },
      alert: null,
      detail: `model said ${output.category}`,
    };
  }

  const priority = normalizePriority(output.category, output.priority);
  return {
    ...base,
    outcome: 'ok',
    category: output.category,
    priority,
    summary,
    confidence: output.confidence,
    needsReview: steering,
    fields: {
      ai_category: output.category,
      ai_priority: priority,
      ai_summary: summary,
      ai_confidence: output.confidence,
      ai_needs_review: steering,
      ai_source: 'model',
      ai_model: options.model,
    },
    alert: null,
    detail: steering ? 'message looks like it tries to steer a reader' : null,
  };
}
