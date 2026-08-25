import { describe, it, expect } from 'vitest';
import { classify, modelForLevel, isEnterpriseOnly } from '../src/classifier.js';

const CONTEXT_MULTI_RES = [
  'resource "aws_instance" "a" {}',
  'resource "aws_lambda_function" "b" {}',
  'resource "aws_rds_instance" "c" {}',
  'resource "aws_s3_bucket" "d" {}',
  'resource "aws_ecs_service" "e" {}',
].join('\n');

const LARGE_CONTEXT = '{"service":"RDS","cost":400}. '.repeat(600);

describe('FinOptix Classifier L1-L6', () => {
  it('L1 — trivial glossary', () => {
    const r = classify({ prompt: 'What is RI?' });
    expect(r.level).toBe('L1');
    expect(modelForLevel(r.level)).toBe('finemma-4b');
  });

  it('L1 — simple yes/no', () => {
    expect(classify({ prompt: 'Is t3.micro good for dev?' }).level).toBe('L1');
  });

  it('L2 — single resource tag check', () => {
    const r = classify({ prompt: 'Check if this resource has tags', context: 'resource "aws_instance" "web" {}' });
    expect(r.level).toBe('L2');
    expect(modelForLevel(r.level)).toBe('finoptix-7b');
  });

  it('L3 — medium depth needed', () => {
    const r = classify({ prompt: 'Audit this TF file', context: CONTEXT_MULTI_RES });
    expect(r.level).toBe('L3');
    expect(modelForLevel(r.level)).toBe('finoptix-14b');
  });

  it('L3 — bill spike (domain reasoning)', () => {
    const r = classify({ prompt: 'Why did my bill spike 300%?' });
    expect(r.level).toBe('L3');
  });

  it('L4 — large context cost spike', () => {
    const r = classify({ prompt: 'Why did my bill spike 300%?', context: LARGE_CONTEXT });
    expect(r.level).toBe('L4');
  });

  it('L5 — multi-account comparison', () => {
    const r = classify({ prompt: 'Compare costs across my 5 accounts and recommend a migration plan' });
    expect(r.level).toBe('L5');
    expect(isEnterpriseOnly(r.level, 'free')).toBe(true);
    expect(isEnterpriseOnly(r.level, 'enterprise')).toBe(false);
  });

  it('mode=executive forces L5', () => {
    const r = classify({ prompt: 'Summarize spending for the board', mode: 'executive' });
    expect(r.level).toBe('L5');
  });

  it('mode=terraform ≤L3 routes to finocode-7b', () => {
    const r = classify({ prompt: 'Audit this TF file', context: CONTEXT_MULTI_RES, mode: 'terraform' });
    expect(modelForLevel(r.level, 'terraform')).toBe('finocode-7b');
  });

  it('computes promptHash + tokens', () => {
    const r = classify({ prompt: 'What is RI?' });
    expect(r.promptHash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.promptTokens).toBeGreaterThan(0);
    expect(r.signals.length).toBeGreaterThan(0);
  });
});