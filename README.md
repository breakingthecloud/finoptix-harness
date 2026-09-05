# FinOptix Harness

**FinOptix = deployment del stack SSTTQ de Tinkuy Labs sobre los modelos FinOptix.**

No es un modelo. Es el **harness**: clasificador L1-L6 + routing (Styrr) + budget (Sayay) + tracing (Qhaway) + RAG (TideRAG) + agentes (Tinkuy), con `byaml-mcp` como tool layer AWS y `agent-config.yaml` como steering declarativo.

> Regla: **NADA se reimplementa del stack SSTTQ** (ya publicado en npm/PyPI). El único código de dominio nuevo = `src/classifier.ts` (complejidad FinOps L1-L6) y los agentes FinOps.

## Live

- **Gateway:** https://agents.finoptix.dev (MCP SSE + REST)
- **Health:** https://agents.finoptix.dev/health
- **Docs:** `docs/` (HARNESS.md, MCP.md)
- **Ejemplos:** `examples/` (mcp-client.mjs, rest-client.mjs, finoptix.skill.md)

## Docs & Examples

| Path | Contenido |
|---|---|
| `docs/HARNESS.md` | Arquitectura del harness (fuente para ai.finoptix.dev/harness) |
| `docs/MCP.md` | Cómo conectar el harness a tu IDE (Kiro/VS Code/Claude Code) |
| `guides/TESTING.md` | Guía de testing (unit → classify → MCP → agente → IDE) |
| `guides/SELF-HOSTED.md` | **Deploy tu propio harness** (D1 + KV + secret → tu Cloudflare, single-tenant) |
| `examples/mcp-client.mjs` | Cliente MCP sin SDK (initialize + tools/list + classify) |
| `examples/rest-client.mjs` | Cliente REST (`/v1/finops/analyze`) |
| `examples/finoptix.skill.md` | Skill reutilizable para agentes |

## Repos referenciados (no copiados)

| Repo/paquete | Rol |
|---|---|
| `@carloscortezcloud/tinkuy-agent` 0.8.0 | Framework de agentes |
| `@carloscortezcloud/styrr-llm` 0.6.0 | Router de modelos + fallback chain |
| `@carloscortezcloud/sayay-guard` 0.3.0 | Budget/tier guard |
| `@carloscortezcloud/qhaway` 0.12.3 | Observabilidad/tracing |
| `@carloscortezcloud/tiderag` 0.1.0 | RAG (contexto) |
| `byaml-mcp` (PyPI) | MCP tools AWS FinOps (9+) |
| `tinkuylabs/` | Base: `finops-agent` demo |
| HF `ccortezb/FinOptix-14B` | Modelo base (provider en Styrr) |
| `finoptix-landing` | ai.finoptix.dev (LIVE) |

## Estado — Bloques

- [x] `src/classifier.ts` — classifier FinOps L1-L6 (único código propio)
- [x] `src/steering.ts` — glue Classifier + Styrr + Sayay + Qhaway
- [x] `src/agent.ts` — FinOps Analyst (Tinkuy) + tools (cost_summary, blast_radius, remediation)
- [x] `worker/index.ts` — Agent Gateway MCP SSE (`agents.finoptix.dev/mcp`) + REST `/v1/finops/analyze`
- [x] `src/observability.ts` — Qhaway tracing + feedback loop (Bloque 3)
- [x] `/v1/finops/feedback` + `/v1/finops/stats` (ratings → adaptive-classifier)
- [x] `src/agents.ts` — multi-agente (Bloque 4): Arch Auditor + Cost Investigator + TideRAG `search_knowledge`
- [x] Worker expone 4 tools MCP: `finops/analyze`, `finops/classify`, `architect/audit`, `investigate/cost`
- [x] **Bloque 5 (storage free)**: D1 (spans Qhaway + feedback) + KV (API keys) — SIN Durable Objects
- [x] `worker/db.ts` — persistencia D1 + KV (free tier), migración, stats, API keys issue/revoke
- [x] `agent-config.yaml` — agent-config-spec v1
- [x] Tests (30) + typecheck ✅

## Storage: FREE tier (sin Durable Objects)

| Almacenamiento | Free plan (diario) | Uso | Por qué no DO |
|---|---|---|---|
| **D1** (SQLite) | 5M rows read, 100K rows write, 5GB | Qhaway spans + feedback (`/v1/finops/stats`) | Scale-to-zero, gratis |
| **KV** | 100K reads, 1K writes, 1GB | API keys (`fp_live_`) issue/revoke | Pocas writes, gratis |
| ~~Durable Objects~~ | — | ~~session state~~ | **EVITAR**: DO SQLite se factura desde Ene 2026 + duración GB-s |

Endpoints: `POST /v1/keys` (issue), `POST /v1/keys/revoke`, `POST /v1/finops/feedback` (→ D1), `GET /v1/finops/stats` (← D1).
- [ ] **Pendiente:** storage durable de spans (D1/KV/DO) para stats entre requests — hoy stateless (cada request = instancia nueva)
- [ ] **Pendiente:** deploy real a agents.finoptix.dev (secret OPENROUTER_API_KEY + KV API keys)

## CLI

```bash
# Clasificar una query (sin API key)
npm run classify -- "Audit my terraform" 'resource "aws_instance" "web" {}'

# Tests
npm test

# Worker local (MCP SSE)
npm run dev:worker
# → curl -X POST "http://localhost:8787/messages?key=fp_dev_local" \
#     -H 'content-type: application/json' \
#     -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"finops/classify","arguments":{"prompt":"Compare costs"}},"id":1}'
```

## API del gateway

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | status + tools count |
| `/sse` | GET | MCP SSE transport (spec: evento `endpoint`) |
| `/messages` | POST | JSON-RPC MCP (`initialize`, `tools/list`, `tools/call`) |
| `/v1/finops/analyze` | POST | REST directo (agente completo) |
| `/v1/finops/feedback` | POST | rating 👍/👎 → span Qhaway |
| `/v1/finops/stats` | GET | ratingStats (alimenta adaptive-classifier) |

## MCP tools (tools/list)

| Tool | Agent | Uso |
|---|---|---|
| `finops/analyze` | FinOps Analyst | Costos, savings, análisis general |
| `finops/classify` | — | Complejidad L1-L6 (sin LLM) |
| `architect/audit` | Architecture Auditor | Governance, compliance, Well-Architected |
| `investigate/cost` | Cost Investigator | Root cause de spikes/anomalías |

Auth: header `X-FinOptix-Key` o `?key=`. Dev: `fp_dev_local`.

## Roadmap del repo

```
Bloque 1 ◄── ESTAMOS AQUÍ — steering base (classifier + Styrr + Sayay + Qhaway)
Bloque 2     agent Tinkuy + MCP endpoint (agents.finoptix.dev/mcp)
Bloque 3     Qhaway feedback loop → retrain classifier
Bloque 4     multi-agente + TideRAG namespaces
Bloque 5     cloud platform (API keys, app.finoptix.dev)
```

Ver enfoque total: `cc-roadmap/finoptix-ai/sprint-finoptix-harness-ssttq.md`