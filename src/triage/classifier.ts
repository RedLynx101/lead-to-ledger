// Calls any OpenAI-compatible server and checks what comes back. It never throws for
// a bad model or a dead server: both are normal outcomes that decide.ts maps to what
// happens next. Base URL, model and key come from the caller, so a client can swap in
// their own.

import { checkOutput, TRIAGE_SCHEMA } from './schema.ts';
import type { TriageOutput } from './schema.ts';

export type ClassifierResult =
  | { status: 'ok'; output: TriageOutput; latencyMs: number; thinkingRemoved: boolean }
  | { status: 'invalid'; reason: 'empty' | 'not_json' | 'schema' | 'truncated'; problems: string[]; latencyMs: number }
  | { status: 'unavailable'; reason: string; latencyMs: number };

export interface ClassifierOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  system: string;
  user: string;
}

const THINKING_BLOCKS = [
  /<think>[\s\S]*?<\/think>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<\|channel\|>analysis[\s\S]*?<\|channel\|>final(<\|message\|>)?/gi,
];

/** Pulls the answer out of text that may have thinking around it. */
export function extractJson(content: string): { value: unknown; thinkingRemoved: boolean } | undefined {
  let text = content;
  for (const pattern of THINKING_BLOCKS) text = text.replace(pattern, '');
  // An unclosed thinking block means the model never got to an answer.
  text = text.replace(/<think>[\s\S]*$/i, '').trim();
  const thinkingRemoved = text.length !== content.trim().length;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return { value: JSON.parse(text), thinkingRemoved };
  } catch {
    // Fall through: there may be prose around the object.
  }
  // Take the last balanced object, since thinking tends to come first. Braces in
  // strings are skipped so a summary containing "{" can't end the scan early.
  let end = text.lastIndexOf('}');
  while (end > 0) {
    let depth = 0;
    let inString = false;
    for (let i = end; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (ch === '}') depth += 1;
      if (ch === '{') depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(i, end + 1)), thinkingRemoved: true };
        } catch {
          break;
        }
      }
    }
    end = text.lastIndexOf('}', end - 1);
  }
  return undefined;
}

export async function classify(options: ClassifierOptions): Promise<ClassifierResult> {
  const started = Date.now();
  const latency = () => Date.now() - started;
  let response: Response;
  let body: { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> };
  try {
    response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'lead_triage', strict: true, schema: TRIAGE_SCHEMA } },
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}`, latencyMs: latency() };
    body = (await response.json()) as typeof body;
  } catch (error) {
    const name = (error as Error).name;
    return { status: 'unavailable', reason: name === 'TimeoutError' ? 'timeout' : 'connection_failed', latencyMs: latency() };
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content.trim()) {
    if (choice?.finish_reason === 'length') return { status: 'invalid', reason: 'truncated', problems: ['ran out of tokens with no answer'], latencyMs: latency() };
    return { status: 'invalid', reason: 'empty', problems: ['no content'], latencyMs: latency() };
  }
  const extracted = extractJson(content);
  if (!extracted) {
    const reason = choice?.finish_reason === 'length' ? 'truncated' : 'not_json';
    return { status: 'invalid', reason, problems: ['no JSON object found'], latencyMs: latency() };
  }
  const checked = checkOutput(extracted.value);
  if (!checked.ok) return { status: 'invalid', reason: 'schema', problems: checked.problems, latencyMs: latency() };
  return { status: 'ok', output: checked.output, latencyMs: latency(), thinkingRemoved: extracted.thinkingRemoved };
}
