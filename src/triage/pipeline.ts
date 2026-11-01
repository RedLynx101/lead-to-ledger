// The sorting logic with no database or HTTP around it: rules, then the model, then
// the checks. The live service and the scoring run both call this, so what gets
// scored is what would run.

import { businessConfig, rulesConfig, triageConfig } from '../config.ts';
import type { LlmSettings, TriageConfig } from '../config.ts';
import { sortLead } from '../rules/rules.ts';
import type { RuleDecision } from '../rules/rules.ts';
import { classify } from './classifier.ts';
import type { ClassifierResult } from './classifier.ts';
import { decideFromModel, decideFromRule } from './decide.ts';
import type { TriageDecision } from './decide.ts';
import { buildSystemPrompt, buildUserMessage, toModelInput } from './prompt.ts';
import type { FormForModel } from './prompt.ts';

export interface PipelineForm extends FormForModel {
  hp_field: string;
}

export const SYSTEM_PROMPT = buildSystemPrompt(businessConfig);

export function classifyForm(form: PipelineForm, llm: LlmSettings, config: TriageConfig = triageConfig): Promise<ClassifierResult> {
  return classify({
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKey: llm.apiKey,
    temperature: config.llm.temperature,
    maxTokens: config.llm.max_tokens,
    timeoutMs: config.llm.timeout_ms,
    system: SYSTEM_PROMPT,
    user: buildUserMessage(toModelInput(form, rulesConfig)),
  });
}

export interface PipelineResult {
  decision: TriageDecision;
  classifier: ClassifierResult | null;
}

/** `rule` is passed in when n8n has already run the rules; otherwise they run here. */
export async function runPipeline(
  form: PipelineForm,
  llm: LlmSettings,
  options: { rule?: RuleDecision | null; config?: TriageConfig } = {},
): Promise<PipelineResult> {
  const config = options.config ?? triageConfig;
  const rule = options.rule !== undefined ? options.rule : sortLead(form, rulesConfig);
  if (rule) return { decision: decideFromRule(rule), classifier: null };
  const classifier = await classifyForm(form, llm, config);
  const decision = decideFromModel(classifier, { model: llm.model, confidenceMin: config.confidence_min, message: form.message });
  return { decision, classifier };
}
