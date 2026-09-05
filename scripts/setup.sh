#!/usr/bin/env bash
#
# FinOptix Harness — Quickstart (self-hosted deployment)
#
# Automates: login check → D1 create → KV create → wrangler.toml config
# → D1 migrate → secret → deploy → verify.
#
# Usage:
#   ./scripts/setup.sh [--domain agents.yourdomain.com] [--name my-gateway]
#
# Requires: node, wrangler (npm i -g wrangler), a Cloudflare account, OpenRouter key.

set -euo pipefail

# ─── helpers ──────────────────────────────────────────────────────────────
info()  { printf "\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
fail()  { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }

WORKER_NAME="${2:-finoptix-agent-gateway}"
DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --name)   WORKER_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ─── 1. checks ────────────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v node >/dev/null 2>&1 || fail "node not found (https://nodejs.org)"
command -v npx >/dev/null 2>&1 || fail "npx not found"
command -v wrangler >/dev/null 2>&1 || npm i -g wrangler >/dev/null 2>&1 || fail "wrangler install failed"

ACCOUNT_ID="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)"
[ -n "$ACCOUNT_ID" ] || { warn "Not logged into Cloudflare — run: npx wrangler login"; exit 1; }
ok "Cloudflare account: $ACCOUNT_ID"

# ─── 2. npm install ───────────────────────────────────────────────────────
info "Installing dependencies..."
[ -d node_modules ] || npm install --silent
ok "dependencies installed"

# ─── 3. create D1 ─────────────────────────────────────────────────────────
info "Creating D1 database..."
D1_OUTPUT="$(npx wrangler d1 create finoptix-harness 2>&1)"
D1_ID="$(echo "$D1_OUTPUT" | grep -oE 'database_id = "[0-9a-f-]+"' | head -1 | grep -oE '[0-9a-f-]+')"
[ -n "$D1_ID" ] || fail "D1 create failed:\n$D1_OUTPUT"
ok "D1 database: $D1_ID"

# ─── 4. create KV ─────────────────────────────────────────────────────────
info "Creating KV namespace..."
KV_OUTPUT="$(npx wrangler kv namespace create API_KEYS 2>&1)"
KV_ID="$(echo "$KV_OUTPUT" | grep -oE 'id = "[0-9a-f]+"' | head -1 | grep -oE '[0-9a-f]+')"
[ -n "$KV_ID" ] || fail "KV create failed:\n$KV_OUTPUT"
ok "KV namespace: $KV_ID"

# ─── 5. write wrangler.toml ───────────────────────────────────────────────
info "Writing wrangler.toml..."
cat > wrangler.toml <<EOF
name = "$WORKER_NAME"
account_id = "$ACCOUNT_ID"
main = "worker/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[vars]
ENVIRONMENT = "prod"

[[kv_namespaces]]
binding = "API_KEYS"
id = "$KV_ID"

[[d1_databases]]
binding = "DB"
database_name = "finoptix-harness"
database_id = "$D1_ID"
EOF

if [ -n "$DOMAIN" ]; then
  cat >> wrangler.toml <<EOF

[[routes]]
pattern = "$DOMAIN"
custom_domain = true
EOF
fi
ok "wrangler.toml configured (name=$WORKER_NAME${DOMAIN:+ domain=$DOMAIN})"

# ─── 6. secret ────────────────────────────────────────────────────────────
info "Setting OPENROUTER_API_KEY secret..."
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  echo "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY >/dev/null 2>&1
  ok "secret set from OPENROUTER_API_KEY env"
else
  warn "Paste your OpenRouter API key (sk-or-...) when prompted:"
  npx wrangler secret put OPENROUTER_API_KEY
fi

# ─── 7. migrate D1 (idempotent via /health) ──────────────────────────────
info "Migrating D1 schema (via first deploy + /health)..."
npx wrangler deploy 2>&1 | grep -E "Uploaded|Deployed|https://" || true

WORKER_URL="https://$WORKER_NAME.$ACCOUNT_ID.workers.dev"
info "Verifying /health..."
for i in $(seq 1 5); do
  BODY="$(curl -s --max-time 10 "$WORKER_URL/health" || true)"
  if echo "$BODY" | grep -q '"status":"ok"'; then
    ok "healthy: $BODY"
    break
  fi
  [ "$i" -lt 5 ] && sleep 2
done
echo "$BODY" | grep -q '"status":"ok"' || warn "/health not ok yet — check: $WORKER_URL/health"

# ─── done ─────────────────────────────────────────────────────────────────
cat <<'EOF'

┌───────────────────────────────────────────────────────────┐
│   ✅ FinOptix Harness deployed!                            │
├───────────────────────────────────────────────────────────┤
│   Health:   {WORKER_URL}/health                           │
│   MCP SSE:  {WORKER_URL}/sse                              │
│   Add to your IDE MCP config:                             │
│     { "mcpServers": { "finoptix": {                       │
│         "url": "{WORKER_URL}/sse",                        │
│         "transport": "sse",                               │
│         "headers": { "X-FinOptix-Key": "fp_dev_local" }   │
│     } } }                                                 │
│                                                           │
│   Team keys: curl -X POST {WORKER_URL}/v1/keys \          │
│     -H 'Content-Type: application/json'                   │
│     -H 'X-FinOptix-Key: fp_dev_local'                     │
│     -d '{"user_id":"member"}'                             │
└───────────────────────────────────────────────────────────┘
EOF