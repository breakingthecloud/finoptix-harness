# FinOptix Harness — Self-Hosted Deployment Guide

Deploy your own `finoptix-harness` instance on your Cloudflare account. Each instance is **single-tenant** (own D1 + KV), free tier.

> **agents.finoptix.dev** is the reference deployment. This guide is for anyone (you, a team, a company) who wants their **own** instance.

## 1. Prerequisites

- [ ] Node 18+ / npm
- [ ] Cloudflare account (free)
- [ ] Wrangler authenticated: `npx wrangler login`
- [ ] OpenRouter API key (`sk-or-...`) — or any provider Styrr supports

## 2. Clone & install

```bash
git clone https://github.com/breakingthecloud/finoptix-harness
cd finoptix-harness
npm install
```

## 3. Quickstart (automated) — RECOMMENDED

```bash
# Everything: login check → D1 → KV → wrangler.toml → secret → deploy → verify
npm run setup

# With custom domain (zone on your Cloudflare):
npm run setup -- --domain agents.yourdomain.com

# Custom worker name:
npm run setup -- --name my-finops
```

The script creates D1 + KV, writes `wrangler.toml`, prompts for the OpenRouter key, deploys, and verifies `/health`. ~5 minutes total.

## 3b. Manual path (alternative)

```bash
# D1 database
npx wrangler d1 create finoptix-harness
# → note the database_id

# KV namespace for API keys
npx wrangler kv namespace create API_KEYS
# → note the id
```

## 4. Configure wrangler.toml

Edit `wrangler.toml`:

```toml
name = "finoptix-agent-gateway"        # your name
account_id = "YOUR_ACCOUNT_ID"         # npx wrangler whoami

[[kv_namespaces]]
binding = "API_KEYS"
id = "YOUR_KV_ID"                      # from step 3

[[d1_databases]]
binding = "DB"
database_name = "finoptix-harness"
database_id = "YOUR_D1_ID"             # from step 3

# Optional custom domain (finoptix.dev zone):
[[routes]]
pattern = "agents.yourdomain.com"
custom_domain = true
```

## 5. Secrets

```bash
npx wrangler secret put OPENROUTER_API_KEY
# paste your sk-or-... key
```

## 6. Migrate D1 (tables)

```bash
npx wrangler d1 execute finoptix-harness --remote --file ./migrations/001-init.sql
```

> If `migrations/001-init.sql` doesn't exist yet, run the SQL from `worker/db.ts` (`initSchema`) manually, or deploy once and hit `/health` (it initializes idempotently).

## 7. Deploy

```bash
npm run deploy:worker
# → https://finoptix-agent-gateway.YOUR-ACCOUNT.workers.dev
```

## 8. Verify

```bash
curl https://finoptix-agent-gateway.YOUR-ACCOUNT.workers.dev/health
# → { "service": "finoptix-agent-gateway", "tools": 4, "storage": "d1", "status": "ok" }
```

## 9. Use it

Add to your IDE MCP config:

```json
{
  "mcpServers": {
    "finoptix": {
      "url": "https://YOUR-INSTANCE.workers.dev/sse",
      "transport": "sse",
      "headers": { "X-FinOptix-Key": "fp_dev_local" }
    }
  }
}
```

For team shared use, issue real keys:

```bash
curl -X POST https://YOUR-INSTANCE.workers.dev/v1/keys \
  -H 'Content-Type: application/json' -H 'X-FinOptix-Key: fp_dev_local' \
  -d '{"user_id":"team-member"}'
```

## Notes

- **Free tier:** D1 (5M reads/100K writes/day, 5GB) + KV (100K reads/1K writes/day) — scale-to-zero
- **No Durable Objects** — avoids DO SQLite billing (since Jan 2026)
- **Single-tenant:** each deployment has its own storage — no cross-tenant mixing
- **Local option:** you can also run it fully local (`npm run dev:worker`) with in-memory storage
- **AWS option:** the worker is Cloudflare-specific, but the core (`src/`) is pure TS — could run on Lambda/EC2 with a D1-equivalent (Postgres/SQLite)