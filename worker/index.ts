/**
 * FinOptix Agent Gateway — agents.finoptix.dev/mcp
 *
 * Cloudflare Worker: MCP over SSE (Hono + streamSSE), JSON-RPC manual
 * (replica del patrón remo-mcp-remote). Expone los tools del agente
 * FinOps Analyst (Tinkuy) + routing L1-L6 + auth Bearer.
 *
 * Endpoints:
 *   GET  /health               → status
 *   GET  /sse                  → MCP SSE transport (stream + endpoint event)
 *   POST /messages             → JSON-RPC (initialize, tools/list, tools/call)
 *   POST /v1/finops/analyze    → REST directo (para testing)
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createFinopsAnalyst, classify } from '../src/agent.js';
import { createArchAuditor, createCostInvestigator } from '../src/agents.js';
import { modelForLevel } from '../src/classifier.js';
import { createObservability } from '../src/observability.js';
import {
  initSchema,
  makeSpanStorage,
  getStats,
  writeRating,
  validateApiKey,
  issueApiKey,
  sha256,
  type D1Database,
  type KVNamespace,
} from './db.js';

type Env = {
  OPENROUTER_API_KEY: string;
  DB: D1Database;
  API_KEYS: KVNamespace;
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Env }>();

// NOTE: observability is created lazily per-request (QhawayTinkuyPlugin calls
// crypto.randomUUID() in its constructor — not allowed in CF global scope).
// Spans persist to D1 (free tier) — NOT Durable Objects.
function makeObs(db: D1Database) {
  return createObservability({
    agentName: 'finoptix-gateway',
    backend: makeSpanStorage(db),
  });
}

function makeAgent(kind: 'analyst' | 'auditor' | 'investigator', apiKey: string, db: D1Database) {
  const common = { openrouterApiKey: apiKey, obs: makeObs(db) };
  switch (kind) {
    case 'auditor':
      return createArchAuditor(common);
    case 'investigator':
      return createCostInvestigator(common);
    default:
      return createFinopsAnalyst(common);
  }
}

const TOOLS = [
  {
    name: 'finops/analyze',
    description:
      'Run the FinOps Analyst agent on a prompt. Returns analysis text + metadata (complexity L1-L6, model used). The agent uses cost_summary, blast_radius, remediation_plan tools internally.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'FinOps question or task' },
        context: { type: 'string', description: 'Optional context (terraform, cost JSON, BYaML)' },
        mode: { type: 'string', enum: ['terraform', 'cost', 'byaml', 'qa', 'report', 'general'], default: 'general' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'finops/classify',
    description: 'Classify a FinOps prompt into complexity L1-L6 and return the recommended model. No LLM call.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        context: { type: 'string' },
        mode: { type: 'string', enum: ['terraform', 'cost', 'byaml', 'qa', 'report', 'general'] },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'architect/audit',
    description:
      'Run the Architecture Auditor agent: audits infrastructure (terraform, BYaML) for governance, compliance, and Well-Architected best practices. Reports findings by severity with fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Architecture to audit or question' },
        context: { type: 'string', description: 'Terraform / BYaML content' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'investigate/cost',
    description:
      'Run the Cost Investigator agent: finds root causes of cost spikes/anomalies, correlates with architecture, recommends remediation with USD impact.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Anomaly to investigate' },
        context: { type: 'string', description: 'Cost JSON or context' },
      },
      required: ['prompt'],
    },
  },
];

function authError(): Response {
  return new Response(
    JSON.stringify({
      error: 'API key required',
      message: 'Set X-FinOptix-Key header or append ?key= to the URL.',
      setup: {
        step_1: 'Get an API key at app.finoptix.dev (soon) or use dev key fp_dev_local',
        step_2: 'Add to your MCP config:',
        example: {
          url: 'https://agents.finoptix.dev/sse',
          header: 'X-FinOptix-Key: fp_live_xxx',
        },
      },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

// KV-backed validation (free tier). Dev key fp_dev_local for local testing.
async function validateKey(kv: KVNamespace, key: string | null): Promise<boolean> {
  return validateApiKey(kv, key);
}

function getKey(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): string | null {
  return c.req.header('X-FinOptix-Key') || c.req.query('key') || null;
}

// ─── Health ──────────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  try {
    await initSchema(c.env.DB); // idempotent
    const stats = await getStats(c.env.DB);
    return c.json({
      service: 'finoptix-agent-gateway',
      version: '0.2.0',
      tools: TOOLS.length,
      storage: 'd1',
      span_count: stats.span_count,
      status: 'ok',
    });
  } catch (err) {
    return c.json({ service: 'finoptix-agent-gateway', status: 'degraded', error: String(err) }, 500);
  }
});

// ─── MCP SSE transport ───────────────────────────────────────────────────

app.get('/sse', async (c) => {
  const key = getKey(c);
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();

  return streamSSE(c, async (stream) => {
    // Spec: first event tells the client where to POST
    stream.writeSSE({ event: 'endpoint', data: `/messages?key=${encodeURIComponent(key!)}` });

    // keepalive every 30s (CF kills idle streams)
    const ping = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: new Date().toISOString() });
    }, 30000);

    // block until connection aborted
    await new Promise((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(ping);
        resolve(null);
      });
    });
  });
});

// ─── JSON-RPC ────────────────────────────────────────────────────────────

app.post('/messages', async (c) => {
  const key = getKey(c);
  if (!(await validateKey(c.env.API_KEYS, key))) return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing/invalid API key' }, id: null });

  const body = await c.req.json<{ method: string; params?: any; id?: any }>();
  const { method, params, id } = body;
  const apiKey = c.env.OPENROUTER_API_KEY;

  try {
    let result: unknown;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'finoptix-agent-gateway', version: '0.1.0' },
        };
        break;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params ?? {};

        // map MCP tool name → agent kind
        const agentMap: Record<string, 'analyst' | 'auditor' | 'investigator'> = {
          'finops/analyze': 'analyst',
          'architect/audit': 'auditor',
          'investigate/cost': 'investigator',
        };

        if (agentMap[name]) {
          const agent = makeAgent(agentMap[name], apiKey, c.env.DB);
          const fullPrompt = args.context ? `${args.context}\n\n${args.prompt}` : args.prompt;
          const out = await agent.run(fullPrompt);
          result = {
            content: [{ type: 'text', text: out.text }],
            metadata: {
              complexity: classify({ prompt: args.prompt, context: args.context ?? '', mode: args.mode }).level,
              agent: agentMap[name],
              model_used: out.modelsUsed.join(', '),
              iterations: out.iterations,
              tools_used: out.toolsUsed,
              latency_ms: out.totalLatencyMs,
            },
          };
        } else if (name === 'finops/classify') {
          const cls = classify({ prompt: args.prompt, context: args.context ?? '', mode: args.mode });
          result = {
            content: [{ type: 'text', text: JSON.stringify({ level: cls.level, signals: cls.signals, model: modelForLevel(cls.level, args.mode) }, null, 2) }],
          };
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }
        break;
      }

      case 'notifications/initialized':
      case 'ping':
        result = {};
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }
    return c.json({ jsonrpc: '2.0', result, id: id ?? null });
  } catch (err) {
    return c.json({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: id ?? null }, 500);
  }
});

// ─── REST direct (testing) ───────────────────────────────────────────────

app.post('/v1/finops/analyze', async (c) => {
  const key = getKey(c) || c.req.header('authorization')?.replace('Bearer ', '') || null;
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();

  const { prompt, context, mode } = await c.req.json<{ prompt: string; context?: string; mode?: string }>();
  const agent = createFinopsAnalyst({ openrouterApiKey: c.env.OPENROUTER_API_KEY, obs: makeObs(c.env.DB) });
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
  const out = await agent.run(fullPrompt);
  const cls = classify({ prompt, context: context ?? '', mode: mode as never });
  return c.json({
    analysis: out.text,
    metadata: {
      complexity: cls.level,
      model_used: out.modelsUsed,
      tools_used: out.toolsUsed,
      iterations: out.iterations,
      latency_ms: out.totalLatencyMs,
    },
  });
});

// ─── Feedback loop (Bloque 3) — persist to D1 ───────────────────────────

app.post('/v1/finops/feedback', async (c) => {
  const key = getKey(c) || c.req.header('authorization')?.replace('Bearer ', '') || null;
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();

  const { session_id, rating, message, user_id } = await c.req.json<{
    session_id: string;
    rating: 1 | -1 | 0;
    message?: string;
    user_id?: string;
  }>();
  if (!session_id || ![1, -1, 0].includes(rating)) {
    return c.json({ error: 'session_id (string) and rating (1|-1|0) required' }, 400);
  }
  await writeRating(c.env.DB, {
    id: `feedback-${session_id}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    model: '',
    provider: 'feedback',
    latency_ms: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    session_id,
    agent_id: 'finoptix-gateway',
    user_id,
    rating,
    success: true,
    metadata: { message },
  });
  return c.json({ ok: true, session_id, rating });
});

// ─── Stats (feeds adaptive-classifier R1/R2) — read from D1 ─────────────

app.get('/v1/finops/stats', async (c) => {
  const key = getKey(c);
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();
  const stats = await getStats(c.env.DB);
  return c.json(stats);
});

// ─── API keys (KV, free tier) ───────────────────────────────────────────

// Dev-only helper — in prod, gated by admin auth + tier. Issue an API key.
app.post('/v1/keys', async (c) => {
  const key = getKey(c) || c.req.header('authorization')?.replace('Bearer ', '') || null;
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();
  const { user_id } = await c.req.json<{ user_id: string }>();
  if (!user_id) return c.json({ error: 'user_id required' }, 400);
  const issued = await issueApiKey(c.env.API_KEYS, user_id);
  return c.json({ ok: true, api_key: issued, hint: 'store once — shown only here' });
});

// Revoke an API key.
app.post('/v1/keys/revoke', async (c) => {
  const key = getKey(c) || c.req.header('authorization')?.replace('Bearer ', '') || null;
  if (!(await validateKey(c.env.API_KEYS, key))) return authError();
  const { api_key } = await c.req.json<{ api_key: string }>();
  if (!api_key?.startsWith('fp_live_')) return c.json({ error: 'invalid api_key' }, 400);
  await c.env.API_KEYS.delete(`key:${sha256(api_key)}`);
  return c.json({ ok: true, revoked: api_key.slice(0, 12) + '…' });
});

export default app;