# FinOptix Harness — Testing Guide

Cómo probar el harness, de barato a caro: desde tests unitarios hasta el agente completo en producción.

## 0. Prerequisitos

```bash
cd finoptix-harness
npm install
```

Niveles de prueba (de menor a mayor costo):

| Nivel | Costo | Qué verifica |
|-------|-------|--------------|
| 1. Unit tests | $0 | Lógica del harness |
| 2. Classify offline | $0 | Routing L1-L6 |
| 3. Health/API keys | ~$0 | Infra deployada |
| 4. MCP handshake | ~$0 | Conectividad + tools |
| 5. Agente LLM | tokens | Tool use + razonamiento |

---

## 1. Tests unitarios ($0)

```bash
npm test           # 34 tests: classifier, agent, multi-agente, observabilidad, db
npm run typecheck  # tsc --noEmit
```

Cubre: classifier L1-L6, provider registry, agent tools (cost_summary/blast_radius/remediation), multi-agente, observabilidad (ratings/stats), db (D1 + KV mocks).

## 2. Classify offline ($0 — no requiere API key)

```bash
# Clasificador L1-L6 — prueba el routing
npm run classify -- "What is RI?"
npm run classify -- "Audit my terraform" 'resource "aws_instance" "web" {}'
npm run classify -- "Compare costs across 5 accounts"

# Demo de steering (offline: muestra decisión de routing sin llamar LLM)
npm run demo -- "Why did my bill spike?"
```

**Esperado:** `"What is RI?"` → L1/finemma-4b · `"Audit"` → L3/finoptix-14b · `"Compare 5 accounts"` → L5/finomotrix-49b.

## 3. Infra deployada (~$0)

```bash
# Health — confirma worker + D1 + tools
curl https://agents.finoptix.dev/health
# → { "service": "finoptix-agent-gateway", "tools": 4, "storage": "d1", "status": "ok" }

# Sin API key → 401 (auth funciona)
curl -o /dev/null -w "%{http_code}" https://agents.finoptix.dev/v1/finops/stats   # 401
```

## 4. MCP handshake (~$0 — no consume tokens)

```bash
FINOPTIX_KEY=fp_dev_local node examples/mcp-client.mjs "Compare costs across 5 accounts"
```

**Esperado:** initialize OK → 4 tools → `classify("...")` → L5 → model finomotrix-49b.

El mismo handshake manual con curl:

```bash
# tools/list
curl -X POST "https://agents.finoptix.dev/messages?key=fp_dev_local" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# classify (sin LLM)
curl -X POST "https://agents.finoptix.dev/messages?key=fp_dev_local" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"finops/classify","arguments":{"prompt":"Audit my terraform"}},"id":2}'

# feedback (escribe span en D1)
curl -X POST "https://agents.finoptix.dev/v1/finops/feedback" \
  -H 'content-type: application/json' -H 'X-FinOptix-Key: fp_dev_local' \
  -d '{"session_id":"test-1","rating":1,"message":"ok","user_id":"you"}'

# stats (lee spans de D1)
curl "https://agents.finoptix.dev/v1/finops/stats?key=fp_dev_local"
```

## 5. Agente LLM completo (consume tokens OpenRouter)

```bash
# REST — agente completo con tool use
FINOPTIX_KEY=fp_dev_local node examples/rest-client.mjs \
  "List cost breakdown by layer and give 2 savings recommendations"

# MCP — finops/analyze
curl -X POST "https://agents.finoptix.dev/messages?key=fp_dev_local" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"finops/analyze","arguments":{"prompt":"What is a Reserved Instance?"}},"id":3}'
```

**Esperado:** respuesta del modelo (qwen3-14b) + metadata `{complexity, agent, model_used, tools_used, latency_ms}`.

## 6. Desde un IDE (la prueba de fuego)

Configurar Kiro/VS Code/Claude Code:

```json
{
  "mcpServers": {
    "finoptix": {
      "url": "https://agents.finoptix.dev/sse",
      "transport": "sse",
      "headers": { "X-FinOptix-Key": "fp_dev_local" }
    }
  }
}
```

Preguntas de prueba:
- *"¿Por qué subió mi bill?"* → finops/analyze
- *"Audita este terraform"* (pegar HCL) → architect/audit
- *"Investiga el spike de compute"* → investigate/cost

## 7. API keys (ciclo completo)

```bash
# emitir (dev: fp_dev_local como admin)
KEY=$(curl -s -X POST "https://agents.finoptix.dev/v1/keys" \
  -H 'content-type: application/json' -H 'X-FinOptix-Key: fp_dev_local' \
  -d '{"user_id":"you"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])")

# usar la key real
curl "https://agents.finoptix.dev/v1/finops/stats?key=$KEY"

# revocar
curl -s -X POST "https://agents.finoptix.dev/v1/keys/revoke" \
  -H 'content-type: application/json' -H 'X-FinOptix-Key: fp_dev_local' \
  -d "{\"api_key\":\"$KEY\"}"

# key revocada → 401
curl -o /dev/null -w "%{http_code}" "https://agents.finoptix.dev/v1/finops/stats?key=$KEY"  # 401
```

## 8. Dev local (worker)

```bash
npm run dev:worker   # wrangler dev → http://localhost:8787
curl http://localhost:8787/health
```

D1/KV locales se crean automáticamente. Los endpoints son idénticos a prod.

---

## Orden recomendado

1. `npm test` + `npm run typecheck` (verifica lógica)
2. `npm run classify` (verifica routing, gratis)
3. `curl /health` + `mcp-client.mjs` (verifica deploy + handshake)
4. feedback + stats (verifica D1)
5. `rest-client.mjs` (verifica agente + tools, consume tokens)
6. IDE (prueba de fuego)