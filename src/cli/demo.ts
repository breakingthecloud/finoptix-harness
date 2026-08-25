#!/usr/bin/env tsx
/**
 * FinOptix Steering demo — Classifier + Sayay budget + Styrr routing.
 *
 * REQUIRES OPENROUTER_API_KEY for the LLM call (Stryrr).
 * Without it, shows the routing DECISION (classifier + budget) offline.
 *
 * Usage:
 *   export OPENROUTER_API_KEY=sk-or-...
 *   npm run demo -- "Why did my bill spike?"
 */
import { createHarness } from '../steering.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const prompt = process.argv[2] || 'What are my top AWS costs this month?';

const harness = createHarness({
  openrouterApiKey: apiKey || 'sk-or-missing',
  modelRegistry: ['finoptix-14b', 'finoptix-7b', 'finemma-4b'], // FinOptix family providers
  budgetUsd: { free: 0.5, pro: 2.0, enterprise: 999999 },
  agentName: 'finoptix-demo',
});

async function main() {
  console.log('🌊 FinOptix Harness — Steering demo');
  console.log('━'.repeat(56));
  console.log(`📝 "${prompt}"\n`);

  if (!apiKey) {
    // Offline: show routing decision only
    const cls = harness.classify({ prompt, context: '' });
    console.log(`🔍 classify() → ${cls.level}`);
    console.log(`   signals: ${cls.signals.join(' | ')}`);
    console.log(`   promptHash: ${cls.promptHash}`);
    console.log('');
    console.log('⚠️  OPENROUTER_API_KEY not set — showing routing decision only.');
    console.log('   export OPENROUTER_API_KEY=sk-or-... for live inference.');
    return;
  }

  const result = await harness.steer({
    prompt,
    context: '',
    userId: 'demo-user',
    tier: 'pro',
  });

  console.log('');
  console.log('━'.repeat(56));
  if (result.metadata.blocked) {
    console.log(`⛔ BLOCKED: ${result.metadata.block_reason}`);
    console.log(`   ${result.analysis}`);
  } else {
    console.log('📊 Result:');
    console.log('');
    console.log(result.analysis);
  }
  console.log('');
  console.log('📈 metadata:');
  console.log(result.metadata);
}

main().catch(console.error);