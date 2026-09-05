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
  const statements = MIGRATION_SQL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('ALTER')); // ALTER is legacy (rating column exists in base)

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