/**
 * FinOptix Worker persistence — FREE tier (no Durable Objects).
 *
 * - D1 (SQLite, free: 5M reads/100K writes/day/5GB) → Qhaway spans + feedback
 * - KV (free: 100K reads/1K writes/day/1GB) → API keys (fp_live_)
 *
 * We deliberately avoid Durable Objects: DO SQLite storage bills since Jan 2026
 * and duration (GB-s) can accumulate. D1 + KV are scale-to-zero and free.
 */

import { D1Storage, MIGRATION_SQL } from '@carloscortezcloud/qhaway';
import type { QhawaySpan } from '@carloscortezcloud/qhaway';
import { ratingStats } from '@carloscortezcloud/qhaway/cost';
import type { QhawayStorageLike } from '../src/observability.js';

export interface D1Database {
  prepare(sql: string): { bind(...p: unknown[]): { run(): Promise<unknown>; all<T = unknown>(): Promise<{ results: T[] }> } };
  exec(sql: string): Promise<{ success: boolean }>;
  batch(stmts: unknown[]): Promise<unknown[]>;
}

// ─── D1 schema (Qhaway spans table) ──────────────────────────────────────

/**
 * Runs the qhaway migration. D1 local (wrangler) does NOT support multi-
 * statement exec() — we split by ';' and run each via prepare().run().
 */
export async function initSchema(db: D1Database): Promise<void> {
  const statements = [...MIGRATION_SQL.split(';'), ...MEMORY_SCHEMA.split(';')]
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('ALTER')); // ALTER is legacy (rating column exists)

  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

export function makeSpanStorage(db: D1Database): QhawayStorageLike {
  // D1Storage from qhaway — writes spans + supports query for stats
  return new D1Storage(db as never);
}

export interface SpanStats {
  rating_stats: ReturnType<typeof ratingStats>;
  span_count: number;
  rated_span_count: number;
  recent: QhawaySpan[];
}

export async function getStats(db: D1Database): Promise<SpanStats> {
  const { results: all } = await db.prepare(
    'SELECT * FROM qhaway_spans ORDER BY timestamp DESC LIMIT 1000',
  ).all<QhawaySpan>();
  const spans = all as unknown as QhawaySpan[];
  return {
    rating_stats: ratingStats(spans),
    span_count: spans.length,
    rated_span_count: spans.filter((s) => s.rating !== undefined).length,
    recent: spans.slice(0, 20),
  };
}

export async function writeRating(db: D1Database, span: QhawaySpan): Promise<void> {
  await db.prepare(
    `INSERT INTO qhaway_spans (id, timestamp, model, provider, latency_ms, tokens_in, tokens_out,
      cost_usd, user_id, session_id, agent_id, tool_name, success, error, rating, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    span.id, span.timestamp, span.model, span.provider, span.latency_ms,
    span.tokens_in, span.tokens_out, span.cost_usd,
    span.user_id ?? null, span.session_id ?? null,
    span.agent_id ?? null, span.tool_name ?? null,
    span.success ? 1 : 0, span.error ?? null,
    span.rating ?? null,
    span.metadata ? JSON.stringify(span.metadata) : null,
  ).run();
}

// ─── KV API keys ─────────────────────────────────────────────────────────

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const DEV_KEY = 'fp_dev_local';

/** validate a key: dev key OR KV lookup (hashed fp_live_...) */
export async function validateApiKey(kv: KVNamespace, key: string | null): Promise<boolean> {
  if (!key) return false;
  if (key === DEV_KEY) return true;
  if (!key.startsWith('fp_live_')) return false;
  const entry = await kv.get(`key:${sha256(key)}`);
  return entry !== null;
}

export async function issueApiKey(kv: KVNamespace, userId: string): Promise<string> {
  const key = `fp_live_${cryptoRandom()}`;
  await kv.put(`key:${sha256(key)}`, JSON.stringify({ user_id: userId, created_at: new Date().toISOString() }));
  return key;
}

// ─── D1 memory storage (sqlite-memory-mcp contract, cloud tier) ──────────

import type { MemoryStorage as FinoptixMemoryStorage, MemoryEntity } from '../src/memory.js';

/**
 * D1-backed memory following the sqlite-memory-mcp contract.
 * Tables: memory_entities, memory_observations (Tiered: HOT via recent, COLD via search).
 */
export class D1MemoryStorage implements FinoptixMemoryStorage {
  constructor(private db: D1Database) {}

  async createEntity(name: string, entityType: string): Promise<void> {
    await this.db.prepare(
      'INSERT OR IGNORE INTO memory_entities (name, entity_type) VALUES (?, ?)',
    ).bind(name, entityType).run();
  }

  async addObservations(entityName: string, contents: string[]): Promise<number> {
    for (const c of contents) {
      await this.db.prepare(
        'INSERT INTO memory_observations (entity_name, content) VALUES (?, ?)',
      ).bind(entityName, c).run();
    }
    return contents.length;
  }

  async createRelation(_from: string, _to: string, _relationType: string): Promise<boolean> {
    return false; // relations not stored in D1 yet (schema has no relations table)
  }

  async deleteEntity(name: string): Promise<boolean> {
    const r = await this.db.prepare('DELETE FROM memory_entities WHERE name = ?').bind(name).run() as { meta?: { changes?: number } };
    return (r.meta?.changes ?? 0) > 0;
  }

  async deleteObservation(entityName: string, content: string): Promise<number> {
    const r = await this.db.prepare('DELETE FROM memory_observations WHERE entity_name = ? AND content = ?').bind(entityName, content).run() as { meta?: { changes?: number } };
    return r.meta?.changes ?? 0;
  }

  async deleteRelation(): Promise<boolean> {
    return false;
  }

  async openNode(name: string): Promise<MemoryEntity | null> {
    const { results: obs } = await this.db.prepare(
      'SELECT content FROM memory_observations WHERE entity_name = ? ORDER BY created_at DESC',
    ).bind(name).all<{ content: string }>();
    const { results: meta } = await this.db.prepare(
      'SELECT entity_type FROM memory_entities WHERE name = ?',
    ).bind(name).all<{ entity_type: string }>();
    if (meta.length === 0) return null;
    return { name, entity_type: meta[0].entity_type, observations: obs.map((o) => o.content) };
  }

  async search(query: string): Promise<MemoryEntity[]> {
    const q = `%${query}%`;
    const { results } = await this.db.prepare(
      `SELECT DISTINCT e.name, e.entity_type
       FROM memory_entities e
       LEFT JOIN memory_observations o ON o.entity_name = e.name
       WHERE e.name LIKE ? OR o.content LIKE ?
       LIMIT 20`,
    ).bind(q, q).all<{ name: string; entity_type: string }>();
    const out: MemoryEntity[] = [];
    for (const r of results) {
      const node = await this.openNode(r.name);
      if (node) out.push(node);
    }
    return out;
  }

  async searchByDate(_start: string, _end: string, entityName?: string): Promise<{ entityName: string; contents: string[] }[]> {
    const { results } = await this.db.prepare(
      'SELECT entity_name, content FROM memory_observations WHERE (? IS NULL OR entity_name = ?) ORDER BY created_at DESC LIMIT 100',
    ).bind(entityName ?? null, entityName ?? null).all<{ entity_name: string; content: string }>();
    const map = new Map<string, string[]>();
    for (const r of results) {
      if (!map.has(r.entity_name)) map.set(r.entity_name, []);
      map.get(r.entity_name)!.push(r.content);
    }
    return [...map.entries()].map(([entityName, contents]) => ({ entityName, contents }));
  }

  async getRecent(n: number, entityName?: string): Promise<{ entityName: string; contents: string[] }[]> {
    const { results } = await this.db.prepare(
      'SELECT entity_name, content FROM memory_observations WHERE (? IS NULL OR entity_name = ?) ORDER BY created_at DESC LIMIT ?',
    ).bind(entityName ?? null, entityName ?? null, n * 20).all<{ entity_name: string; content: string }>();
    const map = new Map<string, string[]>();
    for (const r of results) {
      if (!map.has(r.entity_name)) map.set(r.entity_name, []);
      map.get(r.entity_name)!.push(r.content);
    }
    return [...map.entries()].map(([entityName, contents]) => ({ entityName, contents }));
  }

  async archiveOld(_days: number): Promise<number> {
    return 0; // retention cleanup scheduled separately
  }

  async compactGraph(maxObs: number): Promise<MemoryEntity[]> {
    const { results } = await this.db.prepare(
      'SELECT entity_name, content FROM memory_observations ORDER BY created_at DESC LIMIT ?',
    ).bind(maxObs * 50).all<{ entity_name: string; content: string }>();
    const map = new Map<string, string[]>();
    for (const r of results) {
      if (!map.has(r.entity_name)) map.set(r.entity_name, []);
      if (map.get(r.entity_name)!.length < maxObs) map.get(r.entity_name)!.push(r.content);
    }
    return [...map.entries()].map(([name, observations]) => ({ name, entity_type: 'general', observations }));
  }

  async stats(): Promise<Record<string, unknown>> {
    const { results } = await this.db.prepare(
      'SELECT (SELECT COUNT(*) FROM memory_entities) AS entities, (SELECT COUNT(*) FROM memory_observations) AS observations',
    ).all<{ entities: number; observations: number }>();
    return results[0] ?? { entities: 0, observations: 0 };
  }
}

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entities (
  name TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL REFERENCES memory_entities(name) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_obs_entity ON memory_observations(entity_name);
CREATE INDEX IF NOT EXISTS idx_mem_obs_created ON memory_observations(created_at DESC);
`;

// ─── helpers ─────────────────────────────────────────────────────────────

export function sha256(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function cryptoRandom(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}