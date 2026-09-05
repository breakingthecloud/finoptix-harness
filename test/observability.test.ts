import { describe, it, expect } from 'vitest';
import { createObservability } from '../src/observability.js';
import { createFinopsAnalyst } from '../src/agent.js';

describe('FinOptix Observability (Bloque 3)', () => {
  it('creates observability with plugin + snapshot storage', () => {
    const obs = createObservability({ agentName: 'test-agent' });
    expect(obs.plugin).toBeDefined();
    expect(obs.allSpans()).toEqual([]);
    expect(obs.stats().totalRated).toBe(0);
  });

  it('records rating and aggregates thumbs stats', async () => {
    const obs = createObservability({ agentName: 'test-agent' });
    await obs.rate('sess-1', 1, 'great', 'u1');
    await obs.rate('sess-2', -1, 'bad', 'u1');
    await obs.rate('sess-3', 1, undefined, 'u2');

    const rated = obs.ratedSpans();
    expect(rated.length).toBe(3);
    expect(rated.every((s) => s.rating !== undefined)).toBe(true);

    const stats = obs.stats();
    expect(stats.thumbsUp).toBe(2);
    expect(stats.thumbsDown).toBe(1);
    expect(stats.totalRated).toBe(3);
    expect(stats.thumbsDownRate).toBeCloseTo(1 / 3, 4);
  });

  it('attach() merges hooks without breaking existing config', () => {
    const obs = createObservability({ agentName: 'test-agent' });
    let called = false;
    const merged = obs.attach({
      router: {} as never,
      tools: [],
      systemPrompt: 'x',
      onComplete: () => {
        called = true;
      },
    });
    expect(merged.onComplete).toBeDefined();
    expect(merged.onFeedback).toBeDefined();
  });

  it('integrates with FinOps Analyst agent config', () => {
    const obs = createObservability({ agentName: 'test-agent' });
    const agent = createFinopsAnalyst({ openrouterApiKey: 'sk-test', obs });
    expect(agent).toBeDefined();
  });
});