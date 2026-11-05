#!/usr/bin/env node
/**
 * tour.mjs —— 把多仓库 Java 项目扫成 `.knowledge/` 索引，供后续技能快速定位代码。
 *
 * 设计原则：
 *   1. 脚本负责广度（确定性抽取），模型负责深度（流程叙述、仓库职责）；
 *   2. 每条记录都带 `path:line`，能被回读校验；
 *   3. 核心（core）标记是持久资产：后续技能先读 core，再查全量索引。
 *
 * 用法：
 *   node tour.mjs scan            [--project <dir>] [--repos a,b]
 *   node tour.mjs inventory|entries|data|flows
 *   node tour.mjs find <关键词>    [--kind http|dubbo|job|mq|feign|flow|table] [--limit N] [--json]
 *   node tour.mjs where "<改动意图>" [--limit N] [--json]
 *   node tour.mjs context <path>  [--json]
 *   node tour.mjs core mark|unmark|list|brief [--flow id] [--class path] [--table name] [--reason ...] [--by ...]
 *   node tour.mjs status
 *
 * 退出码：0 成功；1 参数或运行错误；2 查询无结果。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const KNOWLEDGE = '.knowledge';
const SKIP_DIRS = new Set([
  '.git', '.idea', '.knowledge', 'node_modules', 'target', 'build', 'out', '.cache',
  '.env-prep', '.dev-standards', '.mvn', '.gradle',
]);

// ---------------------------------------------------------------- 基础工具

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function relOf(projectRoot, file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function nowIso() {
  return new Date().toISOString();
}

/** 行号查询：一次建表，O(log n) 取行。 */
class LineIndex {
  constructor(text) {
    this.starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
    this.lines = text.split('\n');
  }

  line(idx) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

function walk(dir, options = {}) {
  const { skip = SKIP_DIRS, match = () => true } = options;
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile() && match(full)) found.push(full);
    }
  }
  return found;
}

/** 不 spawn git：直接读 .git/HEAD，支持 worktree 的 gitdir 指针。 */
function gitHead(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  let gitDir = dotGit;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+)/);
      if (!pointer) return null;
      gitDir = path.resolve(repoDir, pointer[1].trim());
    }
  } catch {
    return null;
  }
  try {
    let head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    const ref = head.slice(4).trim();
    const refFile = path.join(gitDir, ref.split('/').join(path.sep));
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 12);
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref) return sha.slice(0, 12);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function layerOf(relPath) {
  const p = relPath.toLowerCase();
  if (p.includes('/src/test/') || p.startsWith('src/test/')) return 'test';
  if (p.endsWith('.xml')) return 'mapper';
  if (/(^|\/)(web|controller|controller[s]?)\//.test(p)) return 'web';
  if (/(^|\/)(service|services|facade|facade-impl)\//.test(p)) return 'service';
  if (/(^|\/)(provider|providers)\//.test(p)) return 'provider';
  if (/(^|\/)(api|dto|vo|param)\//.test(p)) return 'api';
  if (/(^|\/)(entity|domain|model|po|dataobject)\//.test(p)) return 'entity';
  if (/(^|\/)(mapper|dao)\//.test(p)) return 'dao';
  if (/(^|\/)(job|task|handler)\//.test(p)) return 'job';
  return 'lib';
}

// ---------------------------------------------------------------- 仓库与 pom

function listRepos(projectRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
    .filter((entry) => (
      fs.existsSync(path.join(projectRoot, entry.name, 'pom.xml'))
      || fs.existsSync(path.join(projectRoot, entry.name, '.git'))
    ))
    .map((entry) => entry.name)
    .sort();
}

function parsePom(text) {
  const first = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const artifactId = first(/<artifactId>([^<]+)<\/artifactId>/);
  const packaging = first(/<packaging>([^<]+)<\/packaging>/) || 'jar';
  const name = first(/<name>([^<]+)<\/name>/);
  const modules = [...text.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1].trim());
  const deps = [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map((m) => {
    const block = m[1];
    const groupId = (block.match(/<groupId>([^<]+)</) ?? [])[1] ?? '';
    const art = (block.match(/<artifactId>([^<]+)</) ?? [])[1] ?? '';
    const scope = (block.match(/<scope>([^<]+)</) ?? [])[1] ?? 'compile';
    const optional = /<optional>true</.test(block);
    return { groupId: groupId.trim(), artifactId: art.trim(), scope: scope.trim(), optional };
  }).filter((dep) => dep.artifactId);
  const tech = {
    springBoot: (text.match(/spring-boot[^<]*<\/artifactId>\s*<version>([^<]+)</) ?? [])[1] ?? '',
    dubbo: /dubbo/i.test(text),
    mybatis: /mybatis/i.test(text),
    mq: /rabbitmq|rocketmq|kafka/i.test(text),
  };
  return { artifactId, packaging, name, modules, deps, tech };
}

function buildInventory(projectRoot, repos) {
  const items = [];
  const repoSet = new Set(repos);
  for (const repo of repos) {
    const repoDir = path.join(projectRoot, repo);
    const pomFile = path.join(repoDir, 'pom.xml');
    let pom = { artifactId: repo, packaging: 'jar', name: '', modules: [], deps: [], tech: {} };
    if (fs.existsSync(pomFile)) {
      try {
        pom = parsePom(fs.readFileSync(pomFile, 'utf8'));
      } catch {
        /* 保留缺省值 */
      }
    }
    const javaFiles = walk(repoDir, { match: (f) => f.endsWith('.java') });
    const layers = {};
    for (const file of javaFiles) {
      const layer = layerOf(relOf(projectRoot, file));
      layers[layer] = (layers[layer] ?? 0) + 1;
    }
    const crossDeps = pom.deps
      .filter((dep) => repoSet.has(dep.artifactId))
      .map((dep) => ({ to: dep.artifactId, scope: dep.scope }));
    items.push({
      name: repo,
      path: repo,
      artifactId: pom.artifactId || repo,
      packaging: pom.packaging,
      displayName: pom.name,
      modules: pom.modules,
      tech: pom.tech,
      deps: pom.deps.length,
      crossDeps,
      javaFiles: javaFiles.length,
      layers,
      head: gitHead(repoDir),
    });
  }
  const crossRepoDeps = items.flatMap((repo) => repo.crossDeps.map((dep) => ({
    from: repo.name, to: dep.to, scope: dep.scope,
  })));
  return { generatedAt: nowIso(), version: VERSION, repos: items, crossRepoDeps };
}

// ---------------------------------------------------------------- Java 抽取

const MAPPING_RE = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b\s*(?:\(([^)]*)\))?/g;
const MAPPING_KIND = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY',
};

function firstString(args) {
  if (!args) return '';
  const quoted = args.match(/["']([^"']*)["']/);
  if (quoted) return quoted[1];
  const value = args.match(/value\s*=\s*\{?\s*["']([^"']*)["']/);
  return value ? value[1] : '';
}

function joinPath(base, child) {
  const parts = [base, child].filter((p) => typeof p === 'string' && p !== '' && p !== '/');
  if (parts.length === 0) return '/';
  return `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

function methodAfterLine(lines, fromLine, limit = 10) {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + limit); i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('@') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (!line.includes('(')) continue;
    if (/\b(class|interface|enum|record)\b/.test(line)) return '';
    const m = line.match(/([A-Za-z_$][\w$]*)\s*\(/);
    if (m) return m[1];
  }
  return '';
}

function scanJavaFile(file, projectRoot, repo, classIndex) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rel = relOf(projectRoot, file);
  const lines = text.split('\n');
  const idx = new LineIndex(text);
  const pkg = (text.match(/^\s*package\s+([\w.]+)\s*;/m) ?? [])[1] ?? '';
  const classMatch = text.match(/\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/);
  const classDecl = classMatch ? { kind: classMatch[1], name: classMatch[2], line: idx.line(classMatch.index) } : null;
  const layer = layerOf(rel);

  if (classDecl && pkg) {
    const fqn = `${pkg}.${classDecl.name}`;
    if (!classIndex.has(fqn)) classIndex.set(fqn, { path: rel, line: classDecl.line });
  }

  const record = { path: rel, repo, package: pkg, class: classDecl, layer, http: [], dubbo: [], jobs: [], mq: [], feign: [], tableName: '' };

  // HTTP：类级 base path 取 class 声明之前最后一个 @RequestMapping
  const classIdx = classMatch ? classMatch.index : 0;
  let base = '';
  for (const m of text.matchAll(MAPPING_RE)) {
    if (m.index < classIdx && m[1] === 'RequestMapping') base = firstString(m[2]);
  }
  for (const m of text.matchAll(MAPPING_RE)) {
    if (m.index < classIdx) continue;
    const kind = MAPPING_KIND[m[1]] ?? 'ANY';
    const route = joinPath(base, firstString(m[2]));
    const line = idx.line(m.index);
    const method = methodAfterLine(lines, line, 6);
    record.http.push({ method: kind, route, line, symbol: method });
  }

  // Dubbo / Feign / MQ / Job / 表名
  if (/@DubboService\b|org\.apache\.dubbo\.config\.annotation\.Service/.test(text)) {
    const iface = (text.match(/implements\s+([\w.,\s<>]+?)\s*\{/) ?? [])[1] ?? '';
    record.dubbo.push({ iface: iface.split(',').map((s) => s.trim()).filter(Boolean), line: classDecl ? classDecl.line : 1 });
  }
  for (const m of text.matchAll(/@XxlJob\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/g)) {
    record.jobs.push({ name: m[1], line: idx.line(m.index), symbol: methodAfterLine(lines, idx.line(m.index), 6) });
  }
  for (const m of text.matchAll(/@RabbitListener\s*\(([^)]*)\)/g)) {
    record.mq.push({ kind: 'rabbit', target: firstString(m[1]), line: idx.line(m.index) });
  }
  for (const m of text.matchAll(/@KafkaListener\s*\(([^)]*)\)/g)) {
    record.mq.push({ kind: 'kafka', target: firstString(m[1]), line: idx.line(m.index) });
  }
  for (const m of text.matchAll(/@FeignClient\s*\(([^)]*)\)/g)) {
    const args = m[1];
    const name = (args.match(/(?:value|name)\s*=\s*["']([^"']+)["']/) ?? [])[1] ?? '';
    const basePath = (args.match(/path\s*=\s*["']([^"']*)["']/) ?? [])[1] ?? '';
    record.feign.push({ name, path: basePath, line: idx.line(m.index) });
  }
  const tableName = text.match(/@TableName\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/);
  if (tableName) record.tableName = tableName[1];

  return record;
}

function buildEntries(projectRoot, repos) {
  const items = [];
  const classIndex = new Map();
  const records = [];
  for (const repo of repos) {
    const files = walk(path.join(projectRoot, repo), {
      match: (f) => f.endsWith('.java') && !f.includes(`${path.sep}src${path.sep}test${path.sep}`),
    });
    for (const file of files) {
      const record = scanJavaFile(file, projectRoot, repo, classIndex);
      if (record) records.push(record);
    }
  }
  for (const record of records) {
    for (const route of record.http) {
      items.push({
        id: `http:${route.method} ${route.route}`,
        kind: 'http',
        repo: record.repo,
        path: record.path,
        line: route.line,
        symbol: record.class ? `${record.class.name}#${route.symbol || '?'}` : route.symbol,
        route: `${route.method} ${route.route}`,
        layer: record.layer,
        confidence: 'verified',
        evidence: [`@${route.method === 'ANY' ? 'RequestMapping' : `${route.method[0]}${route.method.slice(1).toLowerCase()}Mapping`}`],
      });
    }
    for (const dubbo of record.dubbo) {
      for (const iface of dubbo.iface) {
        items.push({
          id: `dubbo:${iface}`,
          kind: 'dubbo',
          repo: record.repo,
          path: record.path,
          line: dubbo.line,
          symbol: `${record.class ? record.class.name : '?'} implements ${iface}`,
          route: iface,
          layer: record.layer,
          confidence: 'verified',
          evidence: ['@DubboService'],
        });
      }
    }
    for (const job of record.jobs) {
      items.push({
        id: `job:${job.name}`,
        kind: 'job',
        repo: record.repo,
        path: record.path,
        line: job.line,
        symbol: record.class ? `${record.class.name}#${job.symbol || '?'}` : job.symbol,
        route: job.name,
        layer: record.layer,
        confidence: 'verified',
        evidence: ['@XxlJob'],
      });
    }
    for (const mq of record.mq) {
      items.push({
        id: `mq:${mq.kind}:${mq.target}`,
        kind: 'mq',
        repo: record.repo,
        path: record.path,
        line: mq.line,
        symbol: record.class ? record.class.name : '?',
        route: mq.target,
        layer: record.layer,
        confidence: 'verified',
        evidence: [mq.kind === 'rabbit' ? '@RabbitListener' : '@KafkaListener'],
      });
    }
    for (const feign of record.feign) {
      items.push({
        id: `feign:${feign.name}${feign.path}`,
        kind: 'feign',
        repo: record.repo,
        path: record.path,
        line: feign.line,
        symbol: record.class ? record.class.name : '?',
        route: `${feign.name}${feign.path}`,
        layer: record.layer,
        confidence: 'verified',
        evidence: ['@FeignClient'],
      });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { generatedAt: nowIso(), version: VERSION, items, classes: [...classIndex.entries()].map(([fqn, info]) => ({ fqn, ...info })) };
}

// ---------------------------------------------------------------- 表 / Mapper

const SQL_TABLE_RE = /\b(insert\s+into|replace\s+into|update|delete\s+from|from|join)\s+`?([A-Za-z_][\w$]*)`?/gi;

function buildData(projectRoot, repos) {
  const mappers = [];
  const tableMap = new Map();
  const bump = (name, side, ref) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return;
    const entry = tableMap.get(name) ?? { name, reads: [], writes: [] };
    entry[side].push(ref);
    tableMap.set(name, entry);
  };
  for (const repo of repos) {
    const files = walk(path.join(projectRoot, repo), { match: (f) => /Mapper\.xml$/.test(f) });
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = relOf(projectRoot, file);
      const idx = new LineIndex(text);
      const namespace = (text.match(/<mapper[^>]*namespace\s*=\s*["']([^"']+)["']/) ?? [])[1] ?? '';
      const statements = [];
      const tables = new Set();
      for (const m of text.matchAll(/<(select|insert|update|delete)\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/g)) {
        statements.push({ kind: m[1], id: m[2], line: idx.line(m.index) });
      }
      for (const m of text.matchAll(SQL_TABLE_RE)) {
        const keyword = m[1].toLowerCase();
        const name = m[2];
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue;
        tables.add(name);
        const side = /^(insert|replace|update|delete)/.test(keyword) ? 'writes' : 'reads';
        bump(name, side, { path: rel, line: idx.line(m.index), repo });
      }
      mappers.push({ path: rel, repo, namespace, tables: [...tables], statements });
    }
  }
  // 实体上的 @TableName 归属到具体表
  const entities = [];
  for (const repo of repos) {
    const files = walk(path.join(projectRoot, repo), { match: (f) => f.endsWith('.java') });
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const m = text.match(/@TableName\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/);
      if (!m) continue;
      const rel = relOf(projectRoot, file);
      const line = new LineIndex(text).line(m.index);
      entities.push({ table: m[1], path: rel, line, repo });
    }
  }
  for (const entity of entities) {
    const entry = tableMap.get(entity.table) ?? { name: entity.table, reads: [], writes: [] };
    entry.entity = { path: entity.path, line: entity.line };
    tableMap.set(entity.table, entry);
  }
  return {
    generatedAt: nowIso(),
    version: VERSION,
    mappers,
    tables: [...tableMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------- 流程

function slug(name) {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 80);
}

function scanFlowFiles(projectRoot, repos, extraDirs = [], useAuto = true) {
  // 流程定义常在某个 `procdefs/` 目录下，所以这里不能用默认 skip 集（默认集会跳过点目录）。
  // 也允许用 --procdefs 显式指定目录，避免绑定某个团队的既有布局。
  const flowSkip = new Set(['.git', '.idea', '.knowledge', 'node_modules', 'target', 'build', 'out', '.cache', '.env-prep']);
  const found = [];
  const seen = new Set();
  const push = (file, repo) => {
    if (seen.has(file)) return;
    seen.add(file);
    found.push({ file, repo });
  };
  for (const dir of extraDirs) {
    const absolute = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const file of walk(absolute, { skip: flowSkip, match: (f) => f.endsWith('.json') })) {
      push(file, relOf(projectRoot, absolute).split('/')[0] || 'external');
    }
  }
  if (!useAuto) return found;
  for (const repo of repos) {
    const files = walk(path.join(projectRoot, repo), {
      skip: flowSkip,
      match: (f) => f.endsWith('.json') && f.split(path.sep).includes('procdefs'),
    });
    for (const file of files) push(file, repo);
  }
  return found;
}

function buildFlows(projectRoot, repos, classIndex, extraDirs = [], useAuto = true) {
  const flows = [];
  const unresolved = [];
  for (const { file, repo } of scanFlowFiles(projectRoot, repos, extraDirs, useAuto)) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      unresolved.push({ kind: 'procdef', path: relOf(projectRoot, file), reason: `JSON 解析失败：${error.message}` });
      continue;
    }
    const attr = doc.attr ?? {};
    const nodes = Array.isArray(doc.nodeList) ? doc.nodeList : [];
    const links = Array.isArray(doc.linkList) ? doc.linkList : [];
    const fileName = path.basename(file, '.json');
    const versionMatch = fileName.match(/-V(\d+)$/i);
    const handlers = [];
    const subFlows = new Set();
    for (const node of nodes) {
      for (const handler of Array.isArray(node.extHandler) ? node.extHandler : []) {
        if (!handler || !handler.extHandler) continue;
        const fqn = handler.extHandler;
        const hit = classIndex.get(fqn);
        handlers.push({
          fqn,
          className: fqn.split('.').pop(),
          extName: handler.extName ?? '',
          nodeName: node.name ?? '',
          nodeType: node.type ?? '',
          path: hit ? hit.path : '',
          line: hit ? hit.line : 0,
          confidence: hit ? 'verified' : 'unresolved',
        });
      }
      for (const sub of Array.isArray(node.defaultSubProcess) ? node.defaultSubProcess : []) {
        const name = sub?.process?.procdefName;
        if (name) subFlows.add(name);
      }
    }
    flows.push({
      id: fileName,
      name: attr.name ?? fileName.replace(/-V\d+$/i, ''),
      version: versionMatch ? `V${versionMatch[1]}` : '',
      typeName: attr.typeName ?? '',
      category: attr.procdefCategoryName ?? '',
      nodes: nodes.length,
      links: links.length,
      handlers,
      subFlows: [...subFlows],
      file: relOf(projectRoot, file),
      repo,
    });
  }
  flows.sort((a, b) => a.id.localeCompare(b.id));
  return { generatedAt: nowIso(), version: VERSION, flows, unresolved };
}

function flowMarkdown(flow) {
  const lines = [];
  lines.push(`# 流程：${flow.name}${flow.version ? `（${flow.version}）` : ''}`);
  lines.push('');
  lines.push(`- 流程 ID：\`${flow.id}\``);
  if (flow.typeName) lines.push(`- 业务分类：${flow.typeName}`);
  lines.push(`- 节点 / 连线：${flow.nodes} / ${flow.links}`);
  lines.push(`- 定义文件：\`${flow.file}\``);
  lines.push('');
  lines.push('## 处理类（extHandler → 代码位置）');
  lines.push('');
  if (flow.handlers.length === 0) {
    lines.push('> 该流程没有挂 extHandler，节点动作靠流程引擎本身完成。');
  } else {
    lines.push('| 节点 | 阶段 | 处理类 | 代码位置 |');
    lines.push('| --- | --- | --- | --- |');
    for (const handler of flow.handlers) {
      const loc = handler.path ? `\`${handler.path}:${handler.line}\`` : '未解析';
      lines.push(`| ${handler.nodeName} | ${handler.extName || handler.nodeType} | ${handler.className} | ${loc} |`);
    }
  }
  if (flow.subFlows.length > 0) {
    lines.push('');
    lines.push('## 子流程');
    lines.push('');
    for (const sub of flow.subFlows) lines.push(`- ${sub}`);
  }
  lines.push('');
  lines.push('> 本节由 `tour.mjs` 生成，改动后重跑 `node tour.mjs flows` 即可刷新；业务流程说明请写在同目录的 `flows/<名称>-notes.md`，不要改本文件。');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- 数据量（可选，校验核心功能）

/** 日志 / 历史 / 审计 / 引擎类表：数据量再大也不代表业务核心。 */
const LOG_TABLE_RE = /(^|_)(log|logs|logging|his|history|trace|audit|oper|error|exception|monitor|metric|metrics|stat|stats|statistic|statistics|tmp|temp|bak|backup|archive|job|joblog|scheduler|session|access_log)(_|$)/i;
/** 工作流引擎 / 定时调度 / 系统日志表：按前缀直接排除。 */
const ENGINE_TABLE_RE = /^(act_(hi|ru|ge|re)_|qrtz_|xxl_job|sys_oper_log|sys_logininfor|sys_job|sys_log)/i;

function isLogTable(name) {
  return LOG_TABLE_RE.test(String(name ?? '')) || ENGINE_TABLE_RE.test(String(name ?? ''));
}

/** 从文件路径推业务域：`.../cloud/scf/asset/...` → `asset`，`.../lls/operation/asset/...` → `asset`。 */
function businessOfPath(filePath) {
  const parts = String(filePath ?? '').split('/');
  const idx = parts.findIndex((part) => /^(scf|bccp|lls|cloud)$/i.test(part));
  if (idx !== -1) {
    const generic = /^(com|org|cloud|scf|bccp|lls|operation|common|core|base|model|entity|api|dto|po|dao|mapper|service|provider|web|impl)$/i;
    for (let i = idx + 1; i < parts.length; i += 1) {
      if (generic.test(parts[i])) continue;
      return parts[i].toLowerCase();
    }
  }
  return '';
}

/** 表 → 功能域：优先实体所在包，其次 Mapper 所在仓库名，最后表名前缀。 */
function featureOfTable(table, knowledge) {
  const known = knowledge.data.tables.find((item) => item.name === table);
  if (known?.entity?.path) {
    const domain = businessOfPath(known.entity.path);
    if (domain) return domain;
  }
  const mapper = knowledge.data.mappers.find((item) => item.tables.includes(table));
  if (mapper?.repo) {
    const domain = mapper.repo.replace(/^jasolar-/, '').replace(/-(service|web|api|provider|component|batch|abs|spypc)$/i, '');
    if (domain) return domain.toLowerCase();
  }
  return String(table).split('_')[0].toLowerCase();
}

function expandDbEnv(env) {
  return String(env ?? '').toLowerCase();
}

/**
 * 选库：默认用测试环境（qa / test），**不要默认连研发库**——研发库常年被造数据，行数说明不了业务规模。
 * 顺序：指定环境 → test → qa → uat → 非 dev 的任意一个 → 第一个。
 */
function pickDatabase(profile, preferredEnv = 'qa') {
  const list = Array.isArray(profile?.databases) ? profile.databases : [];
  if (list.length === 0) return null;
  const wanted = expandDbEnv(preferredEnv || 'qa');
  const byEnv = (env) => list.find((db) => expandDbEnv(db.env) === env)
    ?? list.find((db) => expandDbEnv(db.env).includes(env));
  const order = [...new Set([wanted, 'test', 'qa', 'uat', 'dev'])];
  let picked = null;
  let fallback = false;
  for (const env of order) {
    const hit = byEnv(env);
    if (!hit) continue;
    picked = hit;
    // 只有“没要求 dev、却落到 dev”才算降级
    fallback = /(^|[-_])dev/.test(expandDbEnv(hit.env)) && !/(^|[-_])dev/.test(wanted);
    break;
  }
  picked = picked ?? list.find((db) => !/(^|[-_])dev/.test(expandDbEnv(db.env))) ?? list[0];
  return {
    id: picked.id ?? '',
    env: picked.env ?? '',
    host: picked.host ?? '',
    port: picked.port ?? 3306,
    schema: picked.database ?? '',
    username: picked.username ?? '',
    password: picked.password ?? '',
    fallback,
  };
}

function loadProfile(projectRoot, explicit) {
  const candidates = [explicit, path.join(projectRoot, '.env-prep', 'env-profile.json')].filter(Boolean);
  for (const file of candidates) {
    if (file && fs.existsSync(file)) {
      try {
        return { file, profile: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        continue;
      }
    }
  }
  return { file: '', profile: null };
}

function cmdDbQueries(projectRoot, options = {}) {
  const { file, profile } = loadProfile(projectRoot, options.profile);
  if (!profile) return { ok: false, reason: `找不到 env-profile.json（${file || '<project>/.env-prep/env-profile.json'}）` };
  const db = pickDatabase(profile, options.env || 'qa');
  if (!db || !db.schema) return { ok: false, reason: 'profile 里没有可用的数据库配置' };
  const sql = [
    `SELECT TABLE_NAME AS table_name, TABLE_ROWS AS rows_est, DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db.schema}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY DATA_LENGTH DESC;`,
  ];
  const notes = ['只读：只用 SELECT / information_schema。TABLE_ROWS 是 InnoDB 估算值，足够排序；要精确可对前几张表跑 COUNT(*)。密码不回显、不落盘。'];
  notes.push('优先测试环境（qa / test）：研发库常被造数据，行数说明不了业务规模。');
  if (db.fallback) notes.push(`没有找到 test / qa 库，已退到 ${db.env}，结论的可信度要打折。`);
  return {
    ok: true,
    profile: file,
    database: { env: db.env, host: db.host, port: db.port, schema: db.schema, username: db.username, fallback: db.fallback },
    sql,
    note: notes.join(' '),
  };
}

/** 归一化 MCP / mysql CLI 导出的行数据，兼容大小写与常见别名。 */
function normalizeRows(rows) {
  return rows.map((row) => {
    const lower = {};
    for (const [key, value] of Object.entries(row)) lower[key.toLowerCase()] = value;
    const name = lower.table_name ?? lower.table ?? lower.name ?? lower.tablename ?? '';
    const count = lower.rows_est ?? lower.table_rows ?? lower.rows ?? lower.count ?? 0;
    const bytes = lower.data_bytes ?? lower.data_length ?? 0;
    return { table: String(name), rows: Number(count) || 0, bytes: Number(bytes) || 0 };
  }).filter((row) => row.table);
}

function cmdDbIngest(projectRoot, rowsFile, options = {}) {
  if (!rowsFile || !fs.existsSync(rowsFile)) return { ok: false, reason: `找不到行数文件：${rowsFile ?? '(未指定)'}` };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error.message}` };
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.tables ?? parsed.data ?? []);
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: '文件里没有表行数（期望数组或 { rows: [...] }）' };

  const knowledge = loadKnowledge(projectRoot);
  const normalized = normalizeRows(rows);
  const minRows = Number(options.minRows ?? 0);
  const tables = normalized.map((row) => {
    const logLike = isLogTable(row.table);
    return {
      ...row,
      feature: logLike ? null : featureOfTable(row.table, knowledge),
      filtered: logLike ? 'log' : (row.rows < minRows ? 'small' : ''),
    };
  });

  const groups = new Map();
  for (const table of tables) {
    if (table.filtered) continue;
    const key = table.feature || 'unknown';
    const group = groups.get(key) ?? { id: key, name: key, rows: 0, tables: [], weight: 0 };
    group.rows += table.rows;
    group.tables.push({ table: table.table, rows: table.rows });
    group.weight += Math.log10(Math.max(table.rows, 1)) + 1;
    groups.set(key, group);
  }
  const features = [...groups.values()]
    .map((group) => ({ ...group, tables: group.tables.sort((a, b) => b.rows - a.rows).slice(0, 8) }))
    .sort((a, b) => b.weight - a.weight || b.rows - a.rows)
    .slice(0, options.limit ?? 10);

  const totalRows = tables.filter((table) => !table.filtered).reduce((sum, table) => sum + table.rows, 0);
  const data = {
    generatedAt: nowIso(),
    version: VERSION,
    source: options.source ?? 'ingest',
    totals: {
      tables: tables.length,
      rows: totalRows,
      filtered: tables.filter((table) => table.filtered === 'log').length,
    },
    features,
    tables: tables.sort((a, b) => b.rows - a.rows),
  };
  writeJson(path.join(knowledgeDir(projectRoot), 'db.json'), data);
  return { ok: true, totals: data.totals, features: features.length };
}

// ---------------------------------------------------------------- 功能点（没有工作流时的兜底）

/** 把一个入口归到“业务域”：URL 首段 / 包里的业务包 / 任务名前缀。 */
function domainKey(kind, route, entryPath = '') {
  const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
  const routeText = String(route ?? '');
  if (kind === 'http') {
    const pathText = routeText.replace(/^[A-Z]+\s+/, '');
    const segments = pathText.split('/').filter(Boolean);
    const first = segments.find((segment) => !/^(v\d+|api|rest|internal|open)$/i.test(segment)) ?? segments[0] ?? '';
    return norm(first);
  }
  if (kind === 'dubbo') {
    // 接口名常常是 IXxxProvider / XxxServiceImpl，取包里的业务包更稳（scf/asset/provider/... → asset）。
    const parts = String(entryPath ?? '').split('/');
    const providerIndex = parts.findIndex((part) => /^(provider|service|impl|facade)$/i.test(part));
    if (providerIndex > 0) {
      const business = parts[providerIndex - 1];
      if (business && !/^(src|main|java)$/i.test(business)) return norm(business);
    }
    const simple = routeText.split('.').pop() ?? '';
    return norm(simple.replace(/^I(?=[A-Z])/, '').replace(/(Provider|ServiceImpl|Service|Api|Facade|Impl)$/i, ''));
  }
  if (kind === 'job') return norm(routeText.split(/[^a-zA-Z0-9]+|(?=[A-Z])/)[0]);
  if (kind === 'mq') return norm(routeText.split(/[.\-_]/)[0]);
  if (kind === 'feign') return norm(routeText.split(/[.\-_/ ]/)[0]);
  return '';
}

/** 通用 CRUD 端点（MyBatis-Plus 那套 allList / getById / count）不参与功能推断，避免淹没业务功能。 */
const SCAFFOLD_TAIL = /^(getById|getByIds|getInfo|allCount|count|allList|allListMaps|list|page|pageList|save|saveOrUpdate|update|delete|batchDelete|remove|add|insert|select|export|import|download|upload)$/i;

function isScaffold(route) {
  const pathText = String(route ?? '').replace(/^[A-Z]+\s+/, '');
  const tail = pathText.split('/').filter(Boolean).pop() ?? '';
  return SCAFFOLD_TAIL.test(tail);
}

const FEATURE_WEIGHT = { http: 1, dubbo: 2, job: 2, mq: 2, feign: 1 };

/**
 * 推断“主要功能点”。
 *
 * 有流程定义：每个流程就是一个功能点（最可靠的业务清单）。
 * 没有流程定义（很多项目没有工作流引擎）：按 HTTP 首段 / 包里的业务包 / 任务名前缀聚合入口，
 * 过滤掉通用 CRUD 端点，得到候选供模型确认。
 */
function buildFeatures(knowledge, options = {}) {
  const minWeight = options.minWeight ?? 8;
  const features = [];

  const dbFeatures = (knowledge.db?.features ?? []).map((feature) => ({
    id: feature.id,
    name: feature.name,
    origin: 'data-volume',
    weight: 100 + Math.round(feature.weight * 5),
    counts: { http: 0, dubbo: 0, job: 0, mq: 0, feign: 0, flow: 0 },
    repos: [],
    flows: [],
    rows: feature.rows,
    samples: (feature.tables ?? []).slice(0, 3).map((table) => ({ kind: 'table', id: table.table, path: '', line: 0, rows: table.rows })),
  }));

  for (const flow of knowledge.flows.flows) {
    const samples = [...new Set(flow.handlers.filter((handler) => handler.path).map((handler) => `${handler.path}:${handler.line}`))]
      .slice(0, 3)
      .map((anchor) => {
        const [file, line] = anchor.split(':');
        return { kind: 'flow', id: flow.id, path: file, line: Number(line) || 0 };
      });
    features.push({
      id: flow.id,
      name: flow.name,
      origin: 'workflow',
      weight: 8 + Math.min(flow.handlers.length, 4),
      counts: { http: 0, dubbo: 0, job: 0, mq: 0, feign: 0, flow: 1 },
      repos: [flow.repo],
      flows: [{ id: flow.id, name: flow.name, file: flow.file }],
      samples,
    });
  }

  const groups = new Map();
  const touch = (key) => {
    const group = groups.get(key) ?? {
      id: key, name: key, origin: 'entries', weight: 0,
      counts: { http: 0, dubbo: 0, job: 0, mq: 0, feign: 0, flow: 0 },
      repos: new Set(), flows: [], samples: [],
    };
    groups.set(key, group);
    return group;
  };
  for (const item of knowledge.entries.items) {
    if (item.kind === 'http' && isScaffold(item.route)) continue;
    const key = domainKey(item.kind, item.route, item.path) || item.repo;
    if (!key) continue;
    const group = touch(key);
    group.counts[item.kind] += 1;
    group.weight += FEATURE_WEIGHT[item.kind] ?? 1;
    group.repos.add(item.repo);
    if (group.samples.length < 4) group.samples.push({ kind: item.kind, id: item.id, path: item.path, line: item.line });
  }
  const flowIds = new Set(features.map((feature) => feature.id));
  const entryFeatures = [...groups.values()]
    .filter((group) => group.weight >= minWeight && !flowIds.has(group.id))
    .map((group) => ({ ...group, repos: [...group.repos] }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  // 流程是最可靠的功能清单，不能被入口聚合的数量挤掉：先放全部流程，再补入口候选。
  const flowFeatures = features.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const entryBudget = Math.max(10, (options.limit || 60) - dbFeatures.length - flowFeatures.length);
  return {
    generatedAt: nowIso(),
    version: VERSION,
    source: [knowledge.flows.flows.length > 0 ? 'flows' : '', dbFeatures.length > 0 ? 'data-volume' : '', 'entries']
      .filter(Boolean).join('+'),
    note: knowledge.flows.flows.length > 0
      ? '每个流程一个功能点（origin=workflow），其余按入口聚合（origin=entries）。'
      : '项目没有流程定义：功能点由入口聚合而来，已过滤通用 CRUD 端点，业务含义需模型确认。',
    features: [...dbFeatures, ...flowFeatures, ...entryFeatures.slice(0, entryBudget)],
  };
}

function formatRows(value) {
  const rows = Number(value) || 0;
  if (rows >= 1_000_000_000) return `${(rows / 1_000_000_000).toFixed(1)}B`;
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(1)}M`;
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}K`;
  return String(rows);
}

function featuresMarkdown(data, flowsAvailable) {
  const lines = ['# 功能点候选', ''];
  lines.push(`> 来源：${data.source}。${data.note}`, '');
  lines.push('| 功能点 | 来源 | 入口数 | 流程 | 数据量 | 涉及仓库 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const feature of data.features) {
    const total = feature.counts.http + feature.counts.dubbo + feature.counts.job + feature.counts.mq + feature.counts.feign;
    const origin = feature.origin === 'workflow' ? '流程定义'
      : feature.origin === 'data-volume' ? '数据量' : '入口聚合';
    const rows = feature.rows ? formatRows(feature.rows) : '-';
    lines.push(`| ${feature.name} | ${origin} | ${total} | ${feature.counts.flow} | ${rows} | ${feature.repos.slice(0, 3).join(', ') || '-'} |`);
  }
  lines.push('');
  lines.push('> 这是脚本聚合出的候选，不是结论。确认后的功能点用 `core mark --feature <id>` 固定下来。');
  if (data.features.some((feature) => feature.origin === 'data-volume')) {
    lines.push('> 「数据量」来自开发/测试库的 `information_schema.TABLE_ROWS`（估算值），已过滤日志/历史/临时表；'
      + '行数多只是“业务在用”的证据，不代表重要，最终仍要模型判断。');
  }
  if (!flowsAvailable) {
    lines.push('> 本项目没有流程定义（procdefs）：功能点全部来自入口聚合，已排除通用 CRUD 端点；'
      + 'HTTP 首段 / 包里的业务包 / 任务名前缀就是聚合键，业务命名需要模型或人来确认。');
  }
  return `${lines.join('\n')}\n`;
}

function cmdFeatures(projectRoot, options = {}) {
  const knowledge = loadKnowledge(projectRoot);
  const data = buildFeatures(knowledge, { minWeight: options.minWeight ?? 8, limit: options.limit || 60 });
  const dir = knowledgeDir(projectRoot);
  writeJson(path.join(dir, 'features.json'), data);
  fs.writeFileSync(path.join(dir, 'features.md'), featuresMarkdown(data, knowledge.flows.flows.length > 0), 'utf8');
  return data;
}

function knowledgeDir(projectRoot) {
  return path.join(projectRoot, KNOWLEDGE);
}

function writeIndexReadme(knowledge, summary) {
  const lines = [
    '# .knowledge —— 项目索引',
    '',
    '由 `java-project-tour` 技能生成，供后续技能定位代码。**不要手工编辑**，重跑扫描即可刷新。',
    '',
    '| 文件 | 内容 |',
    '| --- | --- |',
    '| `inventory.json` | 仓库 / 模块 / 依赖 / 技术栈 / 分层 |',
    '| `entries.json` | 入口索引：HTTP / Dubbo / Job / MQ / Feign |',
    '| `data.json` | 表 ↔ Mapper ↔ 实体 |',
    '| `flows/index.json` | 业务流程（procdef）与处理类位置 |',
    '| `flows/*.md` | 每条流程的处理类清单 |',
    '| `features.json` | 功能点候选（有流程挂流程，没流程按入口聚合） |',
    '| `features.md` | 功能点一览（模型确认后写进 core） |',
    '| `db.json` | 可选：开发/测试库的表行数 → 数据量推断出的核心功能 |',
    '| `core.json` | **核心标记**：核心流程 / 核心类 / 核心表 |',
    '| `core.md` | 核心索引速览（先读这个） |',
    '| `manifest.json` | 各仓库 HEAD 与扫描时间，用于过期判定 |',
    '',
    '## 常用查询',
    '',
    '```bash',
    'node <技能目录>/scripts/tour.mjs find 资产签发',
    'node <技能目录>/scripts/tour.mjs where "资产签发增加字段"',
    'node <技能目录>/scripts/tour.mjs core brief',
    'node <技能目录>/scripts/tour.mjs status',
    '```',
    '',
    `当前：${summary.repos} 个仓库、${summary.javaFiles} 个 Java 文件、${summary.entries} 条入口、${summary.tables} 张表、${summary.flows} 条流程、${summary.features} 个功能点。`,
    '',
  ];
  fs.writeFileSync(path.join(knowledge, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------- 命令实现

function cmdInventory(projectRoot, repos, partial = false) {
  const data = buildInventory(projectRoot, repos);
  if (partial) {
    const prev = readJson(path.join(knowledgeDir(projectRoot), 'inventory.json'), { repos: [], crossRepoDeps: [] });
    const scanned = new Set(repos);
    data.repos = [...prev.repos.filter((repo) => !scanned.has(repo.name)), ...data.repos]
      .sort((a, b) => a.name.localeCompare(b.name));
    const deps = new Map(prev.crossRepoDeps.map((dep) => [`${dep.from}->${dep.to}`, dep]));
    for (const dep of data.crossRepoDeps) deps.set(`${dep.from}->${dep.to}`, dep);
    data.crossRepoDeps = [...deps.values()];
  }
  writeJson(path.join(knowledgeDir(projectRoot), 'inventory.json'), data);
  return data;
}

function cmdEntries(projectRoot, repos, partial = false) {
  const data = buildEntries(projectRoot, repos);
  if (partial) {
    const file = path.join(knowledgeDir(projectRoot), 'entries.json');
    const prev = readJson(file, { items: [], classes: [] });
    const scanned = new Set(repos);
    data.items = [...prev.items.filter((item) => !scanned.has(item.repo)), ...data.items]
      .sort((a, b) => a.id.localeCompare(b.id));
    const classes = new Map(prev.classes.map((item) => [item.fqn, item]));
    for (const item of data.classes) classes.set(item.fqn, item);
    data.classes = [...classes.values()];
  }
  writeJson(path.join(knowledgeDir(projectRoot), 'entries.json'), data);
  return data;
}

function mergeTables(prevTables, nextTables) {
  const byName = new Map(prevTables.map((table) => [table.name, table]));
  for (const table of nextTables) {
    const existing = byName.get(table.name);
    if (!existing) {
      byName.set(table.name, table);
      continue;
    }
    existing.reads = table.reads;
    existing.writes = table.writes;
    if (table.entity) existing.entity = table.entity;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cmdData(projectRoot, repos, partial = false) {
  const data = buildData(projectRoot, repos);
  if (partial) {
    const file = path.join(knowledgeDir(projectRoot), 'data.json');
    const prev = readJson(file, { mappers: [], tables: [] });
    const scanned = new Set(repos);
    // tables 是按名字聚合的，不能整表替换：先扣掉本次仓库贡献的引用，再合并新结果。
    const kept = prev.tables.map((table) => ({
      ...table,
      reads: table.reads.filter((ref) => !scanned.has(ref.repo)),
      writes: table.writes.filter((ref) => !scanned.has(ref.repo)),
    })).filter((table) => table.reads.length + table.writes.length > 0 || table.entity);
    const keptMappers = prev.mappers.filter((mapper) => !scanned.has(mapper.repo));
    data.mappers = [...keptMappers, ...data.mappers];
    data.tables = mergeTables(kept, data.tables);
  }
  writeJson(path.join(knowledgeDir(projectRoot), 'data.json'), data);
  return data;
}

function cmdFlows(projectRoot, repos, options = {}) {
  const entries = readJson(path.join(knowledgeDir(projectRoot), 'entries.json'), { classes: [] });
  const index = new Map(entries.classes.map((item) => [item.fqn, item]));
  const data = buildFlows(projectRoot, repos, index, options.procdefs ?? [], options.useAuto !== false);
  const dir = knowledgeDir(projectRoot);
  if (options.partial) {
    const scanned = new Set(repos);
    const prev = readJson(path.join(dir, 'flows', 'index.json'), { flows: [] });
    data.flows = [...prev.flows.filter((flow) => !scanned.has(flow.repo)), ...data.flows]
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  writeJson(path.join(dir, 'flows', 'index.json'), { generatedAt: data.generatedAt, flows: data.flows });
  ensureDir(path.join(dir, 'flows'));
  for (const flow of data.flows) {
    fs.writeFileSync(path.join(dir, 'flows', `${slug(flow.id)}.md`), flowMarkdown(flow), 'utf8');
  }
  if (data.unresolved.length > 0) {
    const prev = readJson(path.join(dir, 'unresolved.json'), { items: [] });
    writeJson(path.join(dir, 'unresolved.json'), {
      generatedAt: nowIso(),
      items: [...prev.items.filter((item) => item.kind !== 'procdef'), ...data.unresolved],
    });
  }
  return data;
}

function cmdScan(projectRoot, repos, options = {}) {
  const started = Date.now();
  ensureDir(knowledgeDir(projectRoot));
  const inventory = cmdInventory(projectRoot, repos);
  const entries = cmdEntries(projectRoot, repos);
  const data = cmdData(projectRoot, repos);
  const flows = cmdFlows(projectRoot, repos, { procdefs: options.procdefs ?? [], useAuto: options.useAuto !== false });
  const features = cmdFeatures(projectRoot, options);
  const manifest = {
    version: VERSION,
    generatedAt: nowIso(),
    mode: 'full',
    elapsedMs: Date.now() - started,
    repos: Object.fromEntries(inventory.repos.map((repo) => [repo.name, {
      head: repo.head,
      javaFiles: repo.javaFiles,
      scannedAt: nowIso(),
    }])),
  };
  writeJson(path.join(knowledgeDir(projectRoot), 'manifest.json'), manifest);
  const summary = {
    repos: inventory.repos.length,
    javaFiles: inventory.repos.reduce((sum, repo) => sum + (repo.javaFiles ?? 0), 0),
    entries: entries.items.length,
    tables: data.tables.length,
    flows: flows.flows.length,
    features: features.features.length,
  };
  writeIndexReadme(knowledgeDir(projectRoot), summary);
  return { summary, elapsedMs: manifest.elapsedMs, unresolved: flows.unresolved.length };
}

// ---------------------------------------------------------------- 查询

function loadKnowledge(projectRoot) {
  const dir = knowledgeDir(projectRoot);
  return {
    dir,
    inventory: readJson(path.join(dir, 'inventory.json'), { repos: [] }),
    entries: readJson(path.join(dir, 'entries.json'), { items: [], classes: [] }),
    data: readJson(path.join(dir, 'data.json'), { tables: [], mappers: [] }),
    flows: readJson(path.join(dir, 'flows', 'index.json'), { flows: [] }),
    features: readJson(path.join(dir, 'features.json'), { features: [] }),
    db: readJson(path.join(dir, 'db.json'), null),
    core: readJson(path.join(dir, 'core.json'), { version: 1, items: [] }),
  };
}

function coreIndex(core) {
  const flows = new Set();
  const classes = new Set();
  const tables = new Set();
  const features = new Set();
  for (const item of core.items ?? []) {
    if (item.kind === 'flow') flows.add(item.id);
    if (item.kind === 'class') classes.add(item.id);
    if (item.kind === 'table') tables.add(item.id);
    if (item.kind === 'feature') features.add(item.id);
  }
  return { flows, classes, tables, features };
}

function candidates(knowledge) {
  const result = [];
  const seenFeature = new Set();
  for (const feature of (knowledge.features?.features ?? [])) {
    if (feature.origin === 'workflow') continue; // 流程本身已经作为 kind=flow 的候选存在，避免重复
    if (seenFeature.has(feature.id)) continue;
    seenFeature.add(feature.id);
    const total = feature.counts.http + feature.counts.dubbo + feature.counts.job + feature.counts.mq + feature.counts.feign;
    const symbol = feature.rows
      ? `${formatRows(feature.rows)} 行`
      : `${total} 入口 / ${feature.counts.flow} 流程`;
    // 数据量来的功能点没有入口，用它的头号表反查一个代码锚点，避免输出空行。
    let anchorPath = feature.samples[0]?.path ?? '';
    let anchorLine = feature.samples[0]?.line ?? 0;
    if (!anchorPath && feature.origin === 'data-volume') {
      const tableName = feature.samples[0]?.id ?? '';
      const table = knowledge.data.tables.find((item) => item.name === tableName);
      anchorPath = table?.entity?.path ?? table?.reads[0]?.path ?? '';
      anchorLine = table?.entity?.line ?? table?.reads[0]?.line ?? 0;
    }
    result.push({
      kind: 'feature',
      id: feature.id,
      title: feature.name,
      path: anchorPath,
      line: anchorLine,
      symbol,
      repo: feature.repos[0] ?? '',
      layer: 'feature',
      haystack: `${feature.id} ${feature.name} ${feature.repos.join(' ')} ${feature.flows.map((f) => f.name).join(' ')} ${feature.samples.map((s) => s.id).join(' ')}`.toLowerCase(),
    });
  }
  for (const item of knowledge.entries.items) {
    result.push({
      kind: item.kind,
      id: item.id,
      title: item.route || item.id,
      path: item.path,
      line: item.line,
      symbol: item.symbol,
      repo: item.repo,
      layer: item.layer,
      haystack: `${item.id} ${item.symbol} ${item.path} ${item.route}`.toLowerCase(),
    });
  }
  for (const flow of knowledge.flows.flows) {
    const handlerPaths = flow.handlers.filter((h) => h.path).slice(0, 3).map((h) => `${h.path}:${h.line}`).join(' ');
    result.push({
      kind: 'flow',
      id: flow.id,
      title: flow.name,
      path: flow.file,
      line: 0,
      symbol: flow.typeName,
      repo: flow.repo,
      layer: 'flow',
      haystack: `${flow.id} ${flow.name} ${flow.typeName} ${flow.category} ${handlerPaths}`.toLowerCase(),
    });
    for (const handler of flow.handlers.filter((h) => h.path)) {
      result.push({
        kind: 'handler',
        id: `${flow.id}::${handler.className}`,
        title: handler.className,
        path: handler.path,
        line: handler.line,
        symbol: handler.extName,
        repo: flow.repo,
        layer: 'flow-handler',
        haystack: `${handler.className} ${handler.fqn} ${handler.extName} ${handler.nodeName}`.toLowerCase(),
      });
    }
  }
  for (const table of knowledge.data.tables) {
    result.push({
      kind: 'table',
      id: table.name,
      title: table.name,
      path: table.entity ? table.entity.path : (table.reads[0]?.path ?? ''),
      line: table.entity ? table.entity.line : (table.reads[0]?.line ?? 0),
      symbol: `${table.reads.length} 读 / ${table.writes.length} 写`,
      repo: table.reads[0]?.repo ?? table.writes[0]?.repo ?? '',
      layer: 'table',
      haystack: `${table.name} ${[table.reads, table.writes].flat().map((r) => r.path).join(' ')}`.toLowerCase(),
    });
  }
  const deduped = [];
  const seen = new Set();
  for (const item of result) {
    const key = item.kind === 'handler' ? `handler|${item.path}|${item.line}` : `${item.kind}|${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function matchScore(candidate, token) {
  let score = 0;
  if (candidate.haystack.includes(token)) score += 3;
  if (candidate.id.toLowerCase() === token) score += 6;
  if (candidate.id.toLowerCase().includes(token)) score += 2;
  if (candidate.title && candidate.title.toLowerCase().includes(token)) score += 2;
  return score;
}

function search(knowledge, tokens, options = {}) {
  const core = coreIndex(knowledge.core);
  const all = candidates(knowledge);
  const scored = [];
  for (const candidate of all) {
    if (options.kind && options.kind !== candidate.kind) continue;
    let match = 0;
    for (const token of tokens) match += matchScore(candidate, token);
    // 没有任何关键词命中时直接跳过：核心标记只做加权，不能让核心项出现在无关查询里。
    if (match <= 0) continue;
    const isCore = core.flows.has(candidate.id) || core.classes.has(candidate.path)
      || core.tables.has(candidate.id) || core.features.has(candidate.id);
    scored.push({ ...candidate, score: match + (isCore ? 8 : 0), core: isCore });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, options.limit ?? 10);
}

function fmtHit(hit) {
  const loc = hit.line ? `${hit.path}:${hit.line}` : hit.path;
  const star = hit.core ? '★ ' : '  ';
  return `${star}${hit.kind.padEnd(8)} ${hit.title}  ${hit.symbol ? `(${hit.symbol}) ` : ''}\n     ${loc}`;
}

function cmdFind(projectRoot, tokens, options) {
  const knowledge = loadKnowledge(projectRoot);
  const hits = search(knowledge, tokens, options);
  if (hits.length === 0) return { hits: [] };
  return { hits };
}

function cmdWhere(projectRoot, tokens, options = {}) {
  const knowledge = loadKnowledge(projectRoot);
  const hits = search(knowledge, tokens, { limit: options.limit ?? 30 });
  const groups = new Map();
  for (const hit of hits) {
    const key = hit.kind === 'table' ? 'table'
      : hit.kind === 'flow' || hit.kind === 'flow-handler' ? 'flow'
        : (hit.layer || 'other');
    const list = groups.get(key) ?? [];
    list.push(hit);
    groups.set(key, list);
  }
  const risks = [];
  for (const hit of hits.filter((h) => h.kind === 'table')) {
    const table = knowledge.data.tables.find((t) => t.name === hit.id);
    if (table) {
      const paths = new Set([...table.reads, ...table.writes].map((r) => r.path));
      if (paths.size > 1) risks.push(`表 ${table.name} 在 ${paths.size} 个位置被读写，改结构要全部核对`);
    }
  }
  return { groups: Object.fromEntries(groups), risks, raw: hits };
}

function cmdContext(projectRoot, target) {
  const knowledge = loadKnowledge(projectRoot);
  const core = coreIndex(knowledge.core);
  const rel = target.split('\\').join('/').replace(/^\.\//, '');
  const entry = knowledge.entries.items.find((item) => item.path === rel || item.path.endsWith(`/${rel}`));
  const mapper = knowledge.data.mappers.find((item) => item.path === rel || item.path.endsWith(`/${rel}`));
  const table = knowledge.data.tables.find((item) => item.entity && item.entity.path === rel);
  const flowHandlers = [];
  for (const flow of knowledge.flows.flows) {
    for (const handler of flow.handlers) {
      if (handler.path && (handler.path === rel || handler.path.endsWith(`/${rel}`))) {
        flowHandlers.push({ flow: flow.name, node: handler.nodeName, line: handler.line });
      }
    }
  }
  const siblings = knowledge.entries.items
    .filter((item) => item.repo === (entry?.repo ?? mapper?.repo ?? '') && item.layer === layerOf(rel) && item.path !== rel)
    .slice(0, 5)
    .map((item) => ({ title: item.route, path: item.path, line: item.line }));
  return {
    path: rel,
    layer: layerOf(rel),
    core: core.classes.has(rel) || core.tables.has(table?.name ?? ''),
    entry: entry ?? null,
    mapper: mapper ?? null,
    table: table ?? null,
    flows: flowHandlers,
    siblings,
  };
}

// ---------------------------------------------------------------- 核心标记

function loadCore(projectRoot) {
  return readJson(path.join(knowledgeDir(projectRoot), 'core.json'), {
    version: VERSION, project: path.basename(projectRoot), updatedAt: nowIso(), items: [],
  });
}

function saveCore(projectRoot, core) {
  core.updatedAt = nowIso();
  writeJson(path.join(knowledgeDir(projectRoot), 'core.json'), core);
  writeCoreBrief(projectRoot, core);
}

function markCore(projectRoot, mark) {
  const core = loadCore(projectRoot);
  const at = nowIso();
  const by = mark.by || 'unknown';
  const upsert = (kind, id, extra = {}) => {
    const existing = core.items.find((item) => item.kind === kind && item.id === id);
    if (existing) {
      existing.hits = (existing.hits ?? 1) + 1;
      existing.at = at;
      existing.markedBy = by;
      if (mark.reason) existing.reason = mark.reason;
      return existing;
    }
    const item = { kind, id, reason: mark.reason ?? '', markedBy: by, at, hits: 1, ...extra };
    core.items.push(item);
    return item;
  };
  const added = [];
  for (const flow of mark.flows) added.push(upsert('flow', flow));
  for (const cls of mark.classes) added.push(upsert('class', cls, { layer: layerOf(cls) }));
  for (const table of mark.tables) added.push(upsert('table', table));
  for (const feature of mark.features) added.push(upsert('feature', feature));
  saveCore(projectRoot, core);
  return { added, total: core.items.length };
}

function unmarkCore(projectRoot, mark) {
  const core = loadCore(projectRoot);
  const before = core.items.length;
  core.items = core.items.filter((item) => {
    if (item.kind === 'flow' && mark.flows.includes(item.id)) return false;
    if (item.kind === 'class' && mark.classes.includes(item.id)) return false;
    if (item.kind === 'table' && mark.tables.includes(item.id)) return false;
    if (item.kind === 'feature' && mark.features.includes(item.id)) return false;
    return true;
  });
  saveCore(projectRoot, core);
  return { removed: before - core.items.length, total: core.items.length };
}

function writeCoreBrief(projectRoot, core) {
  const knowledge = loadKnowledge(projectRoot);
  const lines = ['# 核心索引（先读这个）', ''];
  lines.push('> 由 `tour.mjs core mark` 维护。后续技能查询前先读本文件，再查全量索引。', '');
  const features = core.items.filter((item) => item.kind === 'feature');
  const flows = core.items.filter((item) => item.kind === 'flow');
  const classes = core.items.filter((item) => item.kind === 'class');
  const tables = core.items.filter((item) => item.kind === 'table');
  if (features.length > 0) {
    lines.push(`## 核心功能点（${features.length}）`);
    lines.push('');
    for (const item of features) {
      const feature = (knowledge.features?.features ?? []).find((f) => f.id === item.id);
      if (!feature) {
        lines.push(`- ${item.id}（索引里找不到，可能有流程/入口变更）`);
        continue;
      }
      const total = feature.counts.http + feature.counts.dubbo + feature.counts.job + feature.counts.mq + feature.counts.feign;
      lines.push(`- **${feature.name}**（\`${feature.id}\`，${total} 入口 / ${feature.counts.flow} 流程）${item.reason ? ` —— ${item.reason}` : ''}`);
      for (const sample of feature.samples.slice(0, 3)) {
        const loc = sample.line ? `${sample.path}:${sample.line}` : sample.path;
        lines.push(`  - ${sample.id}  ${loc}`);
      }
    }
    lines.push('');
  }
  lines.push(`## 核心流程（${flows.length}）`);
  lines.push('');
  for (const item of flows) {
    const flow = knowledge.flows.flows.find((f) => f.id === item.id);
    if (!flow) {
      lines.push(`- ${item.id}（索引里找不到，可能没扫描）`);
      continue;
    }
    const anchors = [...new Set(flow.handlers.filter((h) => h.path).map((h) => `${h.path}:${h.line}`))].slice(0, 3);
    lines.push(`- **${flow.name}**（\`${flow.id}\`，${flow.nodes} 节点）${item.reason ? ` —— ${item.reason}` : ''}`);
    for (const anchor of anchors) lines.push(`  - ${anchor}`);
  }
  lines.push('');
  lines.push(`## 核心类（${classes.length}）`);
  lines.push('');
  for (const item of classes) {
    lines.push(`- \`${item.id}\`${item.reason ? ` —— ${item.reason}` : ''}`);
  }
  lines.push('');
  lines.push(`## 核心表（${tables.length}）`);
  lines.push('');
  for (const item of tables) {
    const table = knowledge.data.tables.find((t) => t.name === item.id);
    const detail = table ? `${table.reads.length} 读 / ${table.writes.length} 写` : '未在索引中';
    lines.push(`- \`${item.id}\`（${detail}）${item.reason ? ` —— ${item.reason}` : ''}`);
  }
  lines.push('');
  fs.writeFileSync(path.join(knowledgeDir(projectRoot), 'core.md'), `${lines.join('\n')}\n`, 'utf8');
  return lines.join('\n');
}

function listCore(projectRoot) {
  const core = loadCore(projectRoot);
  return core;
}

// ---------------------------------------------------------------- 状态

function cmdStatus(projectRoot) {
  const dir = knowledgeDir(projectRoot);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest) {
    return { scanned: false, reason: `${dir} 下没有 manifest.json，先跑 scan` };
  }
  const repos = listRepos(projectRoot);
  const stale = [];
  const missing = [];
  for (const repo of repos) {
    const known = manifest.repos[repo];
    if (!known) {
      missing.push(repo);
      continue;
    }
    const head = gitHead(path.join(projectRoot, repo));
    if (head && known.head && head !== known.head) stale.push({ repo, scannedHead: known.head, currentHead: head });
  }
  return { scanned: true, generatedAt: manifest.generatedAt, repos: repos.length, stale, missing };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = {
    project: '', repos: [], kind: '', limit: 0, json: false,
    reason: '', by: '', flows: [], classes: [], tables: [], features: [], procdefs: [], noProcdefs: false,
    profile: '', env: 'qa', minRows: 1000, source: '',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--project': options.project = argv[++i] ?? ''; break;
      case '--repos': options.repos = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--kind': options.kind = argv[++i] ?? ''; break;
      case '--limit': options.limit = Number(argv[++i] ?? 10); break;
      case '--json': options.json = true; break;
      case '--reason': options.reason = argv[++i] ?? ''; break;
      case '--by': options.by = argv[++i] ?? ''; break;
      case '--flow': options.flows.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--procdefs': options.procdefs.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--no-procdefs': options.noProcdefs = true; break;
      case '--class': options.classes.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--table': options.tables.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--feature': options.features.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--profile': options.profile = argv[++i] ?? ''; break;
      case '--env': options.env = String(argv[++i] ?? 'qa').toLowerCase(); break;
      case '--min-rows': options.minRows = Number(argv[++i] ?? 0); break;
      case '--source': options.source = argv[++i] ?? ''; break;
      default: positional.push(arg);
    }
  }
  return { options, positional };
}

function resolveProject(explicit) {
  if (explicit) return path.resolve(explicit);
  const fromEnv = process.env.TOUR_PROJECT;
  if (fromEnv) return path.resolve(fromEnv);
  const projectRoot = path.resolve('project');
  if (fs.existsSync(projectRoot)) {
    const dirs = fs.readdirSync(projectRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 1) return path.join(projectRoot, dirs[0].name);
  }
  return null;
}

function usage() {
  const lines = [
    'tour.mjs —— 多仓库 Java 项目索引',
    '',
    '  scan                     全量扫描，写出 .knowledge/',
    '  inventory|entries|data|flows   只刷新其中一项',
    '  find <关键词>            检索入口 / 流程 / 功能点 / 表（核心优先）',
    '  where "<改动意图>"        改动触点（按层分组）',
    '  context <path>           某个类的上下游',
    '  core mark|unmark|list|brief   核心标记',
    '  features                 按入口 / 流程推断功能点候选',
    '  db queries               打印查数据量用的只读 SQL（优先 qa/test 库）',
    '  db ingest <rows.json>    把表行数汇入 db.json，并推断 5-10 个核心功能',
    '  status                   过期检测',
    '',
    '  --project <dir>   项目根（默认 project/<唯一子目录>）',
    '  --repos a,b       只处理指定仓库',
    '  --procdefs <dir>  流程定义目录（默认自动找任意 procdefs/）',
    '  --profile <file>  env-profile.json（默认 <项目根>/.env-prep/env-profile.json）',
    '  --env <name>      数据库环境，默认 qa（优先 test/qa，不要默认连 dev）',
    '  --min-rows N      行数低于 N 的表不计入（默认 0）',
    '  --kind <kind>     find 过滤：http|dubbo|job|mq|feign|flow|feature|table',
    '  --limit N         输出条数',
    '  --json            机器可读输出',
    '  core mark 额外参数：--flow id --class path --table name --feature id --reason "..." --by <skill>',
    '  没有流程定义的项目：features 命令按入口聚合功能点候选',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? '';
  const projectRoot = resolveProject(options.project);
  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    process.stderr.write(`找不到项目目录：${projectRoot ?? '(未指定)'}\n用 --project 指定，或在 project/ 下只放一个项目。\n`);
    process.exitCode = 1;
    return;
  }
  const repos = (options.repos.length ? options.repos : listRepos(projectRoot));
  if (repos.length === 0) {
    process.stderr.write(`${projectRoot} 下没有找到仓库（需要 pom.xml 或 .git）。\n`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'scan': {
      const result = cmdScan(projectRoot, repos, { procdefs: options.procdefs, useAuto: !options.noProcdefs });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }
    case 'inventory':
    case 'entries':
    case 'data':
    case 'flows': {
      const partial = options.repos.length > 0;
      const result = command === 'flows'
        ? cmdFlows(projectRoot, repos, { partial, procdefs: options.procdefs, useAuto: !options.noProcdefs })
        : { inventory: cmdInventory, entries: cmdEntries, data: cmdData }[command](projectRoot, repos, partial);
      const summary = {
        command,
        repos: repos.length,
        ...(command === 'entries' ? { items: result.items.length } : {}),
        ...(command === 'data' ? { tables: result.tables.length } : {}),
        ...(command === 'flows' ? { flows: result.flows.length, unresolved: result.unresolved.length } : {}),
        ...(command === 'inventory' ? { reposScanned: result.repos.length } : {}),
      };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      break;
    }
    case 'features': {
      const data = cmdFeatures(projectRoot, options);
      process.stdout.write(JSON.stringify({ command: 'features', source: data.source, features: data.features.length }, null, 2) + '\n');
      break;
    }
    case 'db': {
      const sub = positional[1] ?? 'queries';
      if (sub === 'ingest') {
        const file = positional[2] ?? '';
        const result = cmdDbIngest(projectRoot, file, {
          limit: options.limit || 10,
          minRows: options.minRows,
          source: options.source || 'ingest',
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (!result.ok) process.exitCode = 1;
        break;
      }
      const result = cmdDbQueries(projectRoot, options);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'find': {
      const tokens = positional.slice(1).join(' ').toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) { usage(); process.exitCode = 1; break; }
      const result = cmdFind(projectRoot, tokens, { kind: options.kind, limit: options.limit || 10 });
      if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else if (result.hits.length === 0) process.stdout.write('没有命中。先跑 scan，或换个关键词。\n');
      else process.stdout.write(`${result.hits.map(fmtHit).join('\n')}\n`);
      if (result.hits.length === 0) process.exitCode = 2;
      break;
    }
    case 'where': {
      const tokens = positional.slice(1).join(' ').toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) { usage(); process.exitCode = 1; break; }
      const result = cmdWhere(projectRoot, tokens, { limit: options.limit || 30 });
      if (options.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); break; }
      const lines = [];
      for (const [group, hits] of Object.entries(result.groups)) {
        lines.push(`## ${group}（${hits.length}）`);
        for (const hit of hits.slice(0, 8)) lines.push(fmtHit(hit));
        lines.push('');
      }
      if (result.risks.length) lines.push(`风险：\n${result.risks.map((r) => `- ${r}`).join('\n')}`);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (result.raw.length === 0) process.exitCode = 2;
      break;
    }
    case 'context': {
      const target = positional[1];
      if (!target) { usage(); process.exitCode = 1; break; }
      const result = cmdContext(projectRoot, target);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }
    case 'core': {
      const sub = positional[1] ?? 'list';
      if (sub === 'mark') {
        if (options.flows.length + options.classes.length + options.tables.length + options.features.length === 0) {
          process.stderr.write('core mark 需要至少一个 --flow / --class / --table / --feature\n');
          process.exitCode = 1;
          break;
        }
        const result = markCore(projectRoot, options);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (sub === 'unmark') {
        const result = unmarkCore(projectRoot, options);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (sub === 'brief') {
        const text = writeCoreBrief(projectRoot, loadCore(projectRoot));
        process.stdout.write(`${text}\n`);
      } else {
        const core = listCore(projectRoot);
        process.stdout.write(JSON.stringify(core, null, 2) + '\n');
      }
      break;
    }
    case 'status': {
      const result = cmdStatus(projectRoot);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }
    default:
      usage();
      process.exitCode = 1;
  }
}

main();
