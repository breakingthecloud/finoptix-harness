import { describe, it, expect } from 'vitest';
import { classify, modelForLevel, isEnterpriseOnly } from '../src/classifier.js';
import { createFinopsAnalyst } from '../src/agent.js';
import { createHarness } from '../src/steering.js';

describe('FinOptix Agent (Bloque 2)', () => {
  it('creates FinOps Analyst agent with tools', () => {
    const agent = createFinopsAnalyst({ openrouterApiKey: 'sk-test' });
    expect(agent).toBeDefined();
    // Agent exposes tools internally — verify via config
    const cfg = (agent as unknown as { config: { tools: unknown[] } }).config;
    expect(cfg.tools.length).toBe(3);
  });

  it('cost_summary tool returns demo data', async () => {
    const agent = createFinopsAnalyst({ openrouterApiKey: 'sk-test' });
    const cfg = (agent as unknown as { config: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> } }).config;
    const costTool = cfg.tools.find((t) => t.name === 'cost_summary')!;
    const out = (await costTool.execute({ by: 'layer' })) as { total_graph_cost: number };
    expect(out.total_graph_cost).toBe(845.32);
  });

  it('blast_radius BFS finds downstream nodes', async () => {
    const agent = createFinopsAnalyst({ openrouterApiKey: 'sk-test' });
    const cfg = (agent as unknown as { config: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> } }).config;
    const tool = cfg.tools.find((t) => t.name === 'blast_radius')!;
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const out = (await tool.execute({ node_id: 'a', graph })) as { affected: string[]; count: number };
    expect(out.affected).toEqual(['b', 'c']);
    expect(out.count).toBe(2);
  });

  it('remediation_plan maps findings to steps', async () => {
    const agent = createFinopsAnalyst({ openrouterApiKey: 'sk-test' });
    const cfg = (agent as unknown as { config: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> } }).config;
    const tool = cfg.tools.find((t) => t.name === 'remediation_plan')!;
    const out = (await tool.execute({
      findings: [
        { resource: 'rds-main', issue: 'over-provisioned', savings_usd: 40 },
        { resource: 'ec2-staging', issue: 'idle', savings_usd: 30 },
      ],
    })) as { steps: unknown[]; total_estimated_savings_usd: number };
    expect(out.steps.length).toBe(2);
    expect(out.total_estimated_savings_usd).toBe(70);
  });

  it('steering tier gate blocks L5 for free tier', async () => {
    const harness = createHarness({
      openrouterApiKey: 'sk-test',
      modelRegistry: ['finoptix-14b', 'finoptix-7b'],
      budgetUsd: { free: 0.5, pro: 2, enterprise: 9999 },
    });
    const result = await harness.steer({
      prompt: 'Compare costs across my 5 accounts and recommend a migration plan',
      context: '',
      userId: 'u1',
      tier: 'free',
    });
    expect(result.metadata.blocked).toBe(true);
    expect(result.metadata.block_reason).toBe('upgrade_to_enterprise');
  });
});

// classify re-export sanity (worker uses it)
describe('classify re-export', () => {
  it('exports classifier helpers', () => {
    expect(typeof classify).toBe('function');
    expect(modelForLevel('L1')).toBe('finemma-4b');
    expect(isEnterpriseOnly('L5', 'pro')).toBe(true);
  });
});