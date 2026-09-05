import { describe, it, expect, vi } from 'vitest';
import { initSchema, validateApiKey, issueApiKey, sha256, getStats, writeRating, D1MemoryStorage, MEMORY_SCHEMA } from '../worker/db.js';
import { MIGRATION_SQL } from '@carloscortezcloud/qhaway';

// ─── mock D1 ─────────────────────────────────────────────────────────────

function mockD1() {
  const rows: Record<string, unknown[]> = {};
  const makeStmt = (sql: string) => {
    const stmt = {
      run: vi.fn(async () => ({ meta: {} })),
      all: vi.fn(async () => ({ results: rows['qhaway_spans'] ?? [] })),
      bind: vi.fn((...params: unknown[]) => {
        // bind() returns a chained statement whose run() does the insert
        const bound = {
          run: vi.fn(async () => {
            if (sql.includes('INTO qhaway_spans')) {
              const span = {
                id: params[0] as string,
                timestamp: params[1] as string,
                model: params[2] as string,
                provider: params[3] as string,
                latency_ms: params[4] as number,
                tokens_in: params[5] as number,
                tokens_out: params[6] as number,
                cost_usd: params[7] as number,
                user_id: params[8] as string | null,
                session_id: params[9] as string | null,
                agent_id: params[10] as string | null,
                tool_name: params[11] as string | null,
                success: params[12] as number,
                error: params[13] as string | null,
                rating: params[14] as number | null,
                metadata: params[15] as string | null,
              };
              rows['qhaway_spans'] = rows['qhaway_spans'] ?? [];
              (rows['qhaway_spans'] as unknown[]).push(span);
            }
            return { meta: {} };
          }),
          all: vi.fn(async () => ({ results: rows['qhaway_spans'] ?? [] })),
        };
        return bound;
      }),
    };
    return stmt;
  };
  const db = {
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    exec: vi.fn(async () => ({ success: true })),
    batch: vi.fn(async () => []),
  };
  return { db, rows };
}

describe('worker/db (Bloque 5 — D1 + KV free tier)', () => {
  it('initSchema splits MIGRATION_SQL into single statements', async () => {
    const { db } = mockD1();
    await initSchema(db as never);
    // each statement prepared individually (multi-statement exec avoided)
    const sqls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(sqls.length).toBeGreaterThanOrEqual(4);
    expect(sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS qhaway_spans'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE INDEX'))).toBe(true);
    // memory schema included
    expect(sqls.some((s) => s.includes('memory_entities'))).toBe(true);
    expect(sqls.some((s) => s.includes('memory_observations'))).toBe(true);
    // no ALTER (legacy, rating column exists)
    expect(sqls.some((s) => s.startsWith('ALTER'))).toBe(false);
  });

  it('MEMORY_SCHEMA defines entities + observations tables', () => {
    expect(MEMORY_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS memory_entities');
    expect(MEMORY_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS memory_observations');
    expect(MEMORY_SCHEMA).toContain('REFERENCES memory_entities');
  });

  it('D1MemoryStorage contract works with a simple mock', async () => {
    // minimal D1 mock: remembers inserts per table, returns for selects
    const store: Record<string, Record<string, string[]>> = {};
    const db = {
      prepare: vi.fn((sql: string) => {
        const isInsert = sql.includes('INSERT INTO memory_observations');
        const isEntityInsert = sql.includes('INSERT OR IGNORE INTO memory_entities');
        const isEntitySelect = sql.includes('SELECT entity_type FROM memory_entities');
        const isObsSelect = sql.includes('SELECT content FROM memory_observations');
        const isCount = sql.includes('SELECT (SELECT COUNT(*)');
        const bound = {
          run: vi.fn(async () => {
            if (isEntityInsert) { /* no-op */ }
            return { meta: { changes: 1 } };
          }),
          all: vi.fn(async () => {
            if (isEntitySelect) {
              const name = (bound as never as { params: unknown[] }).params?.[0] as string;
              return { results: store[name] ? [{ entity_type: 'project' }] : [] };
            }
            if (isObsSelect) {
              const name = (bound as never as { params: unknown[] }).params?.[0] as string;
              return { results: (store[name] ?? []).map((content) => ({ content })) };
            }
            if (isCount) return { results: [{ entities: 1, observations: 2 }] };
            return { results: [] };
          }),
          bind: vi.fn((...params: unknown[]) => {
            (bound as never as { params: unknown[] }).params = params;
const boundStmt = {
          run: vi.fn(async () => {
            if (isInsert) {
              const name = params[0] as string;
              store[name] = store[name] ?? [];
              store[name].push(params[1] as string);
            }
            return { meta: { changes: 1 } };
          }),
          all: vi.fn(async () => {
            if (isEntitySelect) {
              const name = params[0] as string;
              return { results: store[name] ? [{ entity_type: 'project' }] : [] };
            }
            if (isObsSelect) {
              const name = params[0] as string;
              return { results: (store[name] ?? []).map((content) => ({ content })) };
            }
            if (isCount) return { results: [{ entities: 1, observations: 2 }] };
            return { results: [] };
          }),
        };
        return boundStmt;
          }),
        };
        return bound;
      }),
      exec: vi.fn(async () => ({ success: true })),
      batch: vi.fn(async () => []),
    };

    const mem = new D1MemoryStorage(db as never);
    await mem.createEntity('payment-service', 'project');
    await mem.addObservations('payment-service', ['uses EC2', 'cost $512']);

    const node = await mem.openNode('payment-service');
    expect(node?.entity_type).toBe('project');
    expect(node?.observations).toContain('cost $512');

    const stats = await mem.stats();
    expect(stats).toEqual({ entities: 1, observations: 2 });
  });

  it('validateApiKey: dev key + KV hashed keys', async () => {
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    expect(await validateApiKey(kv as never, 'fp_dev_local')).toBe(true);
    expect(await validateApiKey(kv as never, 'fp_live_unknownaaaaa')).toBe(false); // not in KV
    expect(await validateApiKey(kv as never, 'invalid')).toBe(false);
  });

  it('issueApiKey stores hashed and returns fp_live_ prefixed', async () => {
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const key = await issueApiKey(kv as never, 'user-1');
    expect(key.startsWith('fp_live_')).toBe(true);
    expect(kv.put).toHaveBeenCalledWith(`key:${sha256(key)}`, expect.stringContaining('user-1'));
  });

  it('sha256 produces stable 8-hex hash', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
    expect(sha256('x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('writeRating + getStats round-trip', async () => {
    const { db } = mockD1();
    await writeRating(db as never, {
      id: 'f1', timestamp: new Date().toISOString(), model: '', provider: 'feedback',
      latency_ms: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0,
      session_id: 's1', user_id: 'u1', rating: 1, success: true,
    } as never);
    const stats = await getStats(db as never);
    expect(stats.span_count).toBe(1);
    expect(stats.rating_stats.thumbsUp).toBe(1);
  });
});