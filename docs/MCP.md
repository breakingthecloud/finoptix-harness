# Connect FinOptix Harness to your IDE (MCP)

FinOptix exposes a **remote MCP server** at `agents.finoptix.dev` — works with Kiro CLI, VS Code, Cursor, Windsurf, Claude Code, and any MCP-compatible agent.

## 1. Get an API key

```bash
curl -X POST https://agents.finoptix.dev/v1/keys \
  -H 'Content-Type: application/json' \
  -H 'X-FinOptix-Key: fp_dev_local' \
  -d '{"user_id":"your-username"}'
# → { "api_key": "fp_live_..." }  ← store once, shown only here
```

> Dev key `fp_dev_local` works for local testing. In production, keys are issued via the platform dashboard (coming).

## 2. Configure your agent

### Kiro (`.kiro/settings/mcp.json`)
```json
{
  "mcpServers": {
    "finoptix": {
      "url": "https://agents.finoptix.dev/sse",
      "transport": "sse",
      "headers": { "X-FinOptix-Key": "fp_live_..." }
    }
  }
}
```

### Claude Code / Cursor / VS Code
```json
{
  "mcpServers": {
    "finoptix": {
      "url": "https://agents.finoptix.dev/sse",
      "headers": { "X-FinOptix-Key": "fp_live_..." }
    }
  }
}
```

## 3. Tools available

| Tool | What it does |
|------|-------------|
| `finops/analyze` | Run the FinOps Analyst agent (costs, savings, questions) |
| `finops/classify` | Classify prompt → L1-L6 + recommended model (no LLM) |
| `architect/audit` | Architecture Auditor (governance, compliance, Well-Architected) |
| `investigate/cost` | Cost Investigator (root cause of anomalies) |

## 4. Example

Ask in your IDE:
> "Investigate why my compute costs spiked. Here's the breakdown: compute $512, storage $187."

The agent:
1. Classifies → L3 (medium)
2. Calls `cost_summary` tool → gets real breakdown
3. Reasons with the model → returns structured findings + remediation

## REST API (for scripts / CI)

```bash
# Analyze
curl -X POST https://agents.finoptix.dev/v1/finops/analyze \
  -H 'Content-Type: application/json' \
  -H 'X-FinOptix-Key: fp_live_...' \
  -d '{"prompt":"Find idle resources","context":"","mode":"cost"}'

# Feedback (feeds the adaptive classifier)
curl -X POST https://agents.finoptix.dev/v1/finops/feedback \
  -H 'Content-Type: application/json' \
  -H 'X-FinOptix-Key: fp_live_...' \
  -d '{"session_id":"<session>","rating":1,"message":"helpful","user_id":"you"}'

# Stats
curl https://agents.finoptix.dev/v1/finops/stats?key=fp_live_...
```

## Health

```bash
curl https://agents.finoptix.dev/health
# → { "service": "finoptix-agent-gateway", "tools": 4, "storage": "d1", "status": "ok" }
```