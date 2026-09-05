/**
 * FinOptix Agent — FinOps Analyst (Bloque 2)
 *
 * Tinkuy Agent with:
 *  - router: Styrr (from steering harness)
 *  - guard: Sayay (budget/tier)
 *  - tools: FinOps tools (byaml-mcp operations via fetch, or demo mode)
 *  - hooks: Qhaway onComplete (tracing)
 *
 * This is the "harness v0.2" visible agent. Each tool maps to a byaml-mcp
 * operation (graph_from_evaluation, blast_radius, cost_summary, remediation).
 */

import { Agent, defineTool, type Tool, type AgentConfig } from '@carloscortezcloud/tinkuy-agent';
import { StyrRouter } from '@carloscortezcloud/styrr-llm';
import { SayayGuard, MemoryStorage } from '@carloscortezcloud/sayay-guard';
import { classify } from './classifier.js';
import { defaultModelList } from './providers.js';

// ─── Tool: Cost summary ──────────────────────────────────────────────────

export interface FinOpsToolContext {
  /** base URL of a byaml-mcp HTTP adapter (Phase B) or undefined for demo */
  byamlApiBase?: string;
  awsProfile?: string;
}

const costSummary = defineTool({
  name: 'cost_summary',
  description:
    'Get cost breakdown grouped by layer (compute, storage, network, data) for an architecture. Returns total graph cost and per-layer costs. Optionally accepts a graph; otherwise generates one from the AWS account.',
  parameters: {
    type: 'object',
    properties: {
      graph: { type: 'object', description: 'BYaML graph v0.4 (optional). If omitted, generated from account.' },
      by: { type: 'string', enum: ['layer', 'type', 'owner'], default: 'layer' },
    },
  },
  execute: async (args) => {
    if (args.byamlApiBase) {
      return fetch(`${args.byamlApiBase}/cost_summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph: args.graph, by: args.by ?? 'layer' }),
      }).then((r) => r.json());
    }
    // demo mode (no byaml API adapter yet)
    return {
      total_graph_cost: 845.32,
      layers: {
        compute: { cost: 512.4, resources: 14 },
        storage: { cost: 187.2, resources: 9 },
        network: { cost: 61.72, resources: 6 },
        data: { cost: 84.0, resources: 4 },
      },
      generated_from: 'demo (no byamlApiBase configured)',
    };
  },
});

const blastRadius = defineTool({
  name: 'blast_radius',
  description:
    'Find what breaks downstream if a node fails. Takes a node_id and a BYaML graph, returns the affected nodes (impact propagation). Use for risk analysis of a single resource.',
  parameters: {
    type: 'object',
    properties: {
      node_id: { type: 'string', description: 'ID of the node to analyze (e.g. payment-service)' },
      graph: { type: 'object', description: 'BYaML graph v0.4' },
      max_depth: { type: 'number', description: 'Max depth of propagation (default unlimited)' },
    },
    required: ['node_id', 'graph'],
  },
  execute: async (args) => {
    if (args.byamlApiBase) {
      return fetch(`${args.byamlApiBase}/blast_radius`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node_id: args.node_id, graph: args.graph, max_depth: args.max_depth }),
      }).then((r) => r.json());
    }
    // demo: compute downstream by simple BFS on the graph edges
    const graph = args.graph as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
    const start = args.node_id as string;
    const affected: string[] = [];
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of graph.edges ?? []) {
        if (e.from === cur && !seen.has(e.to)) queue.push(e.to);
      }
    }
    seen.delete(start);
    return { start, affected: [...seen], count: seen.size };
  },
});

const remediationPlan = defineTool({
  name: 'remediation_plan',
  description:
    'Convert a list of FinOps findings into an actionable IaC remediation plan. Each step includes the resource, the finding, the action, and a terraform snippet.',
  parameters: {
    type: 'object',
    properties: {
      findings: { type: 'array', description: 'List of findings (resource, severity, issue, savings_usd)' },
      graph: { type: 'object', description: 'BYaML graph v0.4 (optional)' },
    },
    required: ['findings'],
  },
  execute: async (args) => {
    if (args.byamlApiBase) {
      return fetch(`${args.byamlApiBase}/remediation_plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ findings: args.findings, graph: args.graph }),
      }).then((r) => r.json());
    }
    // demo remediation mapping
    const findings = args.findings as Array<{ resource: string; issue: string; savings_usd?: number }>;
    return {
      steps: findings.map((f) => ({
        resource: f.resource,
        finding: f.issue,
        action: 'rightsize|add_tag|add_lifecycle',
        estimated_savings_usd: f.savings_usd ?? 0,
        tf: '# terraform snippet generated in Phase B (byaml-mcp remediation)',
      })),
      total_estimated_savings_usd: findings.reduce((s, f) => s + (f.savings_usd ?? 0), 0),
    };
  },
});

// ─── FinOps Analyst agent ────────────────────────────────────────────────

export interface FinopsAnalystConfig {
  openrouterApiKey: string;
  modelRegistry?: string[];
  dailyBudgetUsd?: number;
  userId?: string;
  byamlApiBase?: string;
  awsProfile?: string;
  /** override system prompt for other agent types (auditor, investigator) */
  systemPrompt?: string;
  /** optional observability (Qhaway tracing + feedback) */
  obs?: {
    attach: (config: AgentConfig) => AgentConfig;
  };
}

const DEFAULT_MODELS = defaultModelList();

export const FINOPS_ANALYST_PROMPT = `You are FinOptix Analyst, a FinOps specialist agent.
You analyze cloud costs, find savings, and generate remediation plans.

Rules:
- Use cost_summary to understand spending before recommending anything.
- Use blast_radius before recommending any destructive/risky change (know what breaks).
- Use remediation_plan to turn findings into actionable IaC.
- Always report monthly savings in USD and mark risk (HIGH/MEDIUM).
- Be concise and technical. Output structured reports.`;

export function createFinopsAnalyst(cfg: FinopsAnalystConfig) {
  const router = new StyrRouter({
    apiKey: cfg.openrouterApiKey,
    models: (cfg.modelRegistry ?? DEFAULT_MODELS).map((id) => ({ id })),
    strategy: 'fallback',
  });

  const guard = new SayayGuard({
    storage: new MemoryStorage(),
    budget: { dailyUsd: cfg.dailyBudgetUsd ?? 1.0 },
    onExceeded: 'warn',
  });

  const toolCtx: FinOpsToolContext = {
    byamlApiBase: cfg.byamlApiBase,
    awsProfile: cfg.awsProfile,
  };

  const tools: Tool[] = [costSummary, blastRadius, remediationPlan].map((t) => ({
    ...t,
    execute: async (args) => {
      try {
        return await t.execute({ ...args, ...toolCtx });
      } catch (err) {
        return { error: String(err) };
      }
    },
  }));

  return new Agent(
    cfg.obs
      ? cfg.obs.attach({
          router,
          guard,
          userId: cfg.userId,
          tools,
          systemPrompt: cfg.systemPrompt ?? FINOPS_ANALYST_PROMPT,
          maxIterations: 5,
          onIteration: (e) => {
            console.log(`  ⚡ iter ${e.iteration} | ${e.modelUsed} | ${e.latencyMs}ms${e.hasToolCalls ? ' 🔧' : ''}`);
          },
          onToolCall: (e) => {
            console.log(`  🔧 ${e.tool}() → ${e.durationMs}ms${e.error ? ' ❌' : ' ✅'}`);
          },
          onComplete: (e) => {
            console.log(`  🏁 ${e.iterations} iters | models: ${e.modelsUsed.join(', ')} | ${e.totalLatencyMs}ms`);
          },
        })
      : {
          router,
          guard,
          userId: cfg.userId,
          tools,
          systemPrompt: cfg.systemPrompt ?? FINOPS_ANALYST_PROMPT,
          maxIterations: 5,
          onIteration: (e) => {
            console.log(`  ⚡ iter ${e.iteration} | ${e.modelUsed} | ${e.latencyMs}ms${e.hasToolCalls ? ' 🔧' : ''}`);
          },
          onToolCall: (e) => {
            console.log(`  🔧 ${e.tool}() → ${e.durationMs}ms${e.error ? ' ❌' : ' ✅'}`);
          },
          onComplete: (e) => {
            console.log(`  🏁 ${e.iterations} iters | models: ${e.modelsUsed.join(', ')} | ${e.totalLatencyMs}ms`);
          },
        },
  );
}

// Re-export classify so the worker can expose complexity in metadata
export { classify };