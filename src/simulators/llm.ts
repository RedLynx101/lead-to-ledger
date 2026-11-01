// A stand-in for an OpenAI-compatible model server. It is not a model: it answers from a
// few keyword checks, so the whole path can run with no GPU, and tests can force the bad
// outputs a real model produces only sometimes. Scores never come from this file.

import type { SimRequest, SimResponse, Vendor } from './harness.ts';

export interface LlmConfig {
  /** When set, every completion returns exactly this text. */
  raw: string | null;
  /** Prepends thinking text to the answer, as some local models do. */
  thinking: boolean;
  confidence: number;
}

const DEFAULTS: LlmConfig = { raw: null, thinking: false, confidence: 0.9 };

function keywordAnswer(userMessage: string, confidence: number) {
  let form: { message?: string; inquiry_dropdown?: string } = {};
  try {
    form = JSON.parse(userMessage);
  } catch {
    // Not the shape this repo sends; answer anyway.
  }
  const text = (form.message ?? userMessage).toLowerCase();
  const answer = (category: string, priority: string, summary: string) => ({ category, priority, summary, confidence });
  if (/\b(hiring|apprentice|internship|looking for work|openings?)\b/.test(text)) return answer('job_seeker', 'low', 'Asking about a job.');
  if (/\b(we help|our software|wholesale|staffing|free trial|financing)\b/.test(text)) return answer('vendor_pitch', 'low', 'Selling something.');
  if (/\b(ticket|invoice|contract|renew)\b/.test(text)) return answer('existing_customer', /\bdown\b/.test(text) ? 'high' : 'normal', 'Writing about current service.');
  if (/\b(prize|widow|asdf|lorem)\b/.test(text)) return answer('spam', 'low', 'No business purpose.');
  if (/\b(sq ft|units?|rtus?|chiller|boiler)\b/.test(text)) {
    return answer('sales_ready', /\b(down|today|asap|no heat)\b/.test(text) ? 'high' : 'normal', 'Asking about HVAC work on a building.');
  }
  return answer('needs_info', 'normal', 'Not enough detail to act on.');
}

export function createLlmSim(overrides: Partial<LlmConfig> = {}): Vendor {
  const config: LlmConfig = { ...DEFAULTS, ...overrides };
  let calls = 0;
  let forcedDown = false;

  const vendor: Vendor = {
    name: 'llm',

    handle(req: SimRequest): SimResponse {
      if (req.path === '/v1/models' && req.method === 'GET') {
        return { status: 200, body: { object: 'list', data: [{ id: 'scripted-stand-in', object: 'model' }] } };
      }
      if (req.path === '/v1/chat/completions' && req.method === 'POST') {
        if (forcedDown) return { status: 503, body: { error: { message: 'model unavailable', type: 'server_error' } } };
        calls += 1;
        const body = (req.json ?? {}) as { messages?: Array<{ role: string; content: string }> };
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        let content = config.raw ?? JSON.stringify(keywordAnswer(user, config.confidence));
        if (config.thinking) content = `<think>The user wants a category. Let me reason about {this} lead.</think>\n${content}`;
        return {
          status: 200,
          body: {
            id: `chatcmpl-sim-${calls}`,
            object: 'chat.completion',
            model: 'scripted-stand-in',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
        };
      }
      return { status: 404, body: { error: { message: 'not found', type: 'invalid_request_error' } } };
    },

    errorFor(status) {
      if (status === 502 || status === 503 || status === 504) {
        return { status, headers: { 'content-type': 'text/html' }, body: `<html><body>${status}</body></html>` };
      }
      return { status, body: { error: { message: 'injected failure', type: 'server_error' } } };
    },

    expireToken() {
      forcedDown = true;
    },
    restoreToken() {
      forcedDown = false;
    },

    snapshot() {
      return { calls, config, down: forcedDown };
    },

    reset() {
      calls = 0;
      forcedDown = false;
      Object.assign(config, DEFAULTS, overrides);
    },

    configure(patch) {
      Object.assign(config, patch);
      return { ...config };
    },
  };
  return vendor;
}
