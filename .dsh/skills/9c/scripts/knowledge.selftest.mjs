#!/usr/bin/env node
/**
 * knowledge.mjs 的纯函数自检（不联网、不读写真实 claims）。
 *
 *   node scripts/knowledge.selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, compileClaims, validateCase, validateClaim, validateClaims } from './knowledge.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

const baseClaim = (overrides = {}) => ({
  id: 'test-001',
  type: 'rule',
  dimension: 'valuation',
  statement: '穿透回报率低于 3% 不在体系内',
  conditions: ['A股'],
  as_of: '2025-04-12',
  effective_from: '2025-04-12',
  status: 'active',
  confidence: 'high',
  reviewed: true,
  reviewed_at: '2026-11-04',
  evidence: { kind: 'video', bvid: 'BV1xxxxxxxxx', t: 1832, quote: '三年股息率不到 3 个点，这个就不在我的体系里' },
  supersedes: null,
  ...overrides,
});

test('合法 video claim 通过校验', () => {
  const result = validateClaim(baseClaim());
  assert.deepEqual(result.errors, []);
});

test('video 证据 bvid / t / quote 不合法会报错', () => {
  const result = validateClaim(
    baseClaim({ evidence: { kind: 'video', bvid: 'BV123', t: -1, quote: '' } }),
  );
  assert.equal(result.errors.some((message) => message.includes('bvid')), true);
  assert.equal(result.errors.some((message) => message.includes('t 必须')), true);
  assert.equal(result.errors.some((message) => message.includes('quote')), true);
});

test('active 但未审核 / 缺 as_of 会报错', () => {
  const result = validateClaim(baseClaim({ reviewed: false, as_of: '2025/04/12' }));
  assert.equal(result.errors.some((message) => message.includes('reviewed:true')), true);
  assert.equal(result.errors.some((message) => message.includes('as_of')), true);
});

test('重复 id 会报错', () => {
  const ids = new Set(['test-001']);
  const result = validateClaim(baseClaim(), { ids });
  assert.equal(result.errors.some((message) => message.includes('id 重复')), true);
});

test('validateClaims 读文件并检查 supersedes 引用', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '9c-claims-'));
  try {
    const file = path.join(root, 'claims.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify(baseClaim()),
        JSON.stringify(baseClaim({ id: 'test-002', supersedes: 'missing-001' })),
      ].join('\n'),
      'utf8',
    );
    const result = validateClaims(file);
    assert.equal(result.total, 2);
    assert.equal(result.active, 2);
    assert.equal(result.errors.some((message) => message.includes('supersedes 指向不存在')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compileClaims 只编译 active + reviewed', () => {
  const claims = [
    baseClaim(),
    baseClaim({ id: 'candidate-001', status: 'candidate', reviewed: false }),
    baseClaim({ id: 'deprecated-001', status: 'deprecated', superseded_by: 'test-001' }),
  ];
  const compiled = compileClaims(claims);
  assert.equal(compiled.count, 1);
  assert.equal(compiled.markdown.includes('test-001'), true);
  assert.equal(compiled.markdown.includes('candidate-001'), false);
  assert.equal(compiled.markdown.includes('deprecated-001'), false);
});

test('buildPrompt 带上 schema 与转写，不联网', () => {
  const prompt = buildPrompt({ transcript: '[00:00:01] 股息率三个点以下不在体系里', bvid: 'BV1xxxxxxxxx', title: '测试' });
  assert.equal(prompt.includes('claim JSON Schema'), true);
  assert.equal(prompt.includes('BV1xxxxxxxxx'), true);
  assert.equal(prompt.includes('股息率三个点以下'), true);
  assert.equal(prompt.includes('status 一律填 candidate'), true);
});

test('合法股票判断 case 通过校验', () => {
  const result = validateCase({
    id: 'case-001',
    stock: { name: '中国平安', code: '601318', market: 'A' },
    as_of: '2025-01-02',
    stance: 'avoid',
    thesis: ['高杠杆', '不在第三步标的范围'],
    horizon: '12m',
    source: { kind: 'video', bvid: 'BV1xxxxxxxxx', t: 100, quote: '这种高杠杆的我不碰' },
    outcome: null,
  });
  assert.deepEqual(result.errors, []);
});

console.log(`\n${passed} passed`);
