import { describe, it, expect } from 'vitest';
import { MemoryStore, memoryTools } from '../src/memory.js';

describe('FinOptix Memory Layer (sqlite-memory-mcp contract)', () => {
  it('creates entities and adds observations', async () => {
    const m = new MemoryStore();
    await m.createEntity('payment-service', 'project');
    await m.addObservations('payment-service', ['uses 14 EC2 instances', 'monthly cost $512']);
    const node = await m.openNode('payment-service');
    expect(node?.entity_type).toBe('project');
    expect(node?.observations).toHaveLength(2);
  });

  it('addObservations throws on unknown entity', async () => {
    const m = new MemoryStore();
    await expect(m.addObservations('ghost', ['x'])).rejects.toThrow('Entity not found');
  });

  it('search finds by entity name and observation content', async () => {
    const m = new MemoryStore();
    await m.createEntity('payment-service', 'project');
    await m.addObservations('payment-service', ['uses 14 EC2 instances']);
    await m.createEntity('data-lake', 'project');
    await m.addObservations('data-lake', ['glue jobs']);

    const byName = await m.search('payment');
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('payment-service');

    const byContent = await m.search('glue');
    expect(byContent).toHaveLength(1);
    expect(byContent[0].name).toBe('data-lake');
  });

  it('memory/recent tool slices to N observations', async () => {
    const store = new MemoryStore();
    await store.createEntity('svc', 'project');
    await store.addObservations('svc', ['obs1', 'obs2', 'obs3']);
    const [, , recent] = memoryTools(store);
    const res = (await recent.execute({ n: 2, entityName: 'svc' })) as { results: Array<{ contents: string[] }> };
    expect(res.results[0].contents).toEqual(['obs2', 'obs3']); // last N (HOT tier)
  });

  it('compactGraph limits observations per entity', async () => {
    const m = new MemoryStore();
    await m.createEntity('svc', 'project');
    await m.addObservations('svc', ['a', 'b', 'c', 'd', 'e']);
    const compact = await m.compactGraph(2);
    expect(compact[0].observations).toEqual(['d', 'e']);
  });

  it('stats reports counts', async () => {
    const m = new MemoryStore();
    await m.createEntity('a', 'project');
    await m.addObservations('a', ['x', 'y']);
    const s = await m.stats();
    expect(s.entities).toBe(1);
    expect(s.observations).toBe(2);
  });

  it('memoryTools returns 3 Tinkuy tools (remember/search/recent)', () => {
    const tools = memoryTools(new MemoryStore());
    expect(tools.map((t) => t.name)).toEqual(['memory/remember', 'memory/search', 'memory/recent']);
  });

  it('memory/remember tool creates + observes, then memory/search finds it', async () => {
    const store = new MemoryStore();
    const [remember, search] = memoryTools(store);
    await remember.execute({ entityName: 'prod-account', entityType: 'account', observations: ['spends $845/mo on compute'] });
    const res = (await search.execute({ query: 'compute' })) as { entities: unknown[] };
    expect(res.entities).toHaveLength(1);
  });
});