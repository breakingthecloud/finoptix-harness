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
import { modelForLevel } from '../src/classifier.js';
import { createObservability } from '../src/observability.js';

const app = new Hono<{ Bindings: { OPENROUTER_API_KEY: string } }>();

// NOTE: observability is created lazily per-request (QhawayTinkuyPlugin calls
// crypto.randomUUID() in its constructor — not allowed in CF global scope).
// In prod, use a Durable Object to keep per-session state.
function makeObs() {
  return createObservability({ agentName: 'finoptix-gateway' });
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

function validateKey(key: string | null): boolean {
  // Phase A: dev key. Phase B: KV lookup (fp_{env}_{hash})
  return key === 'fp_dev_local' || (key ?? '').startsWith('fp_live_');
}

// ─── Health ──────────────────────────────────────────────────────────────

app.get('/health', (c) =>
  c.json({ service: 'finoptix-agent-gateway', version: '0.1.0', tools: TOOLS.length, status: 'ok' }),
);

// ─── MCP SSE transport ───────────────────────────────────────────────────

app.get('/sse', (c) => {
  const key = c.req.header('X-FinOptix-Key') || c.req.query('key');
  if (!validateKey(key)) return authError();

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
  const key = c.req.header('X-FinOptix-Key') || c.req.query('key');
  if (!validateKey(key)) return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing/invalid API key' }, id: null });

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
        if (name === 'finops/analyze') {
          const agent = createFinopsAnalyst({ openrouterApiKey: apiKey, obs: makeObs() });
          const fullPrompt = args.context ? `${args.context}\n\n${args.prompt}` : args.prompt;
          const out = await agent.run(fullPrompt);
          result = {
            content: [{ type: 'text', text: out.text }],
            metadata: {
              complexity: classify({ prompt: args.prompt, context: args.context ?? '', mode: args.mode }).level,
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
  const key = c.req.header('X-FinOptix-Key') || c.req.header('authorization')?.replace('Bearer ', '');
  if (!validateKey(key)) return authError();

  const { prompt, context, mode } = await c.req.json<{ prompt: string; context?: string; mode?: string }>();
  const agent = createFinopsAnalyst({ openrouterApiKey: c.env.OPENROUTER_API_KEY, obs: makeObs() });
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

// ─── Feedback loop (Bloque 3) ───────────────────────────────────────────

app.post('/v1/finops/feedback', async (c) => {
  const key = c.req.header('X-FinOptix-Key') || c.req.header('authorization')?.replace('Bearer ', '');
  if (!validateKey(key)) return authError();

  const { session_id, rating, message, user_id } = await c.req.json<{
    session_id: string;
    rating: 1 | -1 | 0;
    message?: string;
    user_id?: string;
  }>();
  if (!session_id || ![1, -1, 0].includes(rating)) {
    return c.json({ error: 'session_id (string) and rating (1|-1|0) required' }, 400);
  }
  await makeObs().rate(session_id, rating, message, user_id);
  return c.json({ ok: true, session_id, rating });
});

// ─── Stats (feeds adaptive-classifier R1/R2) ────────────────────────────

app.get('/v1/finops/stats', (c) => {
  const key = c.req.header('X-FinOptix-Key') || c.req.query('key');
  if (!validateKey(key)) return authError();
  const obs = makeObs();
  return c.json({
    rating_stats: obs.stats(),
    span_count: obs.allSpans().length,
    rated_span_count: obs.ratedSpans().length,
  });
});

export default app;