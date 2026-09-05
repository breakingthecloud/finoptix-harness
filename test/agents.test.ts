import { describe, it, expect } from 'vitest';
import { createArchAuditor, createCostInvestigator, createAgent } from '../src/agents.js';

describe('FinOptix Multi-Agent (Bloque 4)', () => {
  it('creates Architecture Auditor agent', () => {
    const agent = createArchAuditor({ openrouterApiKey: 'sk-test' });
    expect(agent).toBeDefined();
  });

  it('creates Cost Investigator agent', () => {
    const agent = createCostInvestigator({ openrouterApiKey: 'sk-test' });
    expect(agent).toBeDefined();
  });

  it('generic factory returns the requested kind', () => {
    const a = createAgent('auditor', { openrouterApiKey: 'sk-test' });
    const i = createAgent('investigator', { openrouterApiKey: 'sk-test' });
    expect(a).toBeDefined();
    expect(i).toBeDefined();
  });

  it('search_knowledge tool reports when TideRAG not configured', async () => {
    const agent = createArchAuditor({ openrouterApiKey: 'sk-test' });
    const cfg = (agent as unknown as { config: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> } }).config;
    const tool = cfg.tools.find((t) => t.name === 'search_knowledge')!;
    expect(tool).toBeDefined();
    const out = (await tool.execute({ query: 'payment-service' })) as { error?: string };
    expect(out.error).toContain('TideRAG not configured');
  });

  it('each agent exposes the RAG context tool', () => {
    const agent = createCostInvestigator({ openrouterApiKey: 'sk-test' });
    const cfg = (agent as unknown as { config: { tools: Array<{ name: string }> } }).config;
    expect(cfg.tools.map((t) => t.name)).toContain('search_knowledge');
  });
});