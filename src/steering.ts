/**
 * FinOptix Steering Layer — wires Classifier + Styrr + Sayay + Qhaway
 *
 * This is the "smart" glue of the harness (Router Phase A):
 *   1. classify() the request → L1-L6 (our domain code)
 *   2. sayayGuard.check(userId, cost) → allow/warn/degrade/block (budget + tier)
 *   3. styrrRouter.call() with the chosen model + fallback chain
 *   4. qhaway records the span (model, latency, tokens, cost)
 */

import { StyrRouter } from '@carloscortezcloud/styrr-llm';
import { SayayGuard, MemoryStorage as SayayMemory } from '@carloscortezcloud/sayay-guard';
import { MemoryStorage as QhawayMemory } from '@carloscortezcloud/qhaway';
import {
  classify,
  modelForLevel,
  isEnterpriseOnly,
  type ComplexityLevel,
  type ClassifierFeatures,
} from './classifier.js';

export interface SteerRequest extends ClassifierFeatures {
  userId: string;
  tier: 'free' | 'pro' | 'enterprise';
}

export interface SteerResult {
  analysis: string;
  metadata: {
    model_used: string;
    complexity_detected: ComplexityLevel;
    signals: string[];
    latency_ms: number;
    tokens_used: number;
    cost_usd: number;
    usage_pct: number;
    routed_reason: string;
    blocked?: boolean;
    block_reason?: string;
  };
}

export interface HarnessConfig {
  openrouterApiKey: string;
  /** model ids as registered in Styrr (FinOptix family + fallbacks) */
  modelRegistry: string[];
  /** daily budget caps in USD, keyed by tier */
  budgetUsd: Record<'free' | 'pro' | 'enterprise', number>;
  agentName?: string;
}

export function createHarness(config: HarnessConfig) {
  const styrr = new StyrRouter({
    apiKey: config.openrouterApiKey,
    models: config.modelRegistry.map((id) => ({ id })),
    strategy: 'fallback',
  });

  const sayay = new SayayGuard({
    storage: new SayayMemory(),
    budget: { dailyUsd: config.budgetUsd.pro },
    onExceeded: 'block',
    degradeThreshold: 80,
    warnThreshold: 60,
  });

  // Qhaway feeds the adaptive-classifier (R1/R2) — every decision is traced
  const qhaway = new QhawayMemory();

  async function steer(req: SteerRequest): Promise<SteerResult> {
    const start = Date.now();
    const cls = classify({ prompt: req.prompt, context: req.context, mode: req.mode });
    const reasonParts = [`complexity=${cls.level}`, `mode=${req.mode ?? 'none'}`, `tier=${req.tier}`];

    // ── 1. Tier gating (L5 = enterprise unless hybrid L6 with map-reduce)
    if (isEnterpriseOnly(cls.level, req.tier)) {
      const blocked: SteerResult = {
        analysis: 'Complex enterprise analysis (L5) requires the Enterprise tier.',
        metadata: {
          model_used: 'none',
          complexity_detected: cls.level,
          signals: cls.signals,
          latency_ms: Date.now() - start,
          tokens_used: 0,
          cost_usd: 0,
          usage_pct: 0,
          routed_reason: 'tier gate: L5 requires enterprise',
          blocked: true,
          block_reason: 'upgrade_to_enterprise',
        },
      };
      return blocked;
    }

    // ── 2. Sayay budget check → allow/warn/degrade/block
    const decision = await sayay.check(req.userId, estimateCost(cls.level));
    if (decision.action === 'block') {
      const blocked: SteerResult = {
        analysis: 'Budget exhausted. Upgrade to Pro or wait for daily reset.',
        metadata: {
          model_used: 'none',
          complexity_detected: cls.level,
          signals: cls.signals,
          latency_ms: Date.now() - start,
          tokens_used: 0,
          cost_usd: 0,
          usage_pct: decision.usagePercent,
          routed_reason: `sayay block: ${decision.reason ?? 'budget exhausted'}`,
          blocked: true,
          block_reason: 'budget_exhausted',
        },
      };
      return blocked;
    }

    // ── 3. Styrr routing (model chosen by classifier; degrade suggestion from Sayay)
    const preferred = modelForLevel(cls.level, req.mode);
    const modelId =
      decision.action === 'degrade' && decision.suggestedModel
        ? decision.suggestedModel
        : preferred;
    reasonParts.push(`model=${modelId}`);
    reasonParts.push(`sayay=${decision.action}(${decision.usagePercent}%)`);

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: req.context ? `${req.context}\n\n${req.prompt}` : req.prompt },
    ];

    try {
      const response = await styrr.call(messages, { strategy: 'fallback' });
      const tokens = estimateTokens(response.text);
      const cost = tokens * modelCostPerToken(response.modelUsed);
      const usd = Number(cost.toFixed(6));
      await sayay.record(req.userId, usd);
      styrr.reportSuccess(response.modelUsed);

      const decisionAfter = await sayay.check(req.userId, 0);

      return {
        analysis: response.text,
        metadata: {
          model_used: response.modelUsed,
          complexity_detected: cls.level,
          signals: cls.signals,
          latency_ms: Date.now() - start,
          tokens_used: tokens,
          cost_usd: usd,
          usage_pct: decisionAfter.usagePercent,
          routed_reason: reasonParts.join(', '),
        },
      };
    } catch (err) {
      const model = (err as { model?: string }).model;
      if (model) styrr.reportFailure(model);
      throw err;
    }
  }

  return { steer, classify, styrr, sayay, qhaway };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function estimateCost(level: ComplexityLevel): number {
  const table: Record<ComplexityLevel, number> = {
    L1: 0.00005, L2: 0.0002, L3: 0.0004, L4: 0.001, L5: 0.003, L6: 0.003,
  };
  return table[level];
}

function modelCostPerToken(modelId: string): number {
  if (modelId.includes('4b')) return 0.0001 / 1000;
  if (modelId.includes('7b') && modelId.includes('code')) return 0.0003 / 1000;
  if (modelId.includes('7b')) return 0.0003 / 1000;
  if (modelId.includes('14b')) return 0.0006 / 1000;
  if (modelId.includes('32b')) return 0.002 / 1000;
  return 0.004 / 1000; // 49b
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SYSTEM_PROMPT = `You are FinOptix, a Principal Cloud Architect and FinOps Specialist.
Analyze cloud infrastructure, audit governance compliance for AWS, optimize configurations for cost efficiency.
Output structured reports with findings, estimated impact, and recommended fixes. Be concise and technical.`;