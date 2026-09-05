---
name: finoptix
description: FinOps AI harness — analyze costs, audit architectures, investigate anomalies. Exposes MCP tools (finops/analyze, architect/audit, investigate/cost) to any agent.
---

# FinOptix FinOps Harness

Connect your agent to FinOptix for AWS cost analysis, architecture governance, and anomaly investigation.

## Quick start

Add to your MCP config:

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

## When to use

Use FinOptix tools when the user asks about:
- **Costs**: "why did my bill spike?", "what are my top spenders?", "find savings"
- **Architecture**: "audit my terraform", "is this Well-Architected?", "validate BYaML"
- **Anomalies**: "investigate this cost spike", "find idle resources"

## Tools

| Tool | Use for |
|------|---------|
| `finops/analyze` | General FinOps questions + savings recommendations |
| `architect/audit` | Governance, compliance, Well-Architected review |
| `investigate/cost` | Root cause of cost anomalies/spikes |

## Best practices

- Provide context (terraform, cost JSON) when available — the agent uses it directly
- Ask follow-up questions — the harness supports multi-turn via session
- Rate responses 👍/👎 — feedback trains the routing classifier