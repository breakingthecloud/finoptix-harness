# FinOptix Harness

**FinOptix = deployment del stack SSTTQ de Tinkuy Labs sobre los modelos FinOptix.**

No es un modelo. Es el **harness**: clasificador L1-L6 + routing (Styrr) + budget (Sayay) + tracing (Qhaway) + RAG (TideRAG) + agentes (Tinkuy), con `byaml-mcp` como tool layer AWS y `agent-config.yaml` como steering declarativo.

> Regla: **NADA se reimplementa del stack SSTTQ** (ya publicado en npm/PyPI). El único código de dominio nuevo = `src/classifier.ts` (complejidad FinOps L1-L6) y los agentes FinOps.

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

## Estado — Bloque 1 (Router Phase A) 🟡

- [x] `src/classifier.ts` — classifier FinOps L1-L6 (único código propio)
- [x] `src/steering.ts` — glue Classifier + Styrr + Sayay + Qhaway
- [x] `agent-config.yaml` — agent-config-spec v1
- [x] Tests classifier (`vitest`)
- [ ] Agents Tinkuy (analyst 1x) → Bloque 2
- [ ] Worker `agents.finoptix.dev/mcp` → Bloque 2

## CLI

```bash
# Clasificar una query (sin API key)
npm run classify -- "Audit my terraform" 'resource "aws_instance" "web" {}'

# Tests del classifier
npm test
```

## Roadmap del repo

```
Bloque 1 ◄── ESTAMOS AQUÍ — steering base (classifier + Styrr + Sayay + Qhaway)
Bloque 2     agent Tinkuy + MCP endpoint (agents.finoptix.dev/mcp)
Bloque 3     Qhaway feedback loop → retrain classifier
Bloque 4     multi-agente + TideRAG namespaces
Bloque 5     cloud platform (API keys, app.finoptix.dev)
```

Ver enfoque total: `cc-roadmap/finoptix-ai/sprint-finoptix-harness-ssttq.md`