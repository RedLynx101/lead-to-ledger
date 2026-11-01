// Settings come from the environment, with .env loaded in-process when present.
// Defaults point at the simulators, so nothing reaches a real service by accident.
// Nothing here logs a value.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RulesConfig } from './rules/rules.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env is fine: everything defaults to the simulators.
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8')) as T;
}

export interface BusinessConfig {
  name: string;
  what_it_does: string;
  sells: string;
  serves: string;
  service_area_cities: Record<string, string[]>;
  out_of_area_examples: string[];
  does_not_do: string;
}

export interface TriageConfig {
  prompt_version: string;
  confidence_min: number;
  llm: { temperature: number; max_tokens: number; timeout_ms: number };
  pass_bar: { category_accuracy: number; sales_ready_recall: number; real_lead_lost_rate_max: number; injection_steered_max: number };
}

export const businessConfig = readJson<BusinessConfig>('config/business.json');
export const rulesConfig = readJson<RulesConfig>('config/rules.json');
export const triageConfig = readJson<TriageConfig>('config/triage.json');

export interface LlmSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function llmSettings(): LlmSettings {
  return {
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:1234/v1',
    model: process.env.LLM_MODEL ?? 'prism-ml/bonsai-27b',
    apiKey: process.env.LLM_API_KEY ?? 'lm-studio',
  };
}

/**
 * Real services only when LTL_TARGET=real is set on purpose. Otherwise everything uses
 * the simulators and their made-up credentials, even if .env holds real ones.
 */
export function usingRealServices(): boolean {
  return process.env.LTL_TARGET === 'real';
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set when LTL_TARGET=real`);
  return value;
}

export function hubspotSettings() {
  const real = usingRealServices();
  return {
    baseUrl: process.env.HUBSPOT_BASE_URL ?? (real ? 'https://api.hubapi.com' : 'http://127.0.0.1:4010'),
    token: real ? required('HUBSPOT_TOKEN') : 'sim-hubspot-token',
    apiVersion: process.env.HUBSPOT_API_VERSION ?? '2026-09',
    wonStage: process.env.HUBSPOT_WON_STAGE ?? 'closedwon',
  };
}

export interface QuickBooksSettings {
  apiBaseUrl: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minorVersion: string;
  itemName: string;
}

export function quickbooksSettings(): QuickBooksSettings {
  const real = usingRealServices();
  // This repo creates invoices. It only ever points at Intuit's sandbox.
  if (real && process.env.INTUIT_ENVIRONMENT !== 'sandbox') {
    throw new Error('INTUIT_ENVIRONMENT must be sandbox. This repo does not run against production.');
  }
  const apiBaseUrl = process.env.QB_API_BASE_URL ?? (real ? 'https://sandbox-quickbooks.api.intuit.com' : 'http://127.0.0.1:4020');
  return {
    apiBaseUrl,
    discoveryUrl: real ? 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration' : `${apiBaseUrl}/.well-known/openid_sandbox_configuration`,
    clientId: real ? required('INTUIT_CLIENT_ID') : 'sim-client-id',
    clientSecret: real ? required('INTUIT_CLIENT_SECRET') : 'sim-client-secret',
    redirectUri: process.env.INTUIT_REDIRECT_URI ?? 'http://localhost:8765/callback',
    minorVersion: process.env.QB_MINOR_VERSION ?? '75',
    itemName: process.env.QB_ITEM_NAME ?? 'Services',
  };
}

export function databaseUrl(): string {
  if (process.env.LTL_DATABASE_URL) return process.env.LTL_DATABASE_URL;
  const password = process.env.LTL_PG_PASSWORD || 'ltl_local_only';
  const port = process.env.LTL_PG_PORT || '5433';
  return `postgres://ltl:${password}@127.0.0.1:${port}/ltl`;
}
