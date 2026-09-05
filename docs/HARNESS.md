# FinOptix Harness — The FinOps AI Layer

> **FinOptix is not a model. It's a harness** — an orchestration layer that combines skills + MCP tools + steering/routing + agents + model family into one deployable FinOps AI product.

This is the source of truth for the FinOptix harness section on [ai.finoptix.dev](https://ai.finoptix.dev).

---

## What is it

| Layer | Component | Role |
|-------|-----------|------|
| **Agents** | Tinkuy (`@carloscortezcloud/tinkuy-agent`) | 4 FinOps agents: Analyst, Architecture Auditor, Cost Investigator, Orchestrator |
| **Routing** | Styrr (`styrr-llm`) + FinOps Classifier | Picks the optimal model per request (complexity L1-L6) with fallback chain |
| **Budget** | Sayay (`sayay-guard`) | allow/warn/degrade/block per tier + credit system |
| **Observability** | Qhaway (`qhaway`) | Every decision traced (model, latency, tokens, cost) + feedback loop |
| **Context** | TideRAG (`tiderag`) | Knowledge base of architectures/docs (namespace-scoped) |
| **Memory** | Memory Layer (`memory/*` tools) | sqlite-memory-mcp contract, tiered (HOT/WARM/COLD/ARCH) |
| **Tools** | byaml-mcp | 9+ real AWS FinOps tools (cost, idle, tags, architecture) |
| **Steering config** | agent-config-spec | Declarative `agent-config.yaml` (routing, budget, guardrails, tracing) |

## Architecture (deployed)

```
User (Kiro/VS Code/Web)
   │  MCP over SSE  /  REST
   ▼
agents.finoptix.dev  ── Cloudflare Worker (Hono)
   │  auth: fp_live_ API key (KV)
   ├── classify() ──→ L1-L6 complexity (domain classifier, <5ms)
   ├── sayay.check() → budget gate (allow/warn/degrade/block)
   ├── styrr.call()  → model + fallback chain (OpenRouter)
   │     └── provider registry: logical family → servable model
   └── qhaway spans → D1 (free tier, scale-to-zero)
        └── feedback loop → adaptive classifier retrain
```

## The FinOps Classifier (L1-L6)

The **only domain-specific code** in the harness. Routes by complexity:

| Level | Example | Model |
|-------|---------|-------|
| L1 Trivial | "What is RI?" | finemma-4b |
| L2 Simple | "Check tags on this resource" | finoptix-7b |
| L3 Medium | "Audit this terraform" | finoptix-14b |
| L4 Complex | "Full architecture review" | finoptix-32b |
| L5 Enterprise | "Compare 5 accounts + migration" | finomotrix-49b |
| L6 Hybrid | L5 with budget constraints (any tier) | chained inference |

## Memory (Memory Has Tiers)

The harness embeds the [sqlite-memory-mcp](https://github.com/breakingthecloud/sqlite-memory-mcp) contract (same 14-tool API, same schema) as **native agent tools** — so the agent can *remember*, *search*, and *recall* knowledge across sessions, live with the harness.

| Tier | Tool | Cost | Use |
|------|------|------|-----|
| 🔴 HOT | `memory/recent` | ~500 tok | "What did we discuss?" |
| 🟡 WARM | `compact_graph` | ~12K tok | General context |
| 🔵 COLD | `memory/search` | ~1-3K tok | "What about payment-service?" |
| ⚪ ARCH | `archive_old` | 0 tok | Retention, still searchable |

- **Tool API:** `memory/remember`, `memory/search`, `memory/recent` (same contract as the MCP server)
- **Storage pluggable:** D1 in the cloud Worker (persistent, free tier) / in-memory locally (tests/dev)
- **Principle (Tokenfesto):** never bulk-load everything — tier it like S3 storage classes
- Same contract as your local `sqlite-memory-mcp` MCP server → the harness cloud memory and your IDE memory share the same mental model

### How the local MCP server connects

Your IDE (opencode/Kiro) runs `sqlite-memory-mcp` as a **local MCP server** (`memory` in mcp config) backed by `.kiro/memory.db`. The **harness cloud** exposes the *same tools* (`memory/remember`, `memory/search`, `memory/recent`) backed by D1. Both follow the same contract — local for your agent's working memory, cloud for the FinOptix product's memory.

## Cost

- **Storage:** D1 + KV (Cloudflare free tier — no Durable Objects, no billing risk)
- **Inference:** OpenRouter models (gemma-3, qwen3) — pay per token
- **Deploy:** Cloudflare Worker free tier (100K req/day)

## Why not just a fine-tuned model?

A QLoRA model (FinOptix-14B) is the *engine*. The harness is the *vehicle*:
- Routing means 70% of queries hit cheap models — not always the 14B
- Tools give it **real AWS data**, not training-set hallucinations
- Sayay caps spend per user — no surprise bills
- Qhaway makes every decision observable and improvable
- If a better model ships, swap it in the registry — no logic changes

## Repos & packages

- Harness: `breakingthecloud/finoptix-harness`
- Framework: `@carloscortezcloud/tinkuy-agent`, `styrr-llm`, `sayay-guard`, `qhaway`, `tiderag`
- Model: `ccortezb/FinOptix-14B` (HF) + GGUF
- Landing: `ai.finoptix.dev` / corporate: `finoptix.dev`