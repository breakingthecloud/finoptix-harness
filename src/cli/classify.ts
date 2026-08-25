#!/usr/bin/env tsx
/**
 * Classify a FinOps query → complexity L1-L6 (no API key needed).
 *
 * Usage:
 *   npm run classify -- "Audit this terraform file" "full tf content..."
 */
import { classify, modelForLevel } from '../classifier.js';

const [, , promptArg, ctxArg] = process.argv;

if (!promptArg) {
  console.log('Usage: npm run classify -- "<prompt>" ["<context>"]');
  console.log('Examples:');
  console.log('  npm run classify -- "What is a Reserved Instance?"');
  console.log('  npm run classify -- "Audit my terraform" "resource \\"aws_instance\\" {...}"');
  process.exit(0);
}

const result = classify({ prompt: promptArg, context: ctxArg ?? '' });

console.log('┌─────────────────────────────────────────────┐');
console.log('│   FinOptix Classifier — L1-L6              │');
console.log('└─────────────────────────────────────────────┘');
console.log(`Prompt:  ${promptArg.slice(0, 60)}${promptArg.length > 60 ? '…' : ''}`);
console.log(`Level:   ${result.level}`);
console.log(`Signals: ${result.signals.join(' | ')}`);
console.log(`Tokens:  prompt=${result.promptTokens} context=${result.contextTokens}`);
console.log(`Model:   ${modelForLevel(result.level)}`);
console.log('');
console.log('--- test matrix ---');
for (const [p, c] of [
  ['What is RI?', ''],
  ['Is t3.micro good for dev?', ''],
  ['Check if this resource has tags', 'resource "aws_instance" "web" {}'],
  ['Audit this TF file', 'resource "aws_s3_bucket" "a" {}\nresource "aws_lambda_function" "b" {}\nresource "aws_rds_instance" "c" {}'],
  ['Why did my bill spike 300%? Analyze cost data', '{"RDS": 400, "Lambda": 900}. Long context with many services and groups. '.repeat(80)],
  ['Compare costs across my 5 accounts and recommend a migration plan', ''],
]) {
  const r = classify({ prompt: p, context: c });
  console.log(`  ${r.level.padEnd(3)}  ←  ${p.slice(0, 55)}`);
}