#!/usr/bin/env node
/**
 * 需求分析 CLI：初始化、估时、校验、汇总。
 *
 *   node scripts/req.mjs init --project <项目根> --title "需求标题" [--id req-...] [--source <文档>]
 *   node scripts/req.mjs estimate <requirement.json|目录> [--dry-run]
 *   node scripts/req.mjs validate <requirement.json|目录> [--json]
 *   node scripts/req.mjs summary --project <项目根> [--json]
 *
 * 只读写 <项目根>/.requirements/；不碰业务代码、不连库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CATEGORIES = {
  api: '接口新增/变更',
  model: '字段与数据模型',
  schema: '表结构与迁移',
  flow: '业务流程/状态机',
  ui: '页面与交互',
  auth: '权限/角色/菜单',
  job: '定时任务/批处理',
  mq: '消息与事件',
  integration: '外部集成',
  config: '配置/参数/字典',
  query: '报表/查询/导出',
  nfr: '非功能（性能/审计/兼容）',
};

export const DOMAINS = {
  cust: '客户与建档',
  product: '产品与开通',
  limit: '额度',
  asset: '资产与凭证开立',
  trade: '凭证流转与融资',
  abolish: '凭证作废',
  repay: '兑付与结清',
  query: '查询与统计',
  report: '监管报送',
  notify: '通知与预警',
  channel: '渠道与集成',
  platform: '平台与配置',
};

export const ACTIONS = ['add', 'modify', 'remove'];
export const KINDS = ['http', 'dubbo', 'job', 'mq', 'feign', 'table', 'model', 'config', 'ui', 'class'];
export const CONFIDENCE = ['verified', 'inferred', 'unresolved'];
export const LAYERS = ['controller', 'service', 'provider', 'mapper', 'entity', 'dto', 'job', 'listener', 'config', 'other'];
export const SEVERITIES = ['P0', 'P1', 'P2'];
export const STATUSES = ['draft', 'analyzed', 'confirmed'];
export const SOURCE_KINDS = ['document', 'image', 'api', 'table', 'attachment', 'other'];
export const EXCLUDE_REASONS = ['struck', 'next-version', 'cancelled', 'out-of-scope', 'no-anchor', 'other'];
export const DIAGRAM_KINDS = ['flow', 'sequence', 'state', 'ui', 'arch', 'other'];
export const ID_PATTERN = /^req-(v\d+(?:\.\d+)*|\d{8})-[a-z0-9][a-z0-9-]*$/;
export const BUFFER_RANGE = [1.2, 2.0];
const DAY = 0.25;

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const has = (name) => args.includes(`--${name}`);

const roundUp = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil((n - 1e-9) / DAY) * DAY;
};
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

/** 由 parts / factors / buffer 计算 p50 / p90（对外导出，便于自测）。 */
export function computeEstimate(estimate) {
  const parts = Array.isArray(estimate?.parts) ? estimate.parts : [];
  const factors = Array.isArray(estimate?.factors) ? estimate.factors : [];
  const base = parts.reduce((sum, part) => sum + Number(part?.days ?? 0), 0);
  const factor = factors.reduce((product, item) => product * Number(item?.multiplier ?? 1), 1);
  const buffer = Number(estimate?.buffer ?? 1.5);
  const p50 = roundUp(base * factor);
  const p90 = roundUp(p50 * buffer);
  return { base: round2(base), factor: round2(factor), buffer, p50, p90 };
}

/** 汇总：子需求 p50/p90 求和；byCategory / byDomain 只统计 p50。 */
export function sumTotals(doc) {
  const byCategory = {};
  const byDomain = {};
  let p50 = 0;
  let p90 = 0;
  for (const item of doc?.subRequirements ?? []) {
    const est = item?.estimate ?? {};
    const value50 = Number(est.p50 ?? 0);
    const value90 = Number(est.p90 ?? 0);
    p50 += value50;
    p90 += value90;
    const category = item?.category ?? 'unknown';
    byCategory[category] = round2((byCategory[category] ?? 0) + value50);
    const domain = item?.domain ?? 'unknown';
    byDomain[domain] = round2((byDomain[domain] ?? 0) + value50);
  }
  return { p50: round2(p50), p90: round2(p90), byCategory, byDomain };
}

/** 依赖环检测；返回环上的 id 列表（无环返回空数组）。 */
export function detectCycles(subRequirements) {
  const graph = new Map();
  for (const item of subRequirements ?? []) {
    graph.set(item?.id, Array.isArray(item?.dependsOn) ? item.dependsOn : []);
  }
  const visiting = new Set();
  const visited = new Set();
  const cycle = [];
  const walk = (id, trail) => {
    if (cycle.length > 0) return;
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      cycle.push(...trail.slice(start < 0 ? 0 : start), id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) continue;
      walk(next, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) walk(id, []);
  return cycle;
}

const push = (list, message) => list.push(message);
const inEnum = (value, allowed) => allowed.includes(value);

/** 校验一份 requirement.json；返回 problems（必须修）与 warnings（建议修）。 */
export function validateRequirement(doc) {
  const problems = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { problems: ['不是合法的 JSON 对象'], warnings };

  for (const key of ['id', 'title', 'project']) {
    if (typeof doc[key] !== 'string' || doc[key].trim() === '') push(problems, `缺少必填字段 ${key}`);
  }
  if (typeof doc.id === 'string' && doc.id !== '' && !ID_PATTERN.test(doc.id)) {
    push(problems, `id 必须形如 req-v3.0.0-<短名>（版本命名）或 req-<yyyymmdd>-<短名>：${doc.id}`);
  }
  if (!inEnum(doc.status, STATUSES)) push(problems, `status 必须是 ${STATUSES.join(' / ')}`);
  if (!doc.receivedAt) push(warnings, 'receivedAt 为空：不知道需求是哪天收到的');

  const sources = Array.isArray(doc.sources) ? doc.sources : [];
  if (sources.length === 0) push(problems, 'sources 为空：正文 / 图片 / 附件至少登记一条');
  const sourceIds = new Set();
  let hasDocument = false;
  for (const source of sources) {
    const label = source?.id ?? '<无 id>';
    if (typeof source?.id !== 'string' || !/^SRC-\d+$/.test(source.id)) push(problems, `${label}: 来源 id 必须是 SRC-<数字>`);
    if (sourceIds.has(source?.id)) push(problems, `${label}: 来源 id 重复`);
    sourceIds.add(source?.id);
    if (!inEnum(source?.kind, SOURCE_KINDS)) push(problems, `${label}: 来源 kind 必须是 ${SOURCE_KINDS.join(' / ')}`);
    if (!source?.file) push(problems, `${label}: 来源缺少 file`);
    if (source?.kind === 'document') hasDocument = true;
  }
  if (sources.length > 0 && !hasDocument) push(warnings, '没有 kind: document 的来源：确认是否漏登记正文');

  const subRequirements = Array.isArray(doc.subRequirements) ? doc.subRequirements : [];
  if (subRequirements.length === 0) push(problems, 'subRequirements 为空：至少拆出一条子需求');

  const srIds = new Set();
  const questionIds = new Set((doc.questions ?? []).map((item) => item?.id));
  for (const item of subRequirements) {
    const label = item?.id ?? '<无 id>';
    if (typeof item?.id !== 'string' || !/^SR-\d+$/.test(item.id)) push(problems, `${label}: 子需求 id 必须是 SR-<数字>`);
    if (srIds.has(item?.id)) push(problems, `${label}: 子需求 id 重复`);
    srIds.add(item?.id);
    if (!item?.title) push(problems, `${label}: 缺少 title`);
    if (!inEnum(item?.category, Object.keys(CATEGORIES))) push(problems, `${label}: category 不在 12 类枚举内（${item?.category}）`);
    for (const extra of item?.secondary ?? []) {
      if (!inEnum(extra, Object.keys(CATEGORIES))) push(problems, `${label}: secondary 含未知大类 ${extra}`);
    }
    if (!inEnum(item?.action, ACTIONS)) push(problems, `${label}: action 必须是 ${ACTIONS.join(' / ')}`);
    if (!inEnum(item?.domain, Object.keys(DOMAINS))) push(problems, `${label}: domain 不在 12 个业务域内（${item?.domain}）`);
    for (const extra of item?.secondaryDomains ?? []) {
      if (!inEnum(extra, Object.keys(DOMAINS))) push(problems, `${label}: secondaryDomains 含未知业务域 ${extra}`);
    }
    if ((item?.secondaryDomains ?? []).length > 2) push(problems, `${label}: secondaryDomains 最多 2 个`);
    if (item?.domain === 'platform' || item?.domain === 'channel') {
      push(warnings, `${label}: 业务域 ${item.domain} 容易变成兜底分类，确认不是没想清业务归属`);
    }
    if (!item?.quote || String(item.quote).trim() === '') push(problems, `${label}: 缺少原文引用 quote（没有引用的子需求不算需求）`);
    if (item?.sourceId) {
      if (!sourceIds.has(item.sourceId)) push(problems, `${label}: sourceId 指向不存在的来源 ${item.sourceId}`);
    } else {
      push(warnings, `${label}: 未填 sourceId，无法追溯到具体来源（正文 / 图 / 附件）`);
    }

    const points = Array.isArray(item?.changePoints) ? item.changePoints : [];
    if (points.length === 0) push(problems, `${label}: changePoints 为空，至少给一个改动点`);
    for (const point of points) {
      if (!inEnum(point?.kind, KINDS)) push(problems, `${label}: 改动点 kind 非法（${point?.kind}）`);
      if (!point?.file) push(problems, `${label}: 改动点缺少 file`);
      if (!Number.isInteger(point?.line) || point.line < 1) push(problems, `${label}: 改动点 line 必须是正整数`);
      if (!inEnum(point?.confidence, CONFIDENCE)) push(problems, `${label}: 改动点 confidence 非法（${point?.confidence}）`);
    }

    for (const code of item?.newCode ?? []) {
      if (!inEnum(code?.layer, LAYERS)) push(problems, `${label}: newCode.layer 非法（${code?.layer}）`);
      if (!code?.className) push(problems, `${label}: newCode 缺少 className`);
      if (!code?.package) push(problems, `${label}: newCode 缺少 package`);
      if (!code?.reason) push(problems, `${label}: newCode 缺少 reason`);
    }

    const estimate = item?.estimate;
    if (!estimate || !Array.isArray(estimate.parts) || estimate.parts.length === 0) {
      push(problems, `${label}: estimate.parts 为空，估时必须有分解`);
    } else {
      for (const part of estimate.parts) {
        if (!part?.name) push(warnings, `${label}: estimate.parts 有一项缺少 name`);
        if (!isPositive(part?.days)) push(problems, `${label}: estimate.parts「${part?.name ?? '?'}」的 days 必须大于 0`);
      }
      if (estimate.parts.length < 2) push(warnings, `${label}: 估时只有一项，缺少自测/联调分解`);
      for (const factor of estimate.factors ?? []) {
        if (!isPositive(factor?.multiplier)) push(problems, `${label}: factor「${factor?.name ?? '?'}」的 multiplier 必须大于 0`);
      }
      const buffer = Number(estimate.buffer ?? 1.5);
      if (buffer < BUFFER_RANGE[0] || buffer > BUFFER_RANGE[1]) push(problems, `${label}: buffer 必须在 ${BUFFER_RANGE[0]}–${BUFFER_RANGE[1]} 之间（当前 ${buffer}）`);
      const computed = computeEstimate(estimate);
      if (Math.abs(computed.p50 - Number(estimate.p50 ?? 0)) > 0.26 || Math.abs(computed.p90 - Number(estimate.p90 ?? 0)) > 0.26) {
        push(problems, `${label}: p50/p90 与分解不一致，先跑 req.mjs estimate`);
      }
    }

    const inferred = points.filter((point) => point?.confidence !== 'verified');
    const linkedQuestions = (doc.questions ?? []).filter((q) => (q?.affects ?? []).includes(item?.id) && !q?.resolved);
    if (inferred.length > 0 && linkedQuestions.length === 0) {
      push(warnings, `${label}: 有 ${inferred.length} 个非 verified 改动点，但没有关联的待澄清问题`);
    }
    for (const questionId of item?.openQuestions ?? []) {
      if (!questionIds.has(questionId)) push(problems, `${label}: openQuestions 引用了不存在的问题 ${questionId}`);
    }
    for (const dep of item?.dependsOn ?? []) {
      if (!subRequirements.some((candidate) => candidate?.id === dep)) push(problems, `${label}: dependsOn 引用了不存在的子需求 ${dep}`);
    }
  }

  const usedSources = new Set(subRequirements.map((item) => item?.sourceId).filter(Boolean));
  for (const id of sourceIds) {
    if (!usedSources.has(id)) push(warnings, `来源 ${id} 没有被任何子需求引用：确认是否漏读，或在 analysis §8 说明不用`);
  }

  const cycle = detectCycles(subRequirements);
  if (cycle.length > 0) push(problems, `dependsOn 存在环：${cycle.join(' → ')}`);

  for (const question of doc.questions ?? []) {
    const label = question?.id ?? '<无 id>';
    if (typeof question?.id !== 'string' || !/^Q-\d+$/.test(question.id)) push(problems, `${label}: 问题 id 必须是 Q-<数字>`);
    if (!inEnum(question?.severity, SEVERITIES)) push(problems, `${label}: severity 必须是 P0 / P1 / P2`);
    if (!question?.question) push(problems, `${label}: 缺少 question`);
    if (question?.severity === 'P0') {
      if (!question?.assumption) push(problems, `${label}: P0 必须给建议默认值 assumption`);
      if (!question?.owner) push(problems, `${label}: P0 必须写找谁确认 owner`);
    }
    for (const srId of question?.affects ?? []) {
      if (!srIds.has(srId)) push(problems, `${label}: affects 引用了不存在的子需求 ${srId}`);
    }
  }

  const openP0 = (doc.questions ?? []).filter((q) => q?.severity === 'P0' && !q?.resolved);
  if (openP0.length > 0 && doc.status !== 'draft') {
    push(problems, `还有 ${openP0.length} 条未解决的 P0，status 只能保持 draft`);
  }

  const diagrams = Array.isArray(doc.diagrams) ? doc.diagrams : [];
  const dgIds = new Set();
  const dgSources = new Set();
  for (const item of diagrams) {
    const label = item?.id ?? '<无 id>';
    if (typeof item?.id !== 'string' || !/^DG-\d+$/.test(item.id)) push(problems, `${label}: 图 id 必须是 DG-<数字>`);
    if (dgIds.has(item?.id)) push(problems, `${label}: 图 id 重复`);
    dgIds.add(item?.id);
    if (!item?.title) push(problems, `${label}: 图缺少 title`);
    if (!inEnum(item?.kind, DIAGRAM_KINDS)) push(problems, `${label}: kind 必须是 ${DIAGRAM_KINDS.join(' / ')}`);
    if (!item?.sourceId) push(problems, `${label}: 图未记 sourceId`);
    else if (!sourceIds.has(item.sourceId)) push(problems, `${label}: sourceId 指向不存在的来源 ${item.sourceId}`);
    else dgSources.add(item.sourceId);
    if (!inEnum(item?.confidence, CONFIDENCE)) push(problems, `${label}: confidence 非法（${item?.confidence}）`);
    const nodes = Array.isArray(item?.nodes) ? item.nodes : [];
    if (nodes.length === 0) push(problems, `${label}: nodes 为空——流程图必须落成节点，不能只登记图`);
    for (const node of nodes) {
      if (!node?.action) push(warnings, `${label}: 有节点缺少 action`);
      if (node?.branch === undefined && node?.seq === undefined) push(warnings, `${label}: 有节点既无 seq 也无 branch`);
    }
    if (item?.confidence === 'unresolved' && !(item?.note ?? '').includes('未识别')) {
      push(warnings, `${label}: 标了 unresolved，note 里要写明识别不了的部分`);
    }
  }
  for (const source of sources) {
    if (source?.kind !== 'image') continue;
    if (!dgSources.has(source.id)) {
      push(warnings, `图片来源 ${source.id} 没有对应 diagrams 条目：流程图/原型图必须做图片识别`);
    }
  }
  const excluded = Array.isArray(doc.excluded) ? doc.excluded : [];
  const exIds = new Set();
  for (const item of excluded) {
    const label = item?.id ?? '<无 id>';
    if (typeof item?.id !== 'string' || !/^EX-\d+$/.test(item.id)) push(problems, `${label}: 排除项 id 必须是 EX-<数字>`);
    if (exIds.has(item?.id)) push(problems, `${label}: 排除项 id 重复`);
    exIds.add(item?.id);
    if (!item?.label) push(problems, `${label}: 排除项缺少 label（一句话说明排除了什么）`);
    if (!inEnum(item?.reason, EXCLUDE_REASONS)) push(problems, `${label}: reason 必须是 ${EXCLUDE_REASONS.join(' / ')}`);
    if (!item?.sourceId) push(warnings, `${label}: 排除项未记 sourceId，无法回溯是哪份材料`);
    else if (!sourceIds.has(item.sourceId)) push(problems, `${label}: 排除项 sourceId 指向不存在的来源 ${item.sourceId}`);
  }

  const expected = sumTotals(doc);
  const totals = doc.totals ?? {};
  for (const key of ['p50', 'p90']) {
    if (Math.abs(Number(totals[key] ?? 0) - expected[key]) > 0.26) {
      push(problems, `totals.${key} 与子需求求和不一致，先跑 req.mjs estimate`);
    }
  }
  for (const [category, value] of Object.entries(expected.byCategory)) {
    if (Math.abs(Number(totals.byCategory?.[category] ?? 0) - value) > 0.26) {
      push(problems, `totals.byCategory.${category} 与子需求求和不一致，先跑 req.mjs estimate`);
    }
  }
  for (const [domain, value] of Object.entries(expected.byDomain)) {
    if (Math.abs(Number(totals.byDomain?.[domain] ?? 0) - value) > 0.26) {
      push(problems, `totals.byDomain.${domain} 与子需求求和不一致，先跑 req.mjs estimate`);
    }
  }

  return { problems, warnings };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function resolveRequirement(input, project) {
  if (!input) throw new Error('缺少 requirement.json 路径或需求 id');
  const candidates = [];
  if (input.endsWith('.json')) candidates.push(path.resolve(input));
  else {
    candidates.push(path.resolve(input, 'requirement.json'), path.resolve(input));
    if (project) candidates.push(path.resolve(project, '.requirements', input, 'requirement.json'));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error(`找不到需求文件：${input}（试过 ${candidates.join('、')}）`);
  return found;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nextId(project, version = '', slug = '') {
  const dir = path.join(project, '.requirements');
  if (version && slug) {
    const base = `req-v${version.replace(/^v/i, '')}-${slug}`;
    const used = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(base)).length : 0;
    return used === 0 ? base : `${base}-${used + 1}`;
  }
  const base = `req-${today().replaceAll('-', '')}`;
  const used = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.startsWith(base)).length
    : 0;
  return `${base}-${String(used + 1).padStart(2, '0')}`;
}

function cmdInit() {
  const project = flag('project', '');
  const title = flag('title', '');
  if (!project || !title) throw new Error('init 需要 --project 和 --title');
  const projectRoot = path.resolve(project);
  if (!fs.existsSync(projectRoot)) throw new Error(`项目根不存在：${projectRoot}`);
  const version = flag('version', '').replace(/^v/i, '');
  const slug = flag('slug', '');
  if (version && !/^\d+(\.\d+)*$/.test(version)) throw new Error(`--version 应为 3.0.0 这种点分版本：${version}`);
  if (version && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('给了 --version 时必须给 --slug（小写字母数字与短横线，如 jasolar-saas）');
  const id = flag('id', '') || nextId(projectRoot, version, slug);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`需求 id 应形如 req-v3.0.0-<短名>（版本命名，推荐）或 req-<yyyymmdd>-<短名>：${id}`);
  }
  const dir = path.join(projectRoot, '.requirements', id);
  const file = path.join(dir, 'requirement.json');
  if (fs.existsSync(file) && !has('force')) throw new Error(`已存在：${file}（要覆盖加 --force）`);

  const now = new Date().toISOString();
  const sourceFile = flag('source', '');
  const doc = {
    schema: 2,
    id,
    version: version || '',
    title,
    project: path.basename(projectRoot),
    status: 'draft',
    receivedAt: today(),
    sources: [
      {
        id: 'SRC-1',
        file: sourceFile,
        kind: 'document',
        locator: '',
        note: '主文档；图片与附件请补成 SRC-2、SRC-3…',
      },
    ],
    subRequirements: [],
    questions: [],
    totals: { p50: 0, p90: 0, byCategory: {} },
    generatedAt: now,
    updatedAt: now,
  };
  writeJson(file, doc);
  console.log(JSON.stringify({ ok: true, file, next: '填 subRequirements 后跑 estimate 与 validate' }, null, 2));
}

function loadDoc(input) {
  const file = resolveRequirement(input, flag('project', ''));
  return { file, doc: readJson(file) };
}

function cmdEstimate() {
  const { file, doc } = loadDoc(args[1]);
  const now = new Date().toISOString();
  const rows = [];
  for (const item of doc.subRequirements ?? []) {
    const estimate = item.estimate ?? {};
    const computed = computeEstimate(estimate);
    item.estimate = { ...estimate, buffer: Number(estimate.buffer ?? 1.5), p50: computed.p50, p90: computed.p90 };
    rows.push({ id: item.id, title: item.title, p50: computed.p50, p90: computed.p90 });
  }
  doc.totals = sumTotals(doc);
  doc.updatedAt = now;
  if (!has('dry-run')) writeJson(file, doc);

  console.log(`需求：${doc.title}（${doc.id}）`);
  console.log('子需求\tP50\tP90\t标题');
  for (const row of rows) console.log(`${row.id}\t${row.p50}\t${row.p90}\t${row.title ?? ''}`);
  console.log(`合计\t${doc.totals.p50}\t${doc.totals.p90}`);
  const categories = Object.entries(doc.totals.byCategory ?? {});
  if (categories.length > 0) console.log(`按大类：${categories.map(([key, value]) => `${key}=${value}`).join('，')}`);
  const domains = Object.entries(doc.totals.byDomain ?? {});
  if (domains.length > 0) {
    console.log(`按业务域：${domains.map(([key, value]) => `${DOMAINS[key] ?? key}=${value}`).join('，')}`);
  }
  if (has('dry-run')) console.log('（--dry-run：未写回文件）');
}

function cmdValidate() {
  const { file, doc } = loadDoc(args[1]);
  const { problems, warnings } = validateRequirement(doc);
  const report = { file, ok: problems.length === 0, problems, warnings };
  if (has('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`校验：${file}`);
    console.log(`问题 ${problems.length} 条，警告 ${warnings.length} 条`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
    console.log(problems.length === 0 ? '通过' : '未通过');
  }
  if (problems.length > 0) process.exitCode = 1;
}

function cmdSummary() {
  const project = flag('project', '');
  if (!project) throw new Error('summary 需要 --project');
  const dir = path.join(path.resolve(project), '.requirements');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .map((name) => path.join(dir, name, 'requirement.json'))
        .filter((file) => fs.existsSync(file))
    : [];
  const docs = files.map((file) => ({ file, doc: readJson(file) }));
  const rows = docs.map(({ doc }) => {
    const open = (doc.questions ?? []).filter((q) => q?.severity === 'P0' && !q?.resolved).length;
    return {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      subRequirements: (doc.subRequirements ?? []).length,
      p50: doc.totals?.p50 ?? 0,
      p90: doc.totals?.p90 ?? 0,
      openP0: open,
      excluded: (doc.excluded ?? []).length,
      byDomain: doc.totals?.byDomain ?? {},
    };
  });
  if (has('json')) {
    console.log(JSON.stringify({ ok: true, project, requirements: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`没有需求：${dir}`);
    return;
  }
  console.log('需求\t状态\t子需求\tP50\tP90\tP0\t标题');
  for (const row of rows) console.log(`${row.id}\t${row.status}\t${row.subRequirements}\t${row.p50}\t${row.p90}\t${row.openP0}\t${row.title}`);
  const domainTotals = {};
  for (const row of rows) {
    for (const [domain, value] of Object.entries(row.byDomain)) {
      domainTotals[domain] = round2((domainTotals[domain] ?? 0) + Number(value ?? 0));
    }
  }
  const domains = Object.entries(domainTotals);
  if (domains.length > 0) {
    console.log(`业务域合计：${domains.map(([key, value]) => `${DOMAINS[key] ?? key}=${value}`).join('，')}`);
  }
  const reasons = {};
  for (const { doc } of docs) {
    for (const item of doc.excluded ?? []) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  }
  const reasonText = Object.entries(reasons).map(([key, value]) => `${key}=${value}`).join('，');
  if (reasonText) console.log(`排除项：${Object.values(reasons).reduce((a, b) => a + b, 0)} 条（${reasonText}）`);
}

function usage() {
  console.log(`用法：node scripts/req.mjs <init|estimate|validate|summary> [选项]

  init      新建需求目录与 requirement.json 骨架
    --project <dir>   项目根（必填）
    --title "标题"     需求标题（必填）
    --version 3.0.0   版本号 → id 为 req-v3.0.0-<slug>（推荐，按版本命名）
    --slug jasolar-saas  版本命名时的短名（与 --version 同时使用）
    --id req-...      直接指定 id（版本命名或 req-<yyyymmdd>-<短名>）
    --source <file>   主文档路径，写入 sources[0]；图片与附件再补 SRC-2、SRC-3…
    --force           覆盖已存在的需求文件

  estimate  按 parts / factors / buffer 重算 p50 / p90 与 totals
    --dry-run         只打印，不写回
    --project <dir>   用需求 id 定位时可给项目根

  validate  校验结构、枚举、锚点、估时一致性与 P0 闸门
    --json            机器可读输出

  summary   汇总项目下所有需求
    --project <dir>   项目根（必填）
    --json            机器可读输出`);
}

function main() {
  if (command === 'init') return cmdInit();
  if (command === 'estimate') return cmdEstimate();
  if (command === 'validate') return cmdValidate();
  if (command === 'summary') return cmdSummary();
  usage();
  if (command !== 'help' && command !== '--help') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
