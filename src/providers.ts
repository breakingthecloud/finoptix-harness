/**
 * FinOptix Provider Registry — maps the logical FinOptix family to
 * servable model IDs (OpenRouter for now; HF/Modal/SageMaker later).
 *
 * The classifier emits logical names (finemma-4b, finoptix-7b, ...) —
 * that's the domain model from the SoW. This registry resolves those to
 * real provider IDs the router (Styrr) can call. When a FinOptix model
 * is served via a provider, just update resolve() — no logic changes.
 */

import type { ComplexityLevel } from './classifier.js';

export interface ProviderEntry {
  /** logical FinOptix family name */
  family: string;
  /** servable model id for Styrr/OpenRouter */
  providerModel: string;
  /** where it currently runs */
  host: 'openrouter' | 'huggingface' | 'modal' | 'sagemaker';
  /** cost per 1K tokens (approx, for sayay estimate) */
  usdPer1k: number;
}

// Family → real servable model (verified against OpenRouter /api/v1/models 2026-09)
export const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  'finemma-4b': { family: 'finemma-4b', providerModel: 'google/gemma-3-4b-it', host: 'openrouter', usdPer1k: 0.0001 },
  'finoptix-7b': { family: 'finoptix-7b', providerModel: 'google/gemma-3-12b-it', host: 'openrouter', usdPer1k: 0.0003 },
  'finocode-7b': { family: 'finocode-7b', providerModel: 'qwen/qwen3-coder', host: 'openrouter', usdPer1k: 0.0003 },
  'finoptix-14b': { family: 'finoptix-14b', providerModel: 'qwen/qwen3-14b', host: 'openrouter', usdPer1k: 0.0006 },
  'finoptix-32b': { family: 'finoptix-32b', providerModel: 'google/gemma-3-27b-it', host: 'openrouter', usdPer1k: 0.002 },
  'finomotrix-49b': { family: 'finomotrix-49b', providerModel: 'meta-llama/llama-3.3-70b-instruct', host: 'openrouter', usdPer1k: 0.004 },
};

/** resolve a logical family name → servable provider model id */
export function resolveModel(family: string): string {
  return PROVIDER_REGISTRY[family]?.providerModel ?? family;
}

/** default OpenRouter model list for an agent (fallback chain, all servable) */
export function defaultModelList(): string[] {
  return [
    PROVIDER_REGISTRY['finoptix-14b'].providerModel,
    PROVIDER_REGISTRY['finoptix-7b'].providerModel,
    PROVIDER_REGISTRY['finemma-4b'].providerModel,
  ];
}

/** map a classifier level to a SERVABLE model id (not logical) */
export function modelForLevelServable(level: ComplexityLevel, mode?: string): string {
  const logical = mode === 'terraform' || mode === 'code_gen'
    ? (level === 'L1' || level === 'L2' || level === 'L3' ? 'finocode-7b' : logicalFor(level))
    : logicalFor(level);
  return resolveModel(logical);
}

function logicalFor(level: ComplexityLevel): string {
  const table: Record<ComplexityLevel, string> = {
    L1: 'finemma-4b',
    L2: 'finoptix-7b',
    L3: 'finoptix-14b',
    L4: 'finoptix-32b',
    L5: 'finomotrix-49b',
    L6: 'finomotrix-49b',
  };
  return table[level];
}