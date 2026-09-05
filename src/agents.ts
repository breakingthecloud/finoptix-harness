/**
 * FinOptix Multi-Agent (Bloque 4)
 *
 * Architecture Auditor + Cost Investigator + Context (TideRAG).
 *
 * Each agent is a Tinkuy Agent sharing the SSTTQ harness (Styrr router,
 * Sayay guard, Qhaway obs). Context comes from TideRAG (search_knowledge)
 * wrapped as a tool — namespace-scoped knowledge of architectures/docs.
 */

import { Agent, defineTool, type AgentConfig, type Tool } from '@carloscortezcloud/tinkuy-agent';
import { StyrRouter } from '@carloscortezcloud/styrr-llm';
import { SayayGuard, MemoryStorage as SayayMemoryStorage } from '@carloscortezcloud/sayay-guard';
import type { TideRAG } from '@carloscortezcloud/tiderag';
import { createFinopsAnalyst, FINOPS_ANALYST_PROMPT } from './agent.js';
import { defaultModelList } from './providers.js';
import { memoryTools, type MemoryStorage as FinoptixMemoryStorage } from './memory.js';

export interface AgentTier {
  openrouterApiKey: string;
  modelRegistry?: string[];
  dailyBudgetUsd?: number;
  userId?: string;
  byamlApiBase?: string;
  obs?: { attach: (config: AgentConfig) => AgentConfig };
  /** optional TideRAG instance for context-aware agents */
  rag?: TideRAG;
  ragNamespace?: string;
  /** optional memory storage (sqlite-memory-mcp contract) */
  memory?: FinoptixMemoryStorage;
}

// ─── TideRAG context tool ────────────────────────────────────────────────

function makeSearchKnowledge(rag?: TideRAG) {
  return defineTool({
    name: 'search_knowledge',
    description:
      'Search the knowledge base (architectures, docs, previous findings) for context relevant to the current task. Use before answering when the question references a known architecture or pattern.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "payment-service architecture", "EKS cost optimization")' },
        top_k: { type: 'number', description: 'Number of results (default 5)' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      if (!rag) return { error: 'TideRAG not configured — no knowledge base attached' };
      const results = await rag.query(args.query as string, {
        topK: (args.top_k as number) ?? 5,
      });
      return {
        results: results.map((r) => ({ text: r.text, score: r.score, metadata: r.metadata })),
        count: results.length,
      };
    },
  });
}

const AUDITOR_PROMPT = `You are FinOptix Architecture Auditor, a cloud architect agent.
You audit infrastructure for governance, compliance, and best practices (Well-Architected).

Rules:
- Before auditing an architecture, use search_knowledge to fetch its context if referenced.
- Use validate_byaml / graph_from_terraform (byaml-mcp) to check compliance.
- Report findings by severity (Critical/Warning/Info) with the exact fix.
- Use blast_radius before recommending risky changes.
- Be concise and technical.`;

const INVESTIGATOR_PROMPT = `You are FinOptix Cost Investigator, an anomaly detective agent.
You find root causes of cost spikes, predict trends, and recommend remediations.

Rules:
- Always use search_knowledge first if the anomaly references a known service/architecture.
- Use cost_summary and blast_radius to correlate cost with architecture.
- Use remediation_plan to turn findings into actionable steps.
- Report: what happened, root cause, impact (USD), recommended action.
- Be concise and technical.`;

// ─── Shared agent factory ────────────────────────────────────────────────

export type AgentKind = 'analyst' | 'auditor' | 'investigator';

const PROMPTS: Record<AgentKind, string> = {
  analyst: FINOPS_ANALYST_PROMPT,
  auditor: AUDITOR_PROMPT,
  investigator: INVESTIGATOR_PROMPT,
};

/** default model list per agent kind (servable providers) */
const DEFAULT_MODEL = {
  analyst: defaultModelList(),
  auditor: defaultModelList(),
  investigator: defaultModelList(),
};

export function createAgent(kind: AgentKind, cfg: AgentTier) {
  const router = new StyrRouter({
    apiKey: cfg.openrouterApiKey,
    models: (cfg.modelRegistry ?? DEFAULT_MODEL[kind]).map((id) => ({ id })),
    strategy: 'fallback',
  });

  const guard = new SayayGuard({
    storage: new SayayMemoryStorage(),
    budget: { dailyUsd: cfg.dailyBudgetUsd ?? 1.0 },
    onExceeded: 'warn',
  });

  const tools: Tool[] = [makeSearchKnowledge(cfg.rag), ...(cfg.memory ? memoryTools(cfg.memory) : [])];

  const config: AgentConfig = {
    router,
    guard,
    userId: cfg.userId,
    tools,
    systemPrompt: PROMPTS[kind],
    maxIterations: 6,
    onIteration: (e) => {
      console.log(`  ⚡ [${kind}] iter ${e.iteration} | ${e.modelUsed} | ${e.latencyMs}ms${e.hasToolCalls ? ' 🔧' : ''}`);
    },
    onToolCall: (e) => {
      console.log(`  🔧 [${kind}] ${e.tool}() → ${e.durationMs}ms${e.error ? ' ❌' : ' ✅'}`);
    },
    onComplete: (e) => {
      console.log(`  🏁 [${kind}] ${e.iterations} iters | models: ${e.modelsUsed.join(', ')} | ${e.totalLatencyMs}ms`);
    },
  };

  const agentConfig = cfg.obs ? cfg.obs.attach(config) : config;
  return new Agent(agentConfig);
}

// Convenience constructors
export function createArchAuditor(cfg: AgentTier) {
  return createAgent('auditor', cfg);
}
export function createCostInvestigator(cfg: AgentTier) {
  return createAgent('investigator', cfg);
}

// Reuse FinOps Analyst for kind=analyst but with RAG tool bound
export { createFinopsAnalyst };