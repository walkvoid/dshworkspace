#!/usr/bin/env node
/**
 * 需求分析纯函数自检（不读写真实需求、不发网络请求）。
 *
 *   node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import { computeEstimate, detectCycles, sumTotals, validateRequirement } from './req.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

const estimateOf = (parts, factors = [], buffer = 1.5) => {
  const estimate = { parts, factors, buffer };
  const computed = computeEstimate(estimate);
  return { ...estimate, ...computed, note: '' };
};

const makeDoc = () => {
  const estimate = estimateOf([{ name: '后端', days: 1 }, { name: '自测', days: 0.25 }], [{ name: '核心流程', multiplier: 1.3 }]);
  const doc = {
    schema: 1,
    id: 'req-20261105-demo',
    title: '示例需求',
    project: 'demo',
    status: 'draft',
    receivedAt: '2026-11-05',
    sources: [
      { id: 'SRC-1', file: 'docs/PRD.docx', kind: 'document', locator: 'p.1-3', note: '' },
      { id: 'SRC-2', file: 'docs/PRD.docx#图1', kind: 'image', locator: 'p.2 签发流程', note: '' },
    ],
    diagrams: [
    {
      id: 'DG-1',
      sourceId: 'SRC-2',
      title: '签发流程',
      kind: 'flow',
      lanes: ['客户端', 'SAAS'],
      nodes: [
        { seq: 1, actor: '供应商', action: '提交签发', system: '客户端' },
        { seq: 2, actor: '系统', action: '调签章服务', system: 'SAAS', branch: '成功/失败' },
      ],
      branches: [{ from: '调签章服务', condition: '失败', to: '重试三次' }],
      thresholds: [],
      integrations: ['签章服务'],
      confidence: 'verified',
      note: '',
    },
  ],
  subRequirements: [
      {
        id: 'SR-1',
        title: '签发接口加参数',
        domain: 'cust',
        category: 'api',
        secondary: ['model'],
        action: 'modify',
        sourceId: 'SRC-1',
        locator: 'p.2',
        quote: '签发接口需支持签章方式（p.2）',
        acceptance: ['不传保持原行为'],
        changePoints: [
          {
            kind: 'http',
            file: 'service-a-web/.../AssetIssueController.java',
            line: 87,
            symbol: 'AssetIssueController#issue',
            confidence: 'verified',
            note: '',
          },
        ],
        newCode: [],
        estimate,
        risks: [],
        dependsOn: [],
        openQuestions: [],
      },
      {
        id: 'SR-2',
        title: '新增签章记录表',
        domain: 'asset',
        category: 'schema',
        secondary: [],
        action: 'add',
        sourceId: 'SRC-2',
        locator: 'p.2 图1',
        quote: '记录每次签章结果（p.3）',
        acceptance: ['可按签发单查询'],
        changePoints: [
          { kind: 'table', file: 'service-a/.../AssetSealMapper.xml', line: 1, symbol: 'asset_seal', confidence: 'inferred', note: '新表' },
        ],
        newCode: [
          { layer: 'entity', className: 'AssetSeal', methods: [], package: 'com.example.asset.entity', pattern: '参照 AssetIssue', reason: '新表实体' },
        ],
        estimate: estimateOf([{ name: '建表与实体', days: 0.5 }, { name: '自测', days: 0.25 }]),
        risks: [],
        dependsOn: ['SR-1'],
        openQuestions: [],
      },
    ],
    questions: [
      {
        id: 'Q-1',
        severity: 'P1',
        question: '签章记录保留多久？',
        why: '原文未给保留期（p.3）',
        assumption: '先按 3 年',
        owner: '产品',
        affects: ['SR-2'],
        resolved: false,
      },
    ],
    totals: { p50: 0, p90: 0, byCategory: {} },
    generatedAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  };
  doc.totals = sumTotals(doc);
  return doc;
};

test('computeEstimate 按基线示例算 p50/p90', () => {
  const result = computeEstimate({ parts: [{ days: 1.75 }], factors: [{ multiplier: 1.3 }], buffer: 1.5 });
  assert.equal(result.base, 1.75);
  assert.equal(result.p50, 2.5);
  assert.equal(result.p90, 3.75);
});

test('computeEstimate 无因子时只乘 buffer，且按 0.25 向上取整', () => {
  const result = computeEstimate({ parts: [{ days: 0.3 }], factors: [], buffer: 1.5 });
  assert.equal(result.p50, 0.5);
  assert.equal(result.p90, 0.75);
});

test('sumTotals 汇总 p50/p90 与按大类', () => {
  const totals = sumTotals(makeDoc());
  assert.equal(totals.p50, 2.5);
  assert.equal(totals.p90, 4);
  assert.deepEqual(totals.byCategory, { api: 1.75, schema: 0.75 });
  assert.deepEqual(totals.byDomain, { cust: 1.75, asset: 0.75 });
});

test('validateRequirement 接受结构完整的需求', () => {
  const { problems, warnings } = validateRequirement(makeDoc());
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
});

test('validateRequirement 拦截缺少来源清单', () => {
  const doc = makeDoc();
  doc.sources = [];
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('sources 为空')));
});

test('validateRequirement 要求 sourceId 指向存在的来源', () => {
  const doc = makeDoc();
  doc.subRequirements[0].sourceId = 'SRC-9';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('sourceId 指向不存在的来源')));
});

test('validateRequirement 对未被引用的来源给出警告', () => {
  const doc = makeDoc();
  doc.sources.push({ id: 'SRC-4', file: 'docs/附件2-DDL.sql', kind: 'attachment', locator: '全文件', note: '' });
  const { problems, warnings } = validateRequirement(doc);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((item) => item.includes('SRC-4') && item.includes('没有被任何子需求引用')));
});

test('validateRequirement 拦截非法来源类型', () => {
  const doc = makeDoc();
  doc.sources[1].kind = 'screenshot';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('来源 kind 必须是')));
});


test('validateRequirement 拦截缺少业务域', () => {
  const doc = makeDoc();
  delete doc.subRequirements[0].domain;
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('domain 不在 12 个业务域内')));
});

test('validateRequirement 拦截未知业务域', () => {
  const doc = makeDoc();
  doc.subRequirements[0].domain = 'finance';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('domain 不在 12 个业务域内')));
});

test('validateRequirement 对兜底业务域给出警告', () => {
  const doc = makeDoc();
  doc.subRequirements[0].domain = 'platform';
  doc.totals = sumTotals(doc);
  const { problems, warnings } = validateRequirement(doc);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((item) => item.includes('容易变成兜底分类')));
});

test('validateRequirement 校验排除项', () => {
  const doc = makeDoc();
  doc.excluded = [{ id: 'EX-1', label: '下版本的额度查询', reason: 'next-version', sourceId: 'SRC-1', locator: '3.5' }];
  doc.totals = sumTotals(doc);
  assert.deepEqual(validateRequirement(doc).problems, []);

  const bad = makeDoc();
  bad.excluded = [{ id: 'EX-9', label: '', reason: 'deleted', sourceId: 'SRC-404' }];
  const { problems } = validateRequirement(bad);
  assert.ok(problems.some((item) => item.includes('排除项缺少 label')));
  assert.ok(problems.some((item) => item.includes('reason 必须是')));
  assert.ok(problems.some((item) => item.includes('sourceId 指向不存在的来源')));
});


test('validateRequirement 要求流程图落成节点', () => {
  const doc = makeDoc();
  doc.diagrams[0].nodes = [];
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('nodes 为空')));
});

test('validateRequirement 对未识别的图片给警告', () => {
  const doc = makeDoc();
  doc.diagrams = [];
  const { warnings } = validateRequirement(doc);
  assert.ok(warnings.some((item) => item.includes('必须做图片识别')));
});

test('validateRequirement 接受版本命名 id', () => {
  const doc = makeDoc();
  doc.id = 'req-v3.0.0-demo';
  assert.deepEqual(validateRequirement(doc).problems, []);
});

test('validateRequirement 拦截非法 id', () => {
  const doc = makeDoc();
  doc.id = 'jasolar-saas-v3';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('id 必须形如')));
});

test('validateRequirement 拦截缺少原文引用', () => {
  const doc = makeDoc();
  doc.subRequirements[0].quote = '';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('缺少原文引用')));
});

test('validateRequirement 拦截非法大类与动作', () => {
  const doc = makeDoc();
  doc.subRequirements[0].category = 'frontend';
  doc.subRequirements[0].action = 'create';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('category 不在 12 类枚举内')));
  assert.ok(problems.some((item) => item.includes('action 必须是')));
});

test('validateRequirement 要求 P0 有默认假设与确认人', () => {
  const doc = makeDoc();
  doc.questions[0].severity = 'P0';
  doc.questions[0].assumption = '';
  doc.questions[0].owner = '';
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('P0 必须给建议默认值')));
  assert.ok(problems.some((item) => item.includes('P0 必须写找谁确认')));
});

test('validateRequirement 拦截未重算的估时', () => {
  const doc = makeDoc();
  doc.subRequirements[0].estimate.p50 = 9;
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('先跑 req.mjs estimate')));
});

test('validateRequirement 拦截依赖环', () => {
  const doc = makeDoc();
  doc.subRequirements[0].dependsOn = ['SR-2'];
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('dependsOn 存在环')));
});

test('detectCycles 对无环图返回空', () => {
  assert.deepEqual(detectCycles([{ id: 'SR-1', dependsOn: ['SR-2'] }, { id: 'SR-2', dependsOn: [] }]), []);
});

test('status 不是 draft 时不允许未解决 P0', () => {
  const doc = makeDoc();
  doc.status = 'analyzed';
  doc.questions.push({
    id: 'Q-2',
    severity: 'P0',
    question: '口径？',
    why: '未写',
    assumption: '按自然月',
    owner: '产品',
    affects: ['SR-1'],
    resolved: false,
  });
  const { problems } = validateRequirement(doc);
  assert.ok(problems.some((item) => item.includes('status 只能保持 draft')));
});

console.log(`\n${passed} passed`);
