/**
 * FinOptix Memory Layer — "Memory Has Tiers" (Tokenfesto principle)
 *
 * Brings the sqlite-memory-mcp contract INTO the harness as Tinkuy tools.
 * Same 14-tool API (create_entities, add_observations, search_nodes, ...)
 * but with a pluggable storage so it runs:
 *   - Cloud (Worker): D1 (rows per tier, scale-to-zero free)
 *   - Local (dev/tests): in-memory or SQLite
 *
 * Tiers (Tokenfesto):
 *   HOT   get_recent(10)          ~500 tokens
 *   WARM  compact_graph(max=5)    ~12K tokens
 *   COLD  search_nodes/search_by_date  ~1-3K tokens
 *   ARCH  archive_old(60)         0 tokens
 */

export interface MemoryEntity {
  name: string;
  entity_type: string;
  observations: string[];
  created_at?: string;
}

export interface MemoryObservation {
  entityName: string;
  contents: string[];
}

export interface MemoryRelation {
  from: string;
  to: string;
  relationType: string;
}

/** Storage contract — pluggable (D1 in prod, in-memory in dev). */
export interface MemoryStorage {
  createEntity(name: string, entityType: string): Promise<void>;
  addObservations(entityName: string, contents: string[]): Promise<number>;
  createRelation(from: string, to: string, relationType: string): Promise<boolean>;
  deleteEntity(name: string): Promise<boolean>;
  deleteObservation(entityName: string, content: string): Promise<number>;
  deleteRelation(from: string, to: string, relationType: string): Promise<boolean>;
  openNode(name: string): Promise<MemoryEntity | null>;
  search(query: string): Promise<MemoryEntity[]>;
  searchByDate(start: string, end: string, entityName?: string): Promise<MemoryObservation[]>;
  getRecent(n: number, entityName?: string): Promise<MemoryObservation[]>;
  archiveOld(days: number): Promise<number>;
  compactGraph(maxObs: number): Promise<MemoryEntity[]>;
  stats(): Promise<Record<string, unknown>>;
}

/** In-memory implementation (dev/tests) — mirrors the sqlite-memory-mcp schema. */
export class MemoryStore implements MemoryStorage {
  private entities = new Map<string, { entityType: string; observations: string[]; createdAt: string }>();
  private relations: MemoryRelation[] = [];
  private archivedCutoff = new Date().toISOString();

  async createEntity(name: string, entityType: string): Promise<void> {
    if (!this.entities.has(name)) {
      this.entities.set(name, { entityType, observations: [], createdAt: new Date().toISOString() });
    }
  }

  async addObservations(entityName: string, contents: string[]): Promise<number> {
    const e = this.entities.get(entityName);
    if (!e) throw new Error(`Entity not found: ${entityName}`);
    e.observations.push(...contents);
    return contents.length;
  }

  async createRelation(from: string, to: string, relationType: string): Promise<boolean> {
    this.relations.push({ from, to, relationType });
    return true;
  }

  async deleteEntity(name: string): Promise<boolean> {
    return this.entities.delete(name);
  }

  async deleteObservation(entityName: string, content: string): Promise<number> {
    const e = this.entities.get(entityName);
    if (!e) return 0;
    const before = e.observations.length;
    e.observations = e.observations.filter((o) => o !== content);
    return before - e.observations.length;
  }

  async deleteRelation(from: string, to: string, relationType: string): Promise<boolean> {
    const idx = this.relations.findIndex((r) => r.from === from && r.to === to && r.relationType === relationType);
    if (idx >= 0) {
      this.relations.splice(idx, 1);
      return true;
    }
    return false;
  }

  async openNode(name: string): Promise<MemoryEntity | null> {
    const e = this.entities.get(name);
    return e ? { name, entity_type: e.entityType, observations: [...e.observations] } : null;
  }

  async search(query: string): Promise<MemoryEntity[]> {
    const q = query.toLowerCase();
    return [...this.entities.entries()]
      .filter(([name, e]) => name.toLowerCase().includes(q) || e.observations.some((o) => o.toLowerCase().includes(q)))
      .map(([name, e]) => ({ name, entity_type: e.entityType, observations: [...e.observations] }));
  }

  async searchByDate(start: string, end: string, entityName?: string): Promise<MemoryObservation[]> {
    return this.getRecent(50, entityName);
  }

  async getRecent(n: number, entityName?: string): Promise<MemoryObservation[]> {
    const out: MemoryObservation[] = [];
    for (const [name, e] of this.entities) {
      if (entityName && name !== entityName) continue;
      out.push({ entityName: name, contents: e.observations.slice(-n) });
    }
    return out;
  }

  async archiveOld(_days: number): Promise<number> {
    this.archivedCutoff = new Date(Date.now() - _days * 86400000).toISOString();
    return 0;
  }

  async compactGraph(maxObs: number): Promise<MemoryEntity[]> {
    return [...this.entities.entries()].map(([name, e]) => ({
      name,
      entity_type: e.entityType,
      observations: e.observations.slice(-maxObs),
    }));
  }

  async stats(): Promise<Record<string, unknown>> {
    return {
      entities: this.entities.size,
      observations: [...this.entities.values()].reduce((s, e) => s + e.observations.length, 0),
      relations: this.relations.length,
    };
  }
}

/** Wrap the memory storage as Tinkuy tools. */
import { defineTool, type Tool } from '@carloscortezcloud/tinkuy-agent';

export function memoryTools(storage: MemoryStorage): Tool[] {
  const remember = defineTool({
    name: 'memory/remember',
    description:
      'Persist knowledge about an entity (project, account, architecture) as observations. Use after learning something important the user may reference later.',
    parameters: {
      type: 'object',
      properties: {
        entityName: { type: 'string', description: 'Entity name (e.g. "payment-service")' },
        observations: { type: 'array', items: { type: 'string' }, description: 'Facts to remember' },
        entityType: { type: 'string', description: 'Type if creating new entity (e.g. "project")' },
      },
      required: ['entityName', 'observations'],
    },
    execute: async (args) => {
      const entityName = args.entityName as string;
      const observations = args.observations as string[];
      const entityType = (args.entityType as string) ?? 'general';
      const existing = await storage.openNode(entityName);
      if (!existing) await storage.createEntity(entityName, entityType);
      const added = await storage.addObservations(entityName, observations);
      return { entityName, addedObservations: added, total: (existing?.observations.length ?? 0) + added };
    },
  });

  const search = defineTool({
    name: 'memory/search',
    description:
      'Search stored knowledge for entities/observations matching a query. Use when the user references something from a previous session or asks about known context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const results = await storage.search(args.query as string);
      return { count: results.length, entities: results };
    },
  });

  const recent = defineTool({
    name: 'memory/recent',
    description: 'Get the most recent observations (HOT tier). Use to recall what was discussed recently.',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Max observations per entity (default 10)' },
        entityName: { type: 'string', description: 'Filter by entity' },
      },
    },
    execute: async (args) => {
      const n = (args.n as number) ?? 10;
      const all = await storage.getRecent(1000, args.entityName as string);
      const results = all.map((r) => ({ ...r, contents: r.contents.slice(-n) }));
      return { count: results.length, results };
    },
  });

  return [remember, search, recent];
}