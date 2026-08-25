/**
 * FinOptix Classifier — Complexity L1-L6 (FinOps domain)
 *
 * ★ The ONLY domain-specific code in the harness. Everything else
 *   (routing, budget, tracing) is delegated to the SSTTQ stack:
 *   Styrr (styrr-llm) + Sayay (sayay-guard) + Qhaway (qhaway).
 *
 * Levels:
 *   L1 Trivial     — glossary, yes/no
 *   L2 Simple      — single resource tag check, single TF audit
 *   L3 Medium      — multi-resource audit, cost JSON parse
 *   L4 Complex     — full architecture review, multi-account
 *   L5 Enterprise  — migration plan, executive comparisons
 *   L6 Hybrid      — L5 complexity, any tier, chained inference
 */

export type ComplexityLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export interface ClassifierFeatures {
  prompt: string;
  context: string;
  mode?: 'terraform' | 'cost' | 'byaml' | 'qa' | 'report' | 'code_gen' | 'executive' | 'general';
}

export interface ClassifiedRequest {
  level: ComplexityLevel;
  /** short human-readable reason chain */
  signals: string[];
  /** estimated prompt tokens (heuristic) */
  promptTokens: number;
  contextTokens: number;
  promptHash: string;
}

// ─── Feature extraction helpers ──────────────────────────────────────────

const ACTION_WORDS = ['audit', 'review', 'fix', 'optimize', 'migrate', 'compare', 'investigate', 'analyze'];
const SPIKE_WORDS = ['bill spike', 'cost spike', 'why did', 'expensive', 'higher than', 'anomal'];
const COMPARISON_WORDS = ['compare', 'versus', 'vs', 'migration', 'scenario', 'options'];
const SIMPLE_WORDS = ['what is', 'how much', 'define', 'explain', 'is t3', 'glossary', 'whats', "what's"];
const MULTI_ACCOUNT = /\baccounts?\b|\bmulti-account\b|\borg(-wide)?\b|\borganization\b/i;

function countResources(context: string): number {
  const regexes = [
    /resource\s+"[^"]+"/g, // terraform
    /"Type"\s*:\s*"[^"]+"/g, // CDK/CFN JSON
    /<code>/g, // byaml
  ];
  let count = 0;
  for (const re of regexes) count += (context.match(re) || []).length;
  return count;
}

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ─── Classifier ──────────────────────────────────────────────────────────

export function classify(input: ClassifierFeatures): ClassifiedRequest {
  const prompt = input.prompt.toLowerCase().trim();
  const context = input.context || '';
  const mode = input.mode;
  const promptTokens = Math.ceil(input.prompt.length / 4);
  const contextTokens = Math.ceil(context.length / 4);
  const resources = countResources(context);
  const signals: string[] = [];

  // ── Hard / mode-based overrides (highest priority) ──
  if (mode === 'executive') {
    signals.push(`mode=${mode} → always L5/L6`);
    return finish('L5', signals, promptTokens, contextTokens, prompt, context);
  }
  if (mode === 'report') {
    signals.push(`mode=${mode} → L4+`);
    return finish('L4', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── Context mass (large context ≠ simple) ──
  if (contextTokens > 2000) {
    signals.push(`contextTokens=${contextTokens} (>2000)`);
  }
  if (resources >= 10) signals.push(`resources=${resources} (≥10)`);
  if (resources >= 5) signals.push(`resources=${resources} (≥5)`);

  // ── L1: trivial glossary/Q&A ──
  if (promptTokens < 40 && SIMPLE_WORDS.some((w) => prompt.includes(w))) {
    signals.push('simple-word + short prompt');
    return finish('L1', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── L5: enterprise multi-step ──
  if (MULTI_ACCOUNT.test(prompt) || COMPARISON_WORDS.some((w) => prompt.includes(w))) {
    signals.push('multi-account/comparison → L5');
    return finish('L5', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── L4: complex multi-resource architecture ──
  if (resources >= 10 || contextTokens > 2000) {
    signals.push('multi-resource or large context → L4');
    return finish('L4', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── L3: medium depth needed (domain reasoning signals) ──
  if (resources >= 3 || ACTION_WORDS.some((w) => prompt.includes(w)) || SPIKE_WORDS.some((w) => prompt.includes(w))) {
    signals.push('action/spike word or ≥3 resources → L3');
    return finish('L3', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── L2: simple single-resource ──
  if (resources >= 1 || promptTokens < 150) {
    signals.push('single resource or short → L2');
    return finish('L2', signals, promptTokens, contextTokens, prompt, context);
  }

  // ── default L3 (finops reasoning is rarely trivial) ──
  signals.push('default → L3 (domain reasoning)');
  return finish('L3', signals, promptTokens, contextTokens, prompt, context);
}

function finish(
  level: ComplexityLevel,
  signals: string[],
  promptTokens: number,
  contextTokens: number,
  prompt: string,
  _context: string,
): ClassifiedRequest {
  return {
    level,
    signals,
    promptTokens,
    contextTokens,
    promptHash: djb2Hash(prompt),
  };
}

// ─── L1-L6 → model mapping (input into Styrr routing) ────────────────────

const ROUTING_TABLE: Record<ComplexityLevel, string> = {
  L1: 'finemma-4b',
  L2: 'finoptix-7b',
  L3: 'finoptix-14b',
  L4: 'finoptix-32b',
  L5: 'finomotrix-49b',
  L6: 'finomotrix-49b',
};

export function modelForLevel(level: ComplexityLevel, mode?: ClassifierFeatures['mode']): string {
  // mode-specific overrides
  if (mode === 'terraform' && (level === 'L1' || level === 'L2' || level === 'L3')) return 'finocode-7b';
  if (mode === 'code_gen') return 'finocode-7b';
  return ROUTING_TABLE[level];
}

export function isEnterpriseOnly(level: ComplexityLevel, tier: string): boolean {
  return level === 'L5' && tier !== 'enterprise';
}