#!/usr/bin/env node
/**
 * 环境准备：把一份 env-profile.json 变成一串可执行动作。
 *
 *   node env-prep.mjs validate <profile.json>
 *   node env-prep.mjs plan     <profile.json>          # 只打印计划，不执行
 *   node env-prep.mjs apply    <profile.json> [--only open,clone,nacos,mcp,logs]
 *
 * 设计原则：
 * - 默认 dry-run，任何有副作用的动作都要显式 --apply；
 * - 密码/令牌永不打印，输出里只出现掩码；
 * - 一个动作失败不阻断其他动作，最后汇总。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MASK = '***';

/** 必填字段校验。 */
function validate(profile) {
  const problems = [];
  if (typeof profile !== 'object' || profile === null) return ['profile 不是对象'];
  if (typeof profile.project !== 'string' || profile.project === '') problems.push('缺少 project');
  const list = (key) => (Array.isArray(profile[key]) ? profile[key] : []);
  for (const db of list('databases')) {
    for (const field of ['host', 'database', 'username']) {
      if (!db[field]) problems.push(`databases.${db.id ?? '?'} 缺少 ${field}`);
    }
  }
  for (const nacos of list('nacos')) {
    if (!nacos.url) problems.push(`nacos.${nacos.id ?? '?'} 缺少 url`);
  }
  for (const repo of list('git')) {
    for (const field of ['url', 'dir']) {
      if (!repo[field]) problems.push(`git.${repo.id ?? '?'} 缺少 ${field}`);
    }
  }
  for (const env of list('environments')) {
    if (!env.url) problems.push(`environments.${env.id ?? '?'} 缺少 url`);
  }
  return problems;
}

const list = (profile, key) => (Array.isArray(profile[key]) ? profile[key] : []);

const expandHome = (value) => (value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value);

/** 生成动作清单。 */
function buildPlan(profile) {
  const actions = [];

  for (const env of list(profile, 'environments')) {
    actions.push({ type: 'bookmark', category: '环境', target: env.id, label: env.name ?? env.id, url: env.url });
  }
  for (const nacos of list(profile, 'nacos')) {
    actions.push({ type: 'bookmark', category: '配置中心', target: nacos.id, label: 'nacos', url: nacos.url });
    actions.push({ type: 'nacos', target: nacos.id, detail: `拉取 ${(nacos.dataIds ?? []).length} 个配置` });
  }
  for (const nexus of list(profile, 'nexus')) {
    actions.push({ type: 'bookmark', category: '制品库', target: nexus.id, label: 'nexus', url: nexus.url });
  }
  for (const log of list(profile, 'logs')) {
    actions.push({ type: 'bookmark', category: '日志', target: log.id, label: log.note ?? '日志平台', url: log.url });
    actions.push({ type: 'logs', target: log.id, detail: '探测接口并生成取日志脚本' });
  }
  for (const repo of list(profile, 'git')) {
    const dir = expandHome(repo.dir);
    actions.push({ type: 'clone', target: repo.id, detail: `${repo.url} -> ${dir}`, exists: fs.existsSync(dir) });
  }
  for (const db of list(profile, 'databases')) {
    actions.push({ type: 'mcp', target: db.id, detail: `生成 ${db.kind} 的 MCP 配置片段` });
  }
  return actions;
}

/* ------------------------------------------------------------------ *
 * 书签：写入 Chromium 系浏览器的 Bookmarks JSON
 * ------------------------------------------------------------------ */

/** Chromium 的 Bookmarks 文件候选位置（按优先级）。 */
function bookmarkCandidates() {
  const local = process.env.LOCALAPPDATA ?? '';
  const roaming = process.env.APPDATA ?? '';
  return [
    { browser: 'chrome', file: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks') },
    { browser: 'edge', file: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks') },
    { browser: 'brave', file: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks') },
  ].filter((item) => item.file !== '' && fs.existsSync(item.file));
}

/** 浏览器进程名，用于判断"现在能不能安全改文件"。 */
const BROWSER_PROCESS = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' };

/**
 * 判断某个浏览器是否正在运行。
 * @param browser - `chrome` / `edge` / `brave`
 * @returns 是否在跑。
 */
function browserRunning(browser) {
  const image = BROWSER_PROCESS[browser];
  if (image === undefined) return true;
  const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return (result.stdout ?? '').toLowerCase().includes(image);
}

/** Chromium 时间戳：1601-01-01 起的微秒数。 */
function chromeEpoch(now = Date.now()) {
  return String((now + 11_644_473_600_000) * 1000);
}

/** 找到当前书签树里最大的数字 id，新条目从它往后排。 */
function maxBookmarkId(doc) {
  const ids = [...JSON.stringify(doc).matchAll(/"id":"(\d+)"/g)].map((match) => Number(match[1]));
  return ids.length === 0 ? 1000 : Math.max(...ids);
}

/**
 * 把链接按分类整理成「项目文件夹 → 分类子文件夹 → 链接」的结构。
 * @param profile - env-profile。
 * @returns `[{ name, entries: [{ name, url }] }]`
 */
export function bookmarkTree(profile) {
  const groups = [];
  const add = (name, entries) => {
    if (entries.length > 0) groups.push({ name, entries });
  };
  add(
    '环境',
    list(profile, 'environments').map((item) => ({ name: item.name ?? item.id, url: item.url })),
  );
  add(
    '配置中心',
    list(profile, 'nacos').map((item) => ({ name: item.id, url: item.url })),
  );
  add(
    '制品库',
    list(profile, 'nexus').map((item) => ({ name: item.repository ? `${item.id} (${item.repository})` : item.id, url: item.url })),
  );
  add(
    '日志',
    list(profile, 'logs').map((item) => ({ name: item.note ?? item.id, url: item.url })),
  );
  return groups;
}

/**
 * 在书签树里找到（或创建）项目文件夹，并补齐分类与链接。
 * 已存在的链接按 url 去重，不会重复添加。
 * @returns 合并后的统计。
 */
export function mergeBookmarks(doc, profile, groups) {
  const now = chromeEpoch();
  let nextId = maxBookmarkId(doc) + 1;
  const newId = () => String((nextId += 1));
  const newGuid = () => crypto.randomUUID();

  const root = doc.roots.bookmark_bar ?? doc.roots.other;
  const existing = root.children.find((child) => child.type === 'folder' && child.name === profile.project);
  const projectFolder =
    existing ??
    {
      children: [],
      date_added: now,
      date_last_used: '0',
      date_modified: now,
      guid: newGuid(),
      id: newId(),
      name: profile.project,
      type: 'folder',
    };
  if (existing === undefined) root.children.push(projectFolder);

  let added = 0;
  let skipped = 0;
  for (const group of groups) {
    let folder = projectFolder.children.find((child) => child.type === 'folder' && child.name === group.name);
    if (folder === undefined) {
      folder = {
        children: [],
        date_added: now,
        date_last_used: '0',
        date_modified: now,
        guid: newGuid(),
        id: newId(),
        name: group.name,
        type: 'folder',
      };
      projectFolder.children.push(folder);
    }
    for (const entry of group.entries) {
      if (folder.children.some((child) => child.url === entry.url)) {
        skipped += 1;
        continue;
      }
      folder.children.push({
        date_added: now,
        date_last_used: '0',
        guid: newGuid(),
        id: newId(),
        name: entry.name,
        type: 'url',
        url: entry.url,
      });
      added += 1;
    }
  }
  projectFolder.date_modified = now;
  return { folder: projectFolder.name, added, skipped };
}

/** 生成可导入的 Netscape 书签文件（跨浏览器兜底）。 */
export function bookmarkHtml(profile, groups) {
  const escape = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3>${escape(profile.project)}</H3>`,
    '    <DL><p>',
  ];
  for (const group of groups) {
    lines.push(`        <DT><H3>${escape(group.name)}</H3>`);
    lines.push('        <DL><p>');
    for (const entry of group.entries) {
      lines.push(`            <DT><A HREF="${escape(entry.url)}">${escape(entry.name)}</A>`);
    }
    lines.push('        </DL><p>');
  }
  lines.push('    </DL><p>', '</DL><p>', '');
  return lines.join('\n');
}

/**
 * 把书签落到浏览器。
 *
 * 直接改写 Bookmarks 文件只在浏览器退出时安全——运行中的浏览器会在退出时用内存里的
 * 书签树覆盖文件。所以浏览器在跑、或没有 Chromium 系浏览器时，退回 HTML 导入文件。
 *
 * @param profile - env-profile。
 * @param outDir - 输出目录。
 * @param mode - `auto`（默认）/ `file` / `html`。
 */
export function applyBookmarks(profile, outDir, mode = 'auto') {
  const groups = bookmarkTree(profile);
  if (groups.length === 0) return { ok: true, skipped: true, reason: 'profile 里没有可收藏的地址' };

  const candidates = bookmarkCandidates();
  const target = candidates[0];
  const wantFile = mode === 'file' || (mode === 'auto' && candidates.length > 0);
  const running = target !== undefined && browserRunning(target.browser);

  if (wantFile && target !== undefined && !running) {
    const raw = fs.readFileSync(target.file, 'utf8');
    const doc = JSON.parse(raw);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(outDir, 'bookmarks', `${target.browser}-Bookmarks.${stamp}.bak.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, raw, 'utf8');
    const stats = mergeBookmarks(doc, profile, groups);
    fs.writeFileSync(target.file, JSON.stringify(doc), 'utf8');
    return { ok: true, mode: 'file', browser: target.browser, file: target.file, backup, ...stats };
  }

  // 兜底：导出可导入的 HTML，不碰浏览器数据。
  const file = path.join(outDir, 'bookmarks', `${profile.project}-bookmarks.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bookmarkHtml(profile, groups), 'utf8');
  return {
    ok: true,
    mode: 'html',
    file,
    reason: target === undefined ? '没有检测到 Chromium 系浏览器' : `${target.browser} 正在运行，直接改文件会被覆盖`,
    groups: groups.map((group) => ({ name: group.name, count: group.entries.length })),
  };
}

/** 克隆仓库；目录已存在时跳过。 */
function cloneRepo(repo) {
  const dir = expandHome(repo.dir);
  if (fs.existsSync(dir)) return { ok: true, skipped: true, reason: '目录已存在' };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone'];
  if (repo.branch) args.push('--branch', repo.branch);
  args.push(repo.url, dir);
  const result = spawnSync('git', args, { stdio: 'pipe', timeout: 300_000, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, reason: (result.stderr ?? '').trim().split('\n')[0] ?? 'git clone 失败' };
  }
  return { ok: true };
}

/**
 * 拉取 nacos 配置：先试 v1（含登录换 accessToken），失败再试 v2。
 * @returns 每个 dataId 的落盘结果。
 */
async function fetchNacos(nacos, outDir) {
  const base = nacos.url.replace(/\/$/, '');
  let token = null;
  if (nacos.username && nacos.password) {
    const login = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: nacos.username, password: nacos.password }),
    }).catch(() => null);
    if (login?.ok) token = (await login.json().catch(() => ({})))?.accessToken ?? null;
  }

  const results = [];
  const dir = path.join(outDir, 'nacos', nacos.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const dataId of nacos.dataIds ?? []) {
    for (const group of nacos.groups ?? ['DEFAULT_GROUP']) {
      const query = new URLSearchParams({ dataId, group });
      if (nacos.namespace) query.set('tenant', nacos.namespace);
      if (token) query.set('accessToken', token);
      const url = `${base}/v1/cs/configs?${query}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((error) => ({ ok: false, error }));
      if (response.ok !== true) {
        results.push({ dataId, group, ok: false, reason: response.error?.message ?? `HTTP ${response.status}` });
        continue;
      }
      const text = await response.text();
      if (text.trim() === '' || text.startsWith('config data not exist')) {
        results.push({ dataId, group, ok: false, reason: '配置不存在或为空' });
        continue;
      }
      const file = path.join(dir, `${group}__${dataId}`);
      fs.writeFileSync(file, text, 'utf8');
      results.push({ dataId, group, ok: true, file });
    }
  }
  return results;
}

/** 生成 mysql 的 MCP 配置片段（DSH cordis.patch.yml 用）。 */
function mysqlFragment(db) {
  const env = [
    `      MYSQL_HOST: ${db.host}`,
    `      MYSQL_PORT: '${db.port ?? 3306}'`,
    `      MYSQL_USER: ${db.username}`,
    `      MYSQL_PASS: ${db.password ?? ''}`,
    `      MYSQL_DB: ${db.database}`,
  ].join('\n');
  return [
    `# ${db.id}（${db.env ?? 'env'}）：数据库 MCP`,
    `# 注意：下面的 MCP server 包名是占位，请按团队实际使用的实现替换 args。`,
    `- id: mcp-mysql-${db.id}`,
    `  name: '@deepseek-ai/dsh-mcp-client'`,
    `  config:`,
    `    serverName: mysql_${db.id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20)}`,
    `    transport: stdio`,
    `    command: npx`,
    `    args: ['-y', '@benborla29/mcp-server-mysql']`,
    `    env:`,
    env,
    `    failOnStartupError: false`,
    '',
  ].join('\n');
}

/** 探测日志平台，生成取日志脚本骨架。 */
async function probeLogPlatform(log, outDir) {
  const dir = path.join(outDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const page = await fetch(log.url, { signal: AbortSignal.timeout(15_000) }).catch((error) => ({ ok: false, error }));
  const html = page.ok === true ? await page.text() : '';
  // 从页面与内联脚本里找 API 线索，找不到就退回"浏览器打开并搜索"。
  const candidates = [...new Set([...html.matchAll(/["'`](\/[a-zA-Z0-9_\-/]*(?:api|log|search|query)[a-zA-Z0-9_\-/]*)["'`]/g)].map((m) => m[1]))]
    .filter((value) => value.length < 80)
    .slice(0, 10);

  const report = {
    id: log.id,
    url: log.url,
    reachable: page.ok === true,
    status: page.status ?? null,
    apiCandidates: candidates,
  };
  fs.writeFileSync(path.join(dir, `${log.id}-probe.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const script = `#!/usr/bin/env node
/**
 * ${log.id} 日志拉取脚本（自动生成，需按实际接口补全）。
 *
 * 探测结果：${candidates.length === 0 ? '未在页面里发现候选 API' : `候选 API：${candidates.join(', ')}`}
 * ${candidates.length === 0 ? '→ 该平台大概率是前端渲染，需要用浏览器搜索或抓包拿到接口。' : '→ 从上面对候选里确认一个，替换下面的 endpoint。'}
 */
const endpoint = '${candidates[0] ?? `${log.url}/api/logs`}';
const params = new URLSearchParams({ q: process.argv[2] ?? '', size: '200' });
const headers = { accept: 'application/json', cookie: process.env.LOG_PLATFORM_COOKIE ?? '' };

const response = await fetch(\`\${endpoint}?\${params}\`, { headers });
if (!response.ok) {
  console.error('HTTP', response.status, '—— 检查 LOG_PLATFORM_COOKIE');
  process.exit(1);
}
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
`;
  const scriptFile = path.join(dir, `fetch-logs-${log.id}.mjs`);
  fs.writeFileSync(scriptFile, script, 'utf8');
  return { report, scriptFile, candidates };
}

function maskProfile(profile) {
  const clone = JSON.parse(JSON.stringify(profile));
  for (const group of ['databases', 'nacos', 'nexus']) {
    for (const item of clone[group] ?? []) if (item.password) item.password = MASK;
  }
  return clone;
}

async function main() {
  const [command, profilePath, ...rest] = process.argv.slice(2);
  if (!command || !profilePath) {
    console.log('用法：env-prep.mjs <validate|plan|apply> <profile.json> [--only a,b] [--out dir]');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(profilePath, 'utf8');
  const profile = JSON.parse(raw);
  const problems = validate(profile);

  if (command === 'validate') {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    process.exitCode = problems.length === 0 ? 0 : 1;
    return;
  }

  const onlyIndex = rest.indexOf('--only');
  const only = onlyIndex === -1 ? null : String(rest[onlyIndex + 1] ?? '').split(',').map((s) => s.trim());
  const outIndex = rest.indexOf('--out');
  const outDir = outIndex === -1 ? path.resolve('.env-prep') : rest[outIndex + 1];
  const modeIndex = rest.indexOf('--bookmark-mode');
  const bookmarkMode = modeIndex === -1 ? 'auto' : String(rest[modeIndex + 1] ?? 'auto');
  const apply = command === 'apply';

  const plan = buildPlan(profile);
  const selected = only === null ? plan : plan.filter((action) => only.includes(action.type));

  const output = { project: profile.project, apply, problems, outDir, plan: selected, results: [] };
  if (!apply) {
    console.log(JSON.stringify({ ...output, profile: maskProfile(profile) }, null, 2));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // 书签是一次性动作：把所有链接按分类并进同一个项目文件夹，不能逐条写文件。
  if (selected.some((action) => action.type === 'bookmark')) {
    try {
      output.results.push({ type: 'bookmark', ...applyBookmarks(profile, outDir, bookmarkMode) });
    } catch (error) {
      output.results.push({ type: 'bookmark', ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const action of selected) {
    if (action.type === 'bookmark') continue;
    try {
      if (action.type === 'clone') {
        const repo = list(profile, 'git').find((item) => item.id === action.target);
        output.results.push({ ...action, ...cloneRepo(repo) });
      } else if (action.type === 'nacos') {
        const nacos = list(profile, 'nacos').find((item) => item.id === action.target);
        output.results.push({ ...action, configs: await fetchNacos(nacos, outDir) });
      } else if (action.type === 'mcp') {
        const db = list(profile, 'databases').find((item) => item.id === action.target);
        const dir = path.join(outDir, 'mcp');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${db.id}.yaml`);
        fs.writeFileSync(file, mysqlFragment(db), 'utf8');
        output.results.push({ ...action, file });
      } else if (action.type === 'logs') {
        const log = list(profile, 'logs').find((item) => item.id === action.target);
        const probed = await probeLogPlatform(log, outDir);
        output.results.push({ ...action, ...probed, ok: probed.report.reachable });
      }
    } catch (error) {
      output.results.push({ ...action, ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify(output, null, 2));
  const failed = output.results.filter((item) => item.ok === false);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// 只有被当作脚本直接执行时才跑 main；被 import 时只导出纯函数（便于自检）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
