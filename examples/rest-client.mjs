#!/usr/bin/env node
/**
 * FinOptix Harness — REST client example
 *
 * Uses /v1/finops/analyze + /v1/finops/feedback directly (no MCP).
 *
 * Usage:
 *   FINOPTIX_KEY=fp_live_... node examples/rest-client.mjs "Audit this terraform for cost" --context 'resource "aws_s3_bucket" "data" {}'
 */
const BASE = process.env.FINOPTIX_BASE ?? 'https://agents.finoptix.dev';
const KEY = process.env.FINOPTIX_KEY ?? 'fp_dev_local';

const args = process.argv.slice(2);
const promptIdx = args.findIndex((a) => !a.startsWith('--'));
const prompt = args[promptIdx] ?? 'Analyze my costs and suggest savings';
const ctxIdx = args.findIndex((a) => a === '--context');
const context = ctxIdx >= 0 ? args[ctxIdx + 1] : '';

async function analyze() {
  const res = await fetch(`${BASE}/v1/finops/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-FinOptix-Key': KEY },
    body: JSON.stringify({ prompt, context, mode: 'cost' }),
  });
  return res.json();
}

async function main() {
  console.log(`🌊 FinOptix REST → ${BASE}`);
  console.log(`📝 "${prompt}"${context ? `\n📎 context: ${context.slice(0, 60)}…` : ''}`);
  console.log('');

  const start = Date.now();
  const result = await analyze();
  const elapsed = Date.now() - start;

  console.log(`✅ analysis (${elapsed}ms):`);
  console.log('');
  console.log(result.analysis?.slice(0, 600) ?? result);
  console.log('');
  console.log('📊 metadata:', JSON.stringify(result.metadata, null, 2));
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});