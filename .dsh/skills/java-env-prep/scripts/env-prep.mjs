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
  for (const entry of list('hosts')) {
    if (!entry.ip) problems.push(`hosts.${entry.ip ?? '?'} 缺少 ip`);
    if (!Array.isArray(entry.names) || entry.names.length === 0) problems.push(`hosts.${entry.ip ?? '?'} 缺少 names`);
  }
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

/** 系统 hosts 文件路径。 */
function hostsFile() {
  return process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}

/**
 * 绑定 hosts。
 *
 * 永远先写一份片段文件（不需要权限）；写系统 hosts 需要管理员，
 * 失败时把原因和"手工怎么做"一起返回，不静默失败。
 */
export function applyHosts(profile, outDir) {
  const hosts = list(profile, 'hosts');
  if (hosts.length === 0) return { ok: true, skipped: true, reason: 'profile 里没有 hosts 绑定' };

  const marker = `# >>> java-env-prep:${profile.project}`;
  const block = [marker, ...hosts.map((entry) => `${entry.ip}\t${entry.names.join(' ')}`), `# <<< java-env-prep:${profile.project}`].join('\n');

  const snippet = path.join(outDir, 'hosts', `${profile.project}.hosts.txt`);
  fs.mkdirSync(path.dirname(snippet), { recursive: true });
  fs.writeFileSync(snippet, `${block}\n`, 'utf8');

  const target = hostsFile();
  let existing;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return { ok: false, target, snippet, reason: `读不到 ${target}：${error.message}` };
  }
  if (existing.includes(marker)) {
    return { ok: true, target, snippet, skipped: true, reason: '已存在同名 hosts 段落，未重复写入' };
  }
  try {
    fs.appendFileSync(target, `\n${block}\n`, 'utf8');
    return { ok: true, target, snippet, entries: hosts.length };
  } catch (error) {
    return {
      ok: false,
      target,
      snippet,
      reason: `写入需要管理员权限：${error.message}`,
      manual: `以管理员身份把 ${snippet} 的内容追加到 ${target}`,
    };
  }
}

/**
 * 从已拉取的 nacos 配置里推断数据库名。
 *
 * 资料里经常只给 `IP:端口 + 账号`，不给库名；而应用自己的配置里几乎一定有
 * `jdbc:mysql://host:port/schema`。这里把 schema 抽出来，按"出现次数"排序：
 * - 某个库的 host:port 能对上 → 用那个 schema；
 * - 对不上 → 用出现最多的 schema 作为默认值，并列出其他候选。
 *
 * @param profile - env-profile。
 * @param outDir - 含 `nacos/` 的输出目录。
 * @returns `{ schemas, applied }`
 */
export function inferDatabases(profile, outDir) {
  const root = path.join(outDir, 'nacos');
  if (!fs.existsSync(root)) return { schemas: [], applied: [] };

  const schemaCount = new Map();
  const schemaHosts = new Map();
  const bump = (schema, host) => {
    schemaCount.set(schema, (schemaCount.get(schema) ?? 0) + 1);
    const hosts = schemaHosts.get(schema) ?? new Set();
    if (host !== undefined) hosts.add(host);
    schemaHosts.set(schema, hosts);
  };

  const scanFile = (file) => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const match of text.matchAll(/jdbc:mysql:\/\/([^/"'\s]+)\/([A-Za-z0-9_$]+)/g)) {
      const host = match[1];
      const schema = match[2];
      if (schema.startsWith('$')) continue; // 未解析的占位符
      bump(schema, host);
    }
  };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) scanFile(full);
    }
  };
  walk(root);

  // 并列时不能按字母序拍脑袋：先看"项目前缀"（jasolar_xxx 的 jasolar），
  // 带项目前缀的库更可能是主库，再比引用次数。
  const prefixCount = new Map();
  for (const item of schemaCount.keys()) {
    const prefix = item.split('_')[0];
    prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
  }
  const dominantPrefix = [...prefixCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const schemas = [...schemaCount.entries()]
    .map(([schema, count]) => ({
      schema,
      count,
      hosts: [...(schemaHosts.get(schema) ?? [])],
      projectPrefixed: dominantPrefix !== '' && schema.startsWith(`${dominantPrefix}_`),
    }))
    .sort(
      (a, b) =>
        Number(b.projectPrefixed) - Number(a.projectPrefixed) ||
        b.count - a.count ||
        a.schema.localeCompare(b.schema),
    );

  const fallback = schemas[0]?.schema ?? null;
  const applied = [];
  for (const db of list(profile, 'databases')) {
    const current = db.database ?? '';
    if (current !== '' && current !== '<待确认>') continue;
    const hostPort = db.port === undefined ? db.host : `${db.host}:${db.port}`;
    const matched = schemas.find((item) => item.hosts.includes(hostPort));
    const chosen = matched?.schema ?? fallback;
    if (chosen === null) continue;
    db.database = chosen;
    applied.push({ id: db.id, database: chosen, basis: matched === undefined ? 'most-frequent' : 'host-match' });
  }
  return { schemas, applied };
}

/**
 * 推断项目名。
 *
 * 优先用仓库名的公共前缀（`jasolar-common`、`jasolar-gateway` -> `jasolar`），
 * 因为团队通常按「项目-模块」命名；没有公共前缀时退回 git 组名（URL 最后一段）。
 *
 * @param profile - env-profile。
 * @returns 推断结果与依据。
 */
export function inferProjectName(profile) {
  const repos = list(profile, 'git').flatMap((entry) =>
    Array.isArray(entry.repos) && entry.repos.length > 0 ? entry.repos.map((repo) => repo.name) : [],
  );

  // 仓库名按 `-` 切段，统计第一段的出现频率。
  const counts = new Map();
  for (const name of repos) {
    const prefix = String(name).split('-')[0];
    if (prefix === '') continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [prefix, hits] = ranked[0] ?? [];
  if (prefix !== undefined && repos.length > 0 && hits / repos.length >= 0.6) {
    return { project: prefix, basis: 'repo-prefix', coverage: `${hits}/${repos.length}` };
  }

  const groupUrl = list(profile, 'git')[0]?.url ?? '';
  const group = groupUrl.split('/').filter(Boolean).pop() ?? '';
  if (group !== '') return { project: group, basis: 'git-group', coverage: '' };

  return { project: null, basis: 'none', coverage: '' };
}

/** 在 TTY 下带超时地读一行；非 TTY 或超时返回默认值。 */
function readLineWithTimeout(question, fallback, seconds) {
  if (!process.stdin.isTTY) return Promise.resolve({ value: fallback, timedOut: false, interactive: false });
  return new Promise((resolve) => {
    process.stderr.write(question);
    let settled = false;
    const finish = (value, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve({ value, timedOut, interactive: true });
    };
    const onData = (chunk) => {
      const answer = String(chunk).trim();
      finish(answer === '' ? fallback : answer, false);
    };
    const timer = setTimeout(() => finish(fallback, true), Math.max(1, seconds) * 1000);
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/**
 * 确保浏览器已退出。
 *
 * - 已经退出：直接返回；
 * - `--close-browser` 且 TTY：提示用户，`seconds` 秒内不回复就强制关闭；
 * - 非 TTY：不动用户进程，交给上层退回 HTML 导出。
 *
 * @returns `{ closed, forced, reason }`
 */
export async function ensureBrowserClosed(browser, { seconds = 30, allow = false, force = false } = {}) {
  if (!browserRunning(browser)) return { closed: true, forced: false };
  if (!allow) {
    return { closed: false, forced: false, reason: `${browser} 正在运行；未授权关闭（加 --close-browser 允许）` };
  }
  const image = BROWSER_PROCESS[browser] ?? `${browser}.exe`;
  const kill = () => {
    spawnSync('taskkill', ['/IM', image, '/F'], { stdio: 'ignore', timeout: 30_000 });
  };

  // --force-close：同意已经在对话里拿到，不再要求终端，直接关。
  if (force) {
    kill();
    for (let i = 0; i < 20 && browserRunning(browser); i += 1) await new Promise((r) => setTimeout(r, 250));
    return { closed: !browserRunning(browser), forced: true, reason: browserRunning(browser) ? '关闭失败' : undefined };
  }

  const answer = await readLineWithTimeout(
    `\n${browser} 正在运行，需要关闭才能直接写书签。${seconds} 秒内回复 y 关闭，超时后强制关闭：`,
    'y',
    seconds,
  );
  if (!answer.interactive) {
    return {
      closed: false,
      forced: false,
      reason: '非交互环境，未关闭浏览器（对话里确认后加 --force-close 可直接关闭）',
    };
  }
  if (answer.value.toLowerCase() === 'n') {
    return { closed: false, forced: false, reason: '用户选择不关闭浏览器' };
  }
  kill();
  for (let i = 0; i < 20 && browserRunning(browser); i += 1) await new Promise((r) => setTimeout(r, 250));
  const closed = !browserRunning(browser);
  return { closed, forced: true, reason: closed ? undefined : '关闭失败' };
}

/** 生成动作清单。 */
function buildPlan(profile) {
  const actions = [];

  if (list(profile, 'hosts').length > 0) {
    actions.push({ type: 'hosts', target: profile.project, detail: `${list(profile, 'hosts').length} 条绑定` });
  }

  for (const env of list(profile, 'environments')) {
    actions.push({ type: 'bookmark', category: env.category ?? '环境', target: env.id, label: env.name ?? env.id, url: env.url });
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
  for (const entry of list(profile, 'git')) {
    // 仓库组（Gitea/GitLab 的 org）一次列出多个仓库，逐个展开成独立动作。
    const repos = Array.isArray(entry.repos) && entry.repos.length > 0 ? entry.repos : [entry];
    for (const repo of repos) {
      const name = repo.name ?? entry.id;
      const dir = expandHome(repo.dir ?? path.join(entry.dir ?? '.', name));
      actions.push({
        type: 'clone',
        target: name,
        entryId: entry.id,
        detail: `${repo.url ?? `${entry.url}/${name}.git`} -> ${dir}`,
        exists: fs.existsSync(dir),
      });
    }
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
export function browserRunning(browser) {
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
  const buckets = new Map();
  const add = (category, entry) => {
    const list_ = buckets.get(category) ?? [];
    list_.push(entry);
    buckets.set(category, list_);
  };
  for (const item of list(profile, 'environments')) {
    add(item.category ?? '环境', { name: item.name ?? item.id, url: item.url });
  }
  for (const item of list(profile, 'nacos')) add('配置中心', { name: item.id, url: item.url });
  for (const item of list(profile, 'nexus')) add('制品库', { name: item.id, url: item.url });
  for (const item of list(profile, 'logs')) add('日志', { name: item.note ?? item.id, url: item.url });

  // 同一个 URL 出现多次（如 dev/qa/uat 共用一个 nacos 控制台）时合并成一条，
  // 名称拼起来，避免书签里出现一条叫 "nacos-dev" 却代表所有环境。
  return [...buckets.entries()].map(([name, entries]) => {
    const byUrl = new Map();
    for (const entry of entries) {
      const merged = byUrl.get(entry.url);
      if (merged === undefined) {
        byUrl.set(entry.url, { ...entry, names: [entry.name] });
        continue;
      }
      if (!merged.names.includes(entry.name)) merged.names.push(entry.name);
    }
    return {
      name,
      entries: [...byUrl.values()].map((entry) => {
        // 合并同一 URL 的名称时，丢掉被其他名称包含的短名（"nexus" 被 "nexus 制品库" 吞掉）。
        const names = entry.names.filter(
          (candidate) => !entry.names.some((other) => other !== candidate && other.toLowerCase().includes(candidate.toLowerCase())),
        );
        return { url: entry.url, name: names.join(' / ') };
      }),
    };
  });
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
  // 项目改名后（jasolar-scfp -> jasolar）复用旧文件夹并改名，避免书签栏里出现两个。
  let existing = root.children.find((child) => child.type === 'folder' && child.name === profile.project);
  if (existing === undefined) {
    const legacy = root.children.find(
      (child) => child.type === 'folder' && child.name.startsWith(`${profile.project}-`),
    );
    if (legacy !== undefined) {
      legacy.name = profile.project;
      existing = legacy;
    }
  }
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
  let renamed = 0;
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
      const existingEntry = folder.children.find((child) => child.url === entry.url);
      if (existingEntry !== undefined) {
        // 同 URL 已在：只更新名称（例如把 "nacos-dev" 修正为 "nacos (dev/qa/uat)"）。
        if (existingEntry.name !== entry.name) {
          existingEntry.name = entry.name;
          renamed += 1;
        }
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
  return { folder: projectFolder.name, added, skipped, renamed };
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
export async function applyBookmarks(profile, outDir, mode = 'auto', options = {}) {
  const groups = bookmarkTree(profile);
  if (groups.length === 0) return { ok: true, skipped: true, reason: 'profile 里没有可收藏的地址' };

  const candidates = bookmarkCandidates();
  const target = candidates[0];
  const wantFile = mode === 'file' || (mode === 'auto' && candidates.length > 0);
  let closed = { closed: true, forced: false };

  if (wantFile && target !== undefined && browserRunning(target.browser)) {
    closed = await ensureBrowserClosed(target.browser, {
      seconds: options.closeTimeout ?? 30,
      allow: options.allowClose === true,
      force: options.forceClose === true,
    });
  }

  if (wantFile && target !== undefined && closed.closed) {
    const raw = fs.readFileSync(target.file, 'utf8');
    const doc = JSON.parse(raw);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(outDir, 'bookmarks', `${target.browser}-Bookmarks.${stamp}.bak.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, raw, 'utf8');
    const stats = mergeBookmarks(doc, profile, groups);
    fs.writeFileSync(target.file, JSON.stringify(doc), 'utf8');
    return {
      ok: true,
      mode: 'file',
      browser: target.browser,
      file: target.file,
      backup,
      forcedClose: closed.forced,
      ...stats,
    };
  }

  // 兜底：导出可导入的 HTML，不碰浏览器数据。
  const file = path.join(outDir, 'bookmarks', `${profile.project}-bookmarks.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bookmarkHtml(profile, groups), 'utf8');
  return {
    ok: true,
    mode: 'html',
    file,
    reason:
      target === undefined
        ? '没有检测到 Chromium 系浏览器'
        : (closed.reason ?? `${target.browser} 正在运行，直接改文件会被覆盖`),
    groups: groups.map((group) => ({ name: group.name, count: group.entries.length })),
  };
}

/**
 * 克隆一个仓库。
 *
 * 带凭据时先拼进 URL 完成认证，克隆成功后立刻把 origin 改回无凭据地址，
 * 避免账号密码留在 .git/config 里。
 *
 * @param repo - `{ name, url?, dir?, branch? }`
 * @param entry - 所属的 git 配置项（含 url/dir/depth/username/password）
 */
function cloneRepo(repo, entry) {
  const dir = expandHome(repo.dir ?? path.join(entry.dir, repo.name));
  if (fs.existsSync(dir)) return { ok: true, skipped: true, reason: '目录已存在' };

  const cleanUrl = repo.url ?? `${entry.url.replace(/\/$/, '')}/${repo.name}.git`;
  let authUrl = cleanUrl;
  if (entry.username) {
    const parsed = new URL(cleanUrl);
    parsed.username = encodeURIComponent(entry.username);
    parsed.password = encodeURIComponent(entry.password ?? '');
    authUrl = parsed.toString();
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone', '--single-branch'];
  if (entry.depth) args.push('--depth', String(entry.depth));
  const branch = repo.branch ?? entry.branch;
  if (branch && branch !== '<待确认>') args.push('--branch', branch);
  args.push(authUrl, dir);

  const result = spawnSync('git', args, { stdio: 'pipe', timeout: 600_000, encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = (result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? 'git clone 失败';
    return { ok: false, reason };
  }
  if (authUrl !== cleanUrl) {
    spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', cleanUrl], { stdio: 'ignore', timeout: 15_000 });
  }
  return { ok: true, dir };
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
  // 有 configs 就按 (dataId, group) 精确成对拉取；否则退回 dataIds × groups 的笛卡尔积。
  const pairs =
    Array.isArray(nacos.configs) && nacos.configs.length > 0
      ? nacos.configs.map((item) => ({ dataId: item.dataId, group: item.group ?? 'DEFAULT_GROUP' }))
      : (nacos.dataIds ?? []).flatMap((dataId) =>
          (nacos.groups ?? ['DEFAULT_GROUP']).map((group) => ({ dataId, group })),
        );

  for (const { dataId, group } of pairs) {
    {
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
    console.log('用法：env-prep.mjs <validate|plan|apply|infer> <profile.json> [选项]');
    console.log('  --only a,b            只执行指定动作（bookmark/clone/nacos/mcp/logs/hosts）');
    console.log('  --out dir             输出目录，默认 ./.env-prep');
    console.log('  --project <name>      覆盖项目名（默认从仓库前缀或 git 组名推断）');
    console.log('  --database <name>     infer 时强制指定库名');
    console.log('  --bookmark-mode a|b   auto/file/html，默认 auto');
    console.log('  --close-browser       允许为写书签关闭浏览器（终端里会提示等待）');
    console.log('  --force-close         同意已在对话里拿到，直接关闭，不再要求终端');
    console.log('  --confirm-timeout 30  关闭浏览器的确认等待秒数，超时强制关闭');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(profilePath, 'utf8');
  const profile = JSON.parse(raw);
  const problems = validate(profile);

  // 项目名：--project 显式指定 > profile 已有 > 推断（仓库前缀 / git 组名）。
  const projectIndex = rest.indexOf('--project');
  const forcedProject = projectIndex === -1 ? '' : String(rest[projectIndex + 1] ?? '').trim();
  const inferredProject = inferProjectName(profile);
  if (forcedProject !== '') profile.project = forcedProject;
  else if (!profile.project || profile.project === '<待确认>') profile.project = inferredProject.project ?? profile.project;

  if (command === 'validate') {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    process.exitCode = problems.length === 0 ? 0 : 1;
    return;
  }

  // 输出目录优先级：--out > profile.outDir > ./.env-prep
  const resolveOutDir = () => {
    const index = rest.indexOf('--out');
    if (index !== -1) return rest[index + 1];
    if (typeof profile.outDir === 'string' && profile.outDir !== '') return profile.outDir;
    return path.resolve('.env-prep');
  };
  const inferOut = resolveOutDir();

  if (command === 'infer') {
    const result = inferDatabases(profile, inferOut);
    // 一个 MySQL 实例上通常有多个 schema，自动推断只能给"最可能"的那个；
    // --database 让人显式覆盖，避免把猜测当结论。
    const dbIndex = rest.indexOf('--database');
    const forced = dbIndex === -1 ? null : (rest[dbIndex + 1] ?? '').trim();
    if (forced !== null && forced !== '') {
      for (const db of list(profile, 'databases')) db.database = forced;
      result.applied = list(profile, 'databases').map((db) => ({ id: db.id, database: db.database, basis: 'forced' }));
    }
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    console.log(
      JSON.stringify(
        {
          project: profile.project,
          projectBasis: forcedProject !== '' ? 'forced' : inferredProject.basis,
          topSchemas: result.schemas.slice(0, 8),
          applied: result.applied,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.applied.length === 0 ? 1 : 0;
    return;
  }

  const onlyIndex = rest.indexOf('--only');
  const only = onlyIndex === -1 ? null : String(rest[onlyIndex + 1] ?? '').split(',').map((s) => s.trim());
  const outDir = resolveOutDir();
  const modeIndex = rest.indexOf('--bookmark-mode');
  const bookmarkMode = modeIndex === -1 ? 'auto' : String(rest[modeIndex + 1] ?? 'auto');
  const allowClose = rest.includes('--close-browser');
  const forceClose = rest.includes('--force-close');
  const timeoutIndex = rest.indexOf('--confirm-timeout');
  const closeTimeout = timeoutIndex === -1 ? 30 : Number(rest[timeoutIndex + 1]) || 30;
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
      output.results.push({
        type: 'bookmark',
        ...(await applyBookmarks(profile, outDir, bookmarkMode, { allowClose, forceClose, closeTimeout })),
      });
    } catch (error) {
      output.results.push({ type: 'bookmark', ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const action of selected) {
    if (action.type === 'bookmark') continue;
    try {
      if (action.type === 'hosts') {
        output.results.push({ ...action, ...applyHosts(profile, outDir) });
      } else if (action.type === 'clone') {
        const entry = list(profile, 'git').find((item) => item.id === action.entryId);
        const repo = (entry.repos ?? []).find((item) => (item.name ?? entry.id) === action.target) ?? { name: action.target };
        output.results.push({ ...action, ...cloneRepo(repo, entry) });
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
