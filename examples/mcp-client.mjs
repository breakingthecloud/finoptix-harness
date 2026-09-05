#!/usr/bin/env node
/**
 * FinOptix Harness — MCP client example (raw SSE, no SDK)
 *
 * Connects to agents.finoptix.dev, runs initialize + tools/list + a classify call.
 *
 * Usage:
 *   FINOPTIX_KEY=fp_live_... node examples/mcp-client.mjs "Compare costs across 5 accounts"
 */
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BASE = process.env.FINOPTIX_BASE ?? 'https://agents.finoptix.dev';
const KEY = process.env.FINOPTIX_KEY ?? 'fp_dev_local';
const prompt = process.argv[2] ?? 'What is a Reserved Instance?';

let jsonrpcId = 0;
const nextId = () => ++jsonrpcId;

async function rpc(method, params) {
  const res = await fetch(`${BASE}/messages?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: nextId() }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  console.log(`🔌 FinOptix MCP client → ${BASE}`);
  console.log('');

  // 1. initialize
  const init = await rpc('initialize', {});
  console.log(`✅ initialized: ${init.serverInfo.name} v${init.serverInfo.version} (${init.protocolVersion})`);

  // 2. tools/list
  const { tools } = await rpc('tools/list', {});
  console.log(`🧰 ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
  console.log('');

  // 3. classify (no LLM)
  const cls = await rpc('tools/call', { name: 'finops/classify', arguments: { prompt } });
  const clsData = JSON.parse(cls.content[0].text);
  console.log(`🔍 classify("${prompt.slice(0, 50)}…") → ${clsData.level} → model ${clsData.model}`);
  console.log('');
  console.log('✅ MCP handshake OK. Use finops/analyze for a full agent run (costs tokens).');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});