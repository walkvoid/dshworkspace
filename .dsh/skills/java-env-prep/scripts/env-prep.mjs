#!/usr/bin/env node
/**
 * 环境准备：把一份 env-profile.json 变成一串可执行动作。
 *
 *   node env-prep.mjs validate <profile.json>
 *   node env-prep.mjs plan     <profile.json>          # 只打印计划，不执行
 *   node env-prep.mjs apply    <profile.json> [--only open,clone,nacos,logs]
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

  // 并列时不能按字母序拍脑袋：先看"库名前缀"（同一个项目常是多个同前缀的库），
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
 * 优先取仓库名的第一段（按 `-` 切分）作公共前缀，覆盖 ≥60% 时才采用；
 * 工程怎么命名都行，不假设固定的模块后缀；没有公共前缀时退回 git 组名（URL 最后一段）。
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
function buildPlan(profile, options = {}) {
  const actions = [];
  const missingPlatforms = missingPlatformKinds(profile);

  // 缺日志/发布/缺陷平台时，先探测入口；探测结果会新增书签与日志脚本动作。
  if (missingPlatforms.length > 0 && options.autoDiscover !== false) {
    actions.push({
      type: 'discover',
      target: 'platforms',
      detail: `缺少 ${missingPlatforms.map((kind) => PLATFORM_KINDS[kind]).join('/')} 平台：自动探测并保存入口`,
    });
  }

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
    actions.push({
      type: 'logs',
      target: log.id,
      detail: log.tools ? `转发已探明的站点脚本 ${log.tools}` : '探测接口并生成取日志脚本',
    });
  }
  for (const kind of ['release', 'bug']) {
    for (const item of list(profile, kind)) {
      actions.push({
        type: 'bookmark',
        category: kind === 'release' ? '发布' : '缺陷',
        target: item.id ?? item.site,
        label: item.name ?? item.note ?? item.id,
        url: item.url,
      });
    }
  }
  // 手写在 profile.platforms 里、但没进 logs/release/bug 的入口，也补一条书签。
  for (const kind of PLATFORM_ORDER) {
    const value = profile.platforms?.[kind];
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of entries) {
      if (!isHttpUrl(entry.url)) continue;
      const collected = kind === 'log' ? list(profile, 'logs') : list(profile, kind);
      if (collected.some((item) => item.url === entry.url || item.site === entry.site)) continue;
      actions.push({
        type: 'bookmark',
        category: kind === 'log' ? '日志' : kind === 'release' ? '发布' : '缺陷',
        target: entry.site ?? kind,
        label: entry.name ?? entry.site ?? kind,
        url: entry.url,
      });
    }
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
  // 数据库的 MCP 条目不再由本技能生成/写入：apply 结果里会带 mcpHint，指向 profile 的
  // cordis.patch.yml，由用户（或 agent 按 SKILL.md 的模板）手写进去。
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
  for (const item of list(profile, 'logs')) add('日志', { name: item.note ?? item.name ?? item.id, url: item.url });
  for (const item of list(profile, 'release')) add('发布', { name: item.name ?? item.note ?? item.id, url: item.url });
  for (const item of list(profile, 'bug')) add('缺陷', { name: item.name ?? item.note ?? item.id, url: item.url });
  // 只写在 profile.platforms、没进数组的入口也进书签，避免“探测到了却没地方点”。
  for (const kind of PLATFORM_ORDER) {
    const value = profile.platforms?.[kind];
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of entries) {
      if (!isHttpUrl(entry.url)) continue;
      const collected = kind === 'log' ? list(profile, 'logs') : list(profile, kind);
      if (collected.some((item) => item.url === entry.url || item.site === entry.site)) continue;
      add(kind === 'log' ? '日志' : kind === 'release' ? '发布' : '缺陷', {
        name: entry.name ?? entry.site ?? kind,
        url: entry.url,
      });
    }
  }

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
  // 项目改名后（旧名 -> 新名）复用旧文件夹并改名，避免书签栏里出现两个。
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
 * 在已克隆的仓库里切到“正在开发”的远端分支。
 *
 * 三种策略：
 *   active（默认）：排除远端默认分支后，取最新提交的那条——默认分支通常是发布线，功能分支才是开发面；
 *   latest       ：所有分支里取最新提交（可能选中默认分支）；
 *   profile      ：不切，保持 profile 的 branch / 远端默认分支。
 *
 * Git 不记录分支创建时间，所有策略都只能用分支最新提交时间（committerdate）近似。
 *
 * @param dir - 仓库目录。
 * @param strategy - active | latest。
 */
/** 选分支：返回候选、默认分支、目标分支与当前分支，不做任何写操作（dry-run 也用这个）。 */
function branchPlan(dir, strategy = 'active') {
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', timeout: 30_000, encoding: 'utf8' });
  const listed = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:iso8601)', 'refs/remotes/origin']);
  if (listed.status !== 0) {
    return { error: (listed.stderr ?? '').trim().split('\n').pop() ?? '读取远端分支失败' };
  }
  const branches = (listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref, date] = line.split('|');
      return { branch: ref.replace(/^origin\//, ''), date };
    })
    .filter((item) => item.branch && item.branch !== 'HEAD');
  if (branches.length === 0) return { error: '没有可用的远端分支' };

  const headRef = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = headRef.status === 0 ? (headRef.stdout ?? '').trim().replace(/^origin\//, '') : '';
  const picked = strategy === 'latest'
    ? branches[0]
    : (branches.find((item) => item.branch !== defaultBranch) ?? branches[0]);
  const current = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? '').trim();
  return { git, branches, defaultBranch, picked, current };
}

function switchToLatestBranch(dir, strategy = 'active') {
  const plan = branchPlan(dir, strategy);
  if (plan.error) return { changed: false, reason: plan.error };
  const { git, branches, defaultBranch, picked, current } = plan;
  const detail = {
    strategy,
    basis: 'committerdate',
    basisNote: strategy === 'latest'
      ? 'Git 不记录分支创建时间，已在全部远端分支里取最新提交'
      : 'Git 不记录分支创建时间，已排除默认分支后取最新提交（默认分支通常是发布线）',
    defaultBranch: defaultBranch || null,
    branch: picked.branch,
    date: picked.date,
    candidates: branches.length,
    top: branches.slice(0, 3),
  };
  if (current === picked.branch) return { changed: false, ...detail, note: '已在目标分支' };

  let checkout = git(['switch', '-C', picked.branch, '--track', `origin/${picked.branch}`]);
  if (checkout.status !== 0) {
    // 旧版 git 没有 switch，退回 checkout -B。
    checkout = git(['checkout', '-B', picked.branch, `origin/${picked.branch}`]);
  }
  if (checkout.status !== 0) {
    return { changed: false, ...detail, reason: (checkout.stderr ?? '').trim().split('\n').pop() ?? '切换分支失败' };
  }
  return { changed: true, from: current, ...detail };
}

/**
 * 拉取远端分支。clone 时若是 --single-branch（老版本行为），本地只有默认分支的引用，
 * 必须先 fetch 才能比较“哪条分支最新”。优先用 origin；需要认证时用 profile 的账号密码
 * 现拼一个 URL 只用于这一次 fetch（不写进 .git/config）。
 */
function fetchBranches(dir, entry, repo, timeout = 30_000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const refspec = '+refs/heads/*:refs/remotes/origin/*';
  const plain = spawnSync('git', ['-C', dir, 'fetch', '--prune', 'origin', refspec], { encoding: 'utf8', timeout, env });
  if (plain.status === 0) return 'ok';
  if (!entry.username) return 'failed';
  try {
    const cleanUrl = repo.url ?? `${entry.url.replace(/\/$/, '')}/${repo.name}.git`;
    const parsed = new URL(cleanUrl);
    parsed.username = encodeURIComponent(entry.username);
    parsed.password = encodeURIComponent(entry.password ?? '');
    const authed = spawnSync('git', ['-C', dir, 'fetch', '--prune', parsed.toString(), refspec], { encoding: 'utf8', timeout, env });
    return authed.status === 0 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * 对已克隆的仓库套用分支策略（克隆后规则的手动版）。
 *
 * 只切干净的工作区：有未提交改动就跳过，绝不 stash / 覆盖。
 */
function switchAllBranches(profile, options = {}) {
  const strategy = options.branchStrategy ?? 'active';
  const results = [];
  for (const entry of list(profile, 'git')) {
    for (const repo of entry.repos ?? []) {
      const dir = expandHome(repo.dir ?? path.join(entry.dir, repo.name));
      const name = repo.name ?? entry.id;
      if (!fs.existsSync(dir)) {
        results.push({ repo: name, skipped: true, reason: '目录不存在' });
        continue;
      }
      const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 20_000 });
      if (status.status !== 0) {
        results.push({ repo: name, ok: false, reason: 'git status 失败' });
        continue;
      }
      if ((status.stdout ?? '').trim() !== '') {
        results.push({ repo: name, skipped: true, reason: '工作区有改动，跳过' });
        continue;
      }
      let fetch = 'ok';
      if (options.fetch !== false) fetch = fetchBranches(dir, entry, repo, options.fetchTimeout ?? 30_000);
      if (options.dryRun) {
        const plan = branchPlan(dir, strategy);
        results.push(plan.error
          ? { repo: name, dryRun: true, fetch, ok: false, reason: plan.error }
          : { repo: name, dryRun: true, fetch, current: plan.current, branch: plan.picked.branch, date: plan.picked.date, defaultBranch: plan.defaultBranch || null, candidates: plan.branches.length });
        continue;
      }
      results.push({ repo: name, fetch, ...switchToLatestBranch(dir, strategy) });
    }
  }
  const failed = results.filter((item) => item.ok === false || (item.reason && !item.skipped));
  return {
    strategy,
    dryRun: options.dryRun === true,
    summary: {
      total: results.length,
      switched: results.filter((item) => item.changed).length,
      already: results.filter((item) => item.changed === false && !item.reason).length,
      skipped: results.filter((item) => item.skipped).length,
      failed: failed.length,
      fetchFailed: results.filter((item) => item.fetch === 'failed').length,
    },
    results,
  };
}

/**
 * 克隆一个仓库。
 *
 * 带凭据时先拼进 URL 完成认证，克隆成功后立刻把 origin 改回无凭据地址，
 * 避免账号密码留在 .git/config 里。
 *
 * 默认（branchStrategy=active）克隆后切到「默认分支之外、最新提交」的远端分支；
 * latest 取全部分支里最新的；--keep-branch（branchStrategy=profile）保持 profile 的 branch / 远端默认分支。
 *
 * @param repo - `{ name, url?, dir?, branch? }`
 * @param entry - 所属的 git 配置项（含 url/dir/depth/username/password）
 * @param options - `{ branchStrategy }`
 */
/**
 * 探测远端仓库最后一次提交时间（不落盘、不改工作区）。
 *
 * 用 `--filter=blob:none` 的浅取只拉提交与树，不拉文件内容；服务端不支持 filter 时退回 `--depth 1`。
 *
 * @returns `{ ok: true, epochMs, iso }` 或 `{ ok: false, reason }`
 */
function probeLastCommit(url, timeout = 90_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-prep-probe-'));
  try {
    spawnSync('git', ['init', '-q', '--bare', dir], { stdio: 'ignore', timeout: 15_000 });
    const refspec = '+HEAD:refs/heads/probe';
    const fetchOnce = (extra) => spawnSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', '--no-tags', ...extra, url, refspec], {
      stdio: 'pipe', timeout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let fetched = fetchOnce(['--filter=blob:none']);
    if (fetched.status !== 0) fetched = fetchOnce([]);
    if (fetched.status !== 0) {
      return { ok: false, reason: (fetched.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? '探测提交时间失败' };
    }
    const log = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%ct|%cI', 'refs/heads/probe'], { encoding: 'utf8', timeout: 15_000 });
    if (log.status !== 0) return { ok: false, reason: '读取提交时间失败' };
    const [seconds, iso] = (log.stdout ?? '').trim().split('|');
    const epochMs = Number(seconds) * 1000;
    if (!Number.isFinite(epochMs) || epochMs <= 0) return { ok: false, reason: '提交时间不可解析' };
    return { ok: true, epochMs, iso };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
}

function cloneRepo(repo, entry, options = {}) {
  const dir = expandHome(repo.dir ?? path.join(entry.dir, repo.name));
  if (fs.existsSync(dir)) return { ok: true, skipped: true, reason: '目录已存在' };

  const strategy = options.branchStrategy ?? 'active';
  const cleanUrl = repo.url ?? `${entry.url.replace(/\/$/, '')}/${repo.name}.git`;
  let authUrl = cleanUrl;
  if (entry.username) {
    const parsed = new URL(cleanUrl);
    parsed.username = encodeURIComponent(entry.username);
    parsed.password = encodeURIComponent(entry.password ?? '');
    authUrl = parsed.toString();
  }

  // 长期无提交的仓库默认不克隆：先探一次最后提交时间（不落盘），过期就跳过。
  const maxAgeDays = options.maxAgeDays ?? 30;
  let lastCommit = null;
  let ageUnknown = false;
  if (maxAgeDays > 0) {
    const probe = probeLastCommit(authUrl);
    if (probe.ok) {
      lastCommit = probe.iso;
      const ageDays = (Date.now() - probe.epochMs) / 86_400_000;
      if (ageDays > maxAgeDays) {
        return {
          ok: true,
          skipped: true,
          lastCommit,
          reason: `最近 ${maxAgeDays} 天内没有提交（最后提交 ${probe.iso.slice(0, 10)}），默认不克隆；要拉就加 --max-age 0`,
        };
      }
    } else {
      ageUnknown = true;
    }
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone'];
  const branch = repo.branch ?? entry.branch;
  if (strategy !== 'profile') {
    // 要能列出全部远端分支才能比时间，所以不能加 --single-branch。
    // 注意 --depth 默认隐含 --single-branch，这里必须显式关掉，否则只能看到默认分支。
    args.push('--no-single-branch');
  } else {
    args.push('--single-branch');
    if (branch && branch !== '<待确认>') args.push('--branch', branch);
  }
  if (entry.depth) args.push('--depth', String(entry.depth));
  args.push(authUrl, dir);

  const result = spawnSync('git', args, { stdio: 'pipe', timeout: 600_000, encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = (result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? 'git clone 失败';
    return { ok: false, reason };
  }
  if (authUrl !== cleanUrl) {
    spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', cleanUrl], { stdio: 'ignore', timeout: 15_000 });
  }
  if (strategy === 'profile') return { ok: true, dir, lastCommit, ageUnknown };

  const switched = switchToLatestBranch(dir, strategy);
  return { ok: true, dir, branch: switched, lastCommit, ageUnknown };
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

/** 探测日志平台，生成取日志脚本骨架；已有站点脚本时生成转发脚本，避免重复造轮子。 */
async function probeLogPlatform(log, outDir, projectDir = null) {
  const dir = path.join(outDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });

  // 平台探测已经把入口指到站点脚本（如 .env-prep/tools/beecloud/beecloud.mjs）：直接转发现成能力。
  if (typeof log.tools === 'string' && log.tools !== '' && projectDir) {
    const toolsAbs = path.resolve(projectDir, log.tools);
    if (fs.existsSync(toolsAbs)) {
      const rel = path.relative(dir, toolsAbs).replace(/\\/g, '/');
      const scriptFile = path.join(dir, `fetch-logs-${log.id}.mjs`);
      const script = `#!/usr/bin/env node
/**
 * ${log.id} 日志拉取脚本：转发现有站点脚本（自动生成）。
 *
 * 站点脚本：${log.tools}
 * 用法：node fetch-logs-${log.id}.mjs [--query ERROR] [--hours 1] [--size 20]
 *      不带参数时默认 search --hours 1。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteScript = path.resolve(here, '${rel}');
const args = process.argv.slice(2);
const passThrough = args.length > 0 ? args : ['search', '--hours', '1'];
const result = spawnSync(process.execPath, [siteScript, ...passThrough], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;
      fs.writeFileSync(scriptFile, script, 'utf8');
      const report = {
        id: log.id,
        url: log.url,
        reachable: true,
        mode: 'site-script',
        tools: log.tools,
        script: scriptFile,
      };
      fs.writeFileSync(path.join(dir, `${log.id}-probe.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      return { report, scriptFile, candidates: [], tools: log.tools };
    }
  }

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
  for (const group of ['databases', 'nacos', 'nexus', 'logs', 'release', 'bug']) {
    for (const item of clone[group] ?? []) if (item.password) item.password = MASK;
  }
  for (const kind of Object.keys(clone.platforms ?? {})) {
    const value = clone.platforms[kind];
    for (const item of Array.isArray(value) ? value : value ? [value] : []) {
      if (item.password) item.password = MASK;
    }
  }
  return clone;
}

// ---------------------------------------------------------------- 平台探测（日志 / 发布 / 缺陷）

/**
 * 平台探测的目标：日志 / 发布 / 缺陷——真实 Java 项目基本绕不开的三类平台。
 *
 * 用户没写这三类平台的入口时，按证据链自动找，并把结果保存下来供后续直接使用：
 *   项目站点脚本 > profile 已保存 > 用户提供 > 已知平台套件 > 页面特征
 *   > 平台登记表 > 浏览器书签 > 同域候选探测
 *
 * 产物：
 *   <outDir>/platforms.json                 本次探测结果（kind → 主入口 + alternates）
 *   <outDir>/.platforms.json                平台登记表（只存 URL 与类型，不含凭据；跨次探测复用）
 *   profile.platforms / logs / release / bug 主入口合并回 env-profile.json
 *
 * 安全边界：同域候选探测只使用「已知平台名 + profile 里出现过的协议/端口」，预算上限默认 24 次；
 * 不发验证码、不试密码；`--no-probe` / `--no-scan` / `--no-bookmarks` 可逐项关闭。
 */

export const PLATFORM_KINDS = { log: '日志', release: '发布', bug: '缺陷' };
export const PLATFORM_ORDER = Object.keys(PLATFORM_KINDS);

const PLATFORM_KEYWORDS = {
  log: {
    zh: ['日志', '监控', '可观测', '应用观测'],
    en: ['log', 'logs', 'kibana', 'grafana', 'loki', 'elk', 'sls', 'observe', 'observability'],
  },
  release: {
    zh: ['发布', '部署', '流水线', '构建'],
    en: ['release', 'deploy', 'jenkins', 'argo', 'pipeline', 'cicd', 'devops', 'build'],
  },
  bug: {
    zh: ['缺陷', '禅道'],
    en: ['bug', 'bugs', 'jira', 'redmine', 'taiga', 'issue', 'issues'],
  },
};

/** 证据来源的优先级：数字越大越可信，最终用于给同一类型的多个候选排序。 */
const CONFIDENCE = {
  script: { score: 100, label: '项目站点脚本' },
  saved: { score: 90, label: 'profile 已保存' },
  provided: { score: 80, label: '用户提供' },
  suite: { score: 70, label: '已知平台套件' },
  signature: { score: 60, label: '页面特征' },
  registry: { score: 50, label: '平台登记表' },
  bookmark: { score: 40, label: '浏览器书签' },
  hostname: { score: 30, label: '域名推断' },
};

/**
 * 已知平台套件：一个站点承载一类或多类平台。
 * match 只看 host 与 name；正文只用于 PLATFORM_SIGNATURES，避免“正文提了一句”就误判。
 */
const KNOWN_SITES = [
  {
    id: 'beecloud',
    name: 'BeeCloud',
    kinds: ['log', 'release'],
    match: (site) => /beecloud/i.test(`${site.host} ${site.name}`),
    apis: { log: '/u5/api/v1/auth/me' },
    note: 'BeeCloud：应用观测=日志、DevOps=发布；子路径登录后确认',
  },
  {
    id: 'aio',
    name: 'AIO 一体化平台',
    kinds: ['bug'],
    match: (site) => /(^|[^a-z0-9])aio([^a-z0-9]|$)/i.test(`${site.host} ${site.name}`) || /一体化平台/i.test(site.name),
    apis: { bug: '/sys-web/oauth2/login' },
    note: 'AIO：缺陷/项目管理（OAuth2 登录）',
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    kinds: ['release'],
    match: (site) => /(^|[^a-z0-9])jenkins([^a-z0-9]|$)/i.test(`${site.host} ${site.name}`),
    apis: { release: '/api/json' },
    note: 'Jenkins 流水线（发布/构建）',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    kinds: ['log'],
    match: (site) => /grafana/i.test(`${site.host} ${site.name}`),
    apis: { log: '/api/health' },
    note: 'Grafana 监控/日志',
  },
  {
    id: 'kibana',
    name: 'Kibana',
    kinds: ['log'],
    match: (site) => /kibana/i.test(`${site.host} ${site.name}`),
    apis: { log: '/api/status' },
    note: 'Kibana / ELK',
  },
  {
    id: 'jira',
    name: 'Jira',
    kinds: ['bug'],
    match: (site) => /(^|[^a-z0-9])jira([^a-z0-9]|$)|atlassian/i.test(`${site.host} ${site.name}`),
    apis: { bug: '/rest/api/2/myself' },
    note: 'Jira 缺陷/需求',
  },
  {
    id: 'zentao',
    name: '禅道',
    kinds: ['bug'],
    match: (site) => /zentao|禅道/i.test(`${site.host} ${site.name}`),
    note: '禅道缺陷管理',
  },
  {
    id: 'tapd',
    name: 'TAPD',
    kinds: ['bug'],
    match: (site) => /tapd/i.test(`${site.host} ${site.name}`),
    note: 'TAPD 缺陷/需求',
  },
  {
    id: 'redmine',
    name: 'Redmine',
    kinds: ['bug'],
    match: (site) => /redmine/i.test(`${site.host} ${site.name}`),
    note: 'Redmine 缺陷跟踪',
  },
  {
    id: 'argocd',
    name: 'Argo CD',
    kinds: ['release'],
    match: (site) => /(^|[^a-z0-9])argo([^a-z0-9]|$)/i.test(`${site.host} ${site.name}`),
    apis: { release: '/api/version' },
    note: 'Argo CD 发布/部署',
  },
];

const PLATFORM_SIGNATURES = [
  { kinds: ['log'], test: (text) => /grafana|kibana|elastic\s*search|日志检索|应用观测|beelog|log-retrieval/i.test(text) },
  { kinds: ['release'], test: (text) => /jenkins|argo\s*cd|流水线|发布平台|持续交付|devops|pipeline/i.test(text) },
  { kinds: ['bug'], test: (text) => /qabug|缺陷|bug\s*管理|jira|redmine|禅道|一体化平台/i.test(text) },
];

const SAME_DOMAIN_LABELS = {
  log: ['beecloud', 'logs', 'log', 'grafana', 'kibana'],
  release: ['beecloud', 'jenkins', 'devops', 'release', 'deploy', 'ci'],
  bug: ['aio', 'jira', 'bug', 'zentao', 'tapd'],
};

const CN_SECOND_LEVEL = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn']);

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

const safeUrl = (value) => {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
};

/** 站点身份：去掉用户信息、query、hash 与末尾斜杠。 */
export function siteBase(value) {
  const parsed = safeUrl(value);
  if (!parsed) return null;
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
}

/** 可注册域名：用于把 nacos、git、环境地址归到同一家公司。 */
export function registrableDomain(host) {
  const value = String(host ?? '').toLowerCase();
  if (value === '') return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':')) return value;
  const parts = value.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (CN_SECOND_LEVEL.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

function siteInfo(url, name = '') {
  const parsed = safeUrl(url);
  return { url: String(url ?? ''), host: parsed?.hostname ?? '', name: String(name ?? '') };
}

/** 按 host 的主机名分段猜平台类型（beecloud/aio/jenkins 这类套件交给 KNOWN_SITES）。 */
export function classifyHost(host) {
  const tokens = new Set(
    String(host ?? '')
      .toLowerCase()
      .split('.')
      .flatMap((label) => label.split('-')),
  );
  const kinds = [];
  if (['log', 'logs', 'grafana', 'kibana', 'elk', 'sls'].some((token) => tokens.has(token))) kinds.push('log');
  if (['jenkins', 'devops', 'release', 'deploy', 'ci', 'argo', 'pipeline'].some((token) => tokens.has(token))) kinds.push('release');
  if (['aio', 'jira', 'bug', 'bugs', 'zentao', 'tapd', 'redmine'].some((token) => tokens.has(token))) kinds.push('bug');
  return kinds;
}

/** 只看“名字/备注”里的平台关键词；英文按词边界，避免 login 命中 log、lowcode 命中 log。 */
export function classifyText(text) {
  const hits = {};
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  for (const [kind, words] of Object.entries(PLATFORM_KEYWORDS)) {
    const matched = [];
    for (const word of words.zh) if (raw.includes(word)) matched.push(word);
    for (const word of words.en) {
      if (new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'i').test(lower)) matched.push(word);
    }
    if (matched.length) hits[kind] = [...new Set(matched)];
  }
  return hits;
}

export function matchKnownSite(site) {
  return KNOWN_SITES.find((rule) => rule.match(site)) ?? null;
}

function profileUrls(profile) {
  const urls = [];
  const add = (value) => {
    if (isHttpUrl(value)) urls.push(value);
  };
  for (const key of ['environments', 'logs', 'release', 'bug', 'nacos', 'nexus']) {
    for (const item of list(profile, key)) add(item.url);
  }
  for (const repo of list(profile, 'git')) add(repo.url);
  for (const kind of PLATFORM_ORDER) {
    const value = profile.platforms?.[kind];
    for (const item of Array.isArray(value) ? value : value ? [value] : []) add(item.url);
  }
  return urls;
}

/** 从 profile 收集可注册域名，作为“同域候选”的边界。 */
export function collectDomains(profile) {
  const domains = new Set();
  for (const url of profileUrls(profile)) {
    const parsed = safeUrl(url);
    if (parsed) domains.add(registrableDomain(parsed.hostname));
  }
  return domains;
}

function collectEndpoints(profile) {
  const endpoints = new Map();
  for (const url of profileUrls(profile)) {
    const parsed = safeUrl(url);
    if (!parsed) continue;
    const scheme = parsed.protocol.replace(':', '');
    const port = parsed.port || (scheme === 'https' ? '443' : '80');
    const key = `${scheme}:${port}`;
    if (!endpoints.has(key)) endpoints.set(key, { scheme, port });
  }
  return [...endpoints.values()];
}

function decodeTitle(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 只发一次 GET：跟随跳转，拿状态、标题与平台特征；不读 Set-Cookie 的值。 */
async function probeSite(base, options = {}) {
  const timeout = options.timeout ?? 6000;
  const started = Date.now();
  try {
    const response = await fetch(base, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'dsh-java-env-prep/2 (platform discovery)',
      },
    });
    const text = (await response.text()).slice(0, 40_000);
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = decodeTitle(titleMatch?.[1] ?? '');
    const finalUrl = response.url || base;
    const finalHost = safeUrl(finalUrl)?.hostname ?? '';
    const rule = matchKnownSite(siteInfo(finalUrl, title));
    const kinds = new Set(rule?.kinds ?? []);
    for (const signature of PLATFORM_SIGNATURES) {
      if (signature.test(`${title} ${text.slice(0, 12_000)}`)) signature.kinds.forEach((kind) => kinds.add(kind));
    }
    for (const kind of classifyHost(finalHost)) kinds.add(kind);
    return {
      ok: response.status < 500,
      status: response.status,
      finalUrl,
      title,
      server: response.headers.get('server') ?? '',
      contentType: response.headers.get('content-type') ?? '',
      needsLogin: [401, 403].includes(response.status) || /login|sso|oauth|signin/i.test(finalUrl),
      ruleId: rule?.id ?? null,
      kinds: [...kinds],
      ms: Date.now() - started,
    };
  } catch (error) {
    const name = error?.name ?? '';
    return {
      ok: false,
      status: null,
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : (error?.message ?? 'fetch failed'),
      ms: Date.now() - started,
    };
  }
}

/** 验证套件里各子平台的接口是否存在：401/403/405/3xx 都算“模块在”，404 不算。 */
async function probeSuiteApis(base, rule, options = {}) {
  const results = [];
  for (const [kind, pathname] of Object.entries(rule.apis ?? {})) {
    const started = Date.now();
    try {
      const response = await fetch(`${base}${pathname}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeout ?? 4000),
        headers: { accept: 'application/json' },
      });
      const status = response.status;
      results.push({
        kind,
        path: pathname,
        status,
        ok: [200, 401, 403, 405].includes(status) || (status >= 300 && status < 400),
        ms: Date.now() - started,
      });
    } catch (error) {
      results.push({ kind, path: pathname, ok: false, reason: error?.message ?? 'fetch failed', ms: Date.now() - started });
    }
  }
  return results;
}

const confidenceOrder = ['script', 'saved', 'provided', 'suite', 'signature', 'registry', 'bookmark', 'hostname'];

function bestConfidence(sources) {
  return confidenceOrder.find((key) => sources.has(key)) ?? 'hostname';
}

function addSite(store, entry) {
  const base = siteBase(entry.url);
  if (!base) return null;
  let site = store.get(base);
  if (site === undefined) {
    site = {
      base,
      names: [],
      kinds: new Set(),
      sources: new Set(),
      evidence: [],
      tools: null,
      commands: {},
      ruleId: null,
      folders: [],
      probe: null,
      suiteApis: [],
      sameDomain: false,
    };
    store.set(base, site);
  }
  if (entry.name && !site.names.includes(entry.name)) site.names.push(entry.name);
  for (const kind of entry.kinds ?? []) site.kinds.add(kind);
  if (entry.source) site.sources.add(entry.source);
  for (const note of entry.evidence ?? []) if (!site.evidence.includes(note)) site.evidence.push(note);
  if (entry.tools && !site.tools) site.tools = entry.tools;
  if (entry.commands) Object.assign(site.commands, entry.commands);
  if (entry.ruleId && !site.ruleId) site.ruleId = entry.ruleId;
  if (entry.folder) site.folders.push(entry.folder);
  return site;
}

/** profile 里显式写的三类平台（logs / release / bug / platforms）。 */
function addProvidedSites(profile, store) {
  const push = (entry, kind, source) => {
    if (!entry || !isHttpUrl(entry.url)) return;
    const name = entry.name ?? entry.id ?? entry.site ?? '';
    const rule = matchKnownSite(siteInfo(entry.url, name));
    const kinds = new Set([kind, ...(rule?.kinds ?? []), ...classifyHost(safeUrl(entry.url)?.hostname ?? '')]);
    addSite(store, {
      url: entry.url,
      name,
      kinds: [...kinds],
      source,
      ruleId: rule?.id ?? entry.site ?? null,
      evidence: [source === 'saved' ? 'profile.platforms 已保存' : `profile 条目 ${entry.id ?? entry.site ?? ''}`.trim()],
      tools: entry.tools ?? null,
      commands: entry.command ? { [kind]: entry.command } : null,
    });
  };
  for (const log of list(profile, 'logs')) push(log, 'log', log.detected === true ? 'saved' : 'provided');
  for (const kind of ['release', 'bug']) {
    for (const item of list(profile, kind)) push(item, kind, item.detected === true ? 'saved' : 'provided');
  }
  for (const kind of PLATFORM_ORDER) {
    const value = profile.platforms?.[kind];
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of entries) push(entry, kind, entry.detected === true ? 'saved' : 'provided');
  }
}

/**
 * environments 里常混着平台入口（jasolar 的 beecloud / jenkins 就是写在环境里的）。
 * 只看名字与主机名，命中已知套件/关键词才算，避免把业务环境误判成平台。
 */
function addEnvironmentSites(profile, store) {
  for (const env of list(profile, 'environments')) {
    if (!isHttpUrl(env.url)) continue;
    const name = env.name ?? env.id ?? '';
    const rule = matchKnownSite(siteInfo(env.url, name));
    const kinds = new Set([...(rule?.kinds ?? []), ...classifyHost(safeUrl(env.url)?.hostname ?? ''), ...Object.keys(classifyText(name))]);
    if (kinds.size === 0) continue;
    addSite(store, {
      url: env.url,
      name: rule?.name ?? name,
      kinds: [...kinds],
      source: rule ? 'suite' : 'provided',
      ruleId: rule?.id ?? null,
      evidence: [`environments#${env.id ?? ''}`],
    });
  }
}

function resolveProjectDir(profile, outDir) {
  const abs = path.resolve(outDir ?? '.env-prep');
  if (path.basename(abs) === '.env-prep') return path.dirname(abs);
  const gitDir = list(profile, 'git')[0]?.dir;
  return typeof gitDir === 'string' && gitDir !== '' ? path.resolve(expandHome(gitDir)) : process.cwd();
}

/**
 * 找 DSH profile 的 patch 文件——数据库 MCP 条目要手写到这里。
 *
 * 优先级：`DSH_PATCH_FILE` > `~/.dsh/profiles/<profile>/cordis.patch.yml`（多个时 desktop 优先）。
 * 没装 DSH 时返回 null，调用方只提示"没找到 profile"。
 *
 * @returns 绝对路径或 null。
 */
export function resolveProfilePatch() {
  if (process.env.DSH_PATCH_FILE) return path.resolve(process.env.DSH_PATCH_FILE);
  const home = process.env.USERPROFILE ?? os.homedir();
  const profilesDir = path.join(home, '.dsh', 'profiles');
  if (!fs.existsSync(profilesDir)) return null;
  const found = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(profilesDir, entry.name, 'cordis.patch.yml'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => (b.includes('desktop') ? 1 : 0) - (a.includes('desktop') ? 1 : 0));
  return found[0] ?? null;
}

function extractScriptBase(text) {
  const match = text.match(/(?:const|let|var)\s+(?:BASE|BASE_URL|BASEURL|HOST|ORIGIN)\s*=\s*['"`](https?:\/\/[^'"`\s]+)['"`]/);
  return match?.[1] ?? null;
}

/** 列出工具目录里的 .mjs；支持 `tools/<站点>/<站点>.mjs` 这种一层子目录。 */
function listToolScripts(dir, depth = 1) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(path.join(dir, entry.name));
    } else if (depth > 0 && entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      files.push(...listToolScripts(path.join(dir, entry.name), depth - 1));
    }
  }
  return files;
}

/**
 * 扫描项目里已经生成的站点脚本：`.env-prep/tools/<站点>/<站点>.mjs`。
 * 只读文件、静态取 `BASE = 'https://…'`，**不执行脚本**，避免探测阶段触发登录。
 */
export function discoverScriptSites(projectDir) {
  const results = [];
  const files = listToolScripts(path.join(projectDir, '.env-prep', 'tools'), 2);
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const base = extractScriptBase(text);
    if (base === null) continue;
    const stem = path.basename(file, '.mjs');
    const rule = matchKnownSite(siteInfo(base, stem));
    const kinds = new Set([
      ...(rule?.kinds ?? []),
      ...classifyHost(safeUrl(base)?.hostname ?? ''),
      ...Object.keys(classifyText(text.slice(0, 6000))),
    ]);
    if (kinds.size === 0) continue;
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    const commands = {};
    if (rule?.id === 'beecloud' && kinds.has('log')) commands.log = `node ${rel} search --query '<关键字>' --hours 1`;
    if (rule?.id === 'aio' && kinds.has('bug')) commands.bug = `node ${rel} bugs`;
    results.push({
      base,
      name: rule?.name ?? stem,
      kinds: [...kinds],
      tools: rel,
      commands,
      rule,
    });
  }
  return results;
}

function addScriptSites(projectDir, store) {
  for (const item of discoverScriptSites(projectDir)) {
    addSite(store, {
      url: item.base,
      name: item.name,
      kinds: item.kinds,
      source: 'script',
      ruleId: item.rule?.id ?? null,
      evidence: [`站点脚本 ${item.tools}`],
      tools: item.tools,
      commands: item.commands,
    });
  }
}

export function resolveRegistryPath(outDir, explicit) {
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit);
  // 登记表跟产物放在一起，避免往工作空间里散落文件。
  // 用隐藏文件名，和本次探测结果 platforms.json 区分开。
  return path.join(path.resolve(outDir ?? '.env-prep'), '.platforms.json');
}

function readRegistry(file) {
  if (!fs.existsSync(file)) return { schema: 1, sites: [] };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { schema: doc.schema ?? 1, sites: Array.isArray(doc.sites) ? doc.sites : [] };
  } catch {
    return { schema: 1, sites: [] };
  }
}

function addRegistrySites(registry, profile, domains, store) {
  for (const item of registry.sites ?? []) {
    const base = siteBase(item.base ?? item.url);
    if (!base) continue;
    const domain = item.domain ?? registrableDomain(safeUrl(base)?.hostname ?? '');
    const sameProject = Array.isArray(item.projects) && item.projects.includes(profile.project);
    const sameDomain = domains.has(domain);
    const rule = matchKnownSite(siteInfo(base, item.name ?? item.id ?? ''));
    if (!sameProject && !sameDomain && !rule) continue;
    addSite(store, {
      url: base,
      name: item.name ?? item.id ?? rule?.name ?? '',
      kinds: item.kinds ?? rule?.kinds ?? [],
      source: 'registry',
      ruleId: item.id ?? rule?.id ?? null,
      evidence: [`平台登记表${sameProject ? `（${profile.project}）` : sameDomain ? `（同域 ${domain}）` : ''}`],
    });
  }
}

function walkBookmarkNode(node, trail, out, browser) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'url' && typeof node.url === 'string') {
    out.push({
      url: node.url,
      name: typeof node.name === 'string' ? node.name : '',
      folder: trail.slice(1).join(' / '),
      browser,
    });
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const next = child?.type === 'folder' && typeof child.name === 'string' ? [...trail, child.name] : trail;
      walkBookmarkNode(child, next, out, browser);
    }
  }
}

export function bookmarkItemsFromDoc(doc, browser = 'test') {
  const items = [];
  for (const rootName of ['bookmark_bar', 'other', 'synced']) {
    walkBookmarkNode(doc?.roots?.[rootName], [rootName], items, browser);
  }
  return items;
}

function readBookmarkItems() {
  const items = [];
  for (const { browser, file } of bookmarkCandidates()) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    items.push(...bookmarkItemsFromDoc(doc, browser));
  }
  return items;
}

/**
 * 书签是“用户平时真在用哪些平台”的低成本证据；只读，不上传。
 * 只收命中已知套件、同域、或名字带平台关键词的条目，且至少覆盖一个缺失类型。
 */
function addBookmarkSites(profile, domains, store, missingKinds) {
  for (const item of readBookmarkItems()) {
    if (!isHttpUrl(item.url)) continue;
    const parsed = safeUrl(item.url);
    if (!parsed) continue;
    const rule = matchKnownSite(siteInfo(item.url, item.name));
    const kinds = new Set([
      ...(rule?.kinds ?? []),
      ...classifyHost(parsed.hostname),
      ...Object.keys(classifyText(item.name)),
    ]);
    const sameDomain = domains.has(registrableDomain(parsed.hostname));
    if (kinds.size === 0) continue;
    if (!sameDomain && !rule) continue;
    if (![...kinds].some((kind) => missingKinds.includes(kind))) continue;
    addSite(store, {
      url: item.url,
      name: item.name || rule?.name || parsed.hostname,
      kinds: [...kinds],
      source: 'bookmark',
      ruleId: rule?.id ?? null,
      evidence: [`${item.browser} 书签「${item.folder || '未分类'}」`],
      folder: `${item.folder} ${item.name}`.trim(),
    });
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}

/** 同域候选：只在用户已经给过的域名上，按固定平台名 + 已出现过的协议/端口试一小批。 */
async function scanSameDomain(profile, store, missingKinds, options = {}) {
  const domains = [...collectDomains(profile)].filter(
    (domain) => domain !== '' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) && !domain.includes(':'),
  );
  if (domains.length === 0) return [];
  const endpoints = collectEndpoints(profile);
  const budget = options.probeBudget ?? 24;
  const seen = new Set();
  const targets = [];
  for (const kind of missingKinds) {
    for (const label of SAME_DOMAIN_LABELS[kind] ?? []) {
      for (const domain of domains) {
        for (const endpoint of endpoints) {
          const defaultPort = (endpoint.scheme === 'https' && endpoint.port === '443') || (endpoint.scheme === 'http' && endpoint.port === '80');
          const url = `${endpoint.scheme}://${label}.${domain}${defaultPort ? '' : `:${endpoint.port}`}/`;
          if (seen.has(url) || store.has(siteBase(url))) continue;
          seen.add(url);
          targets.push({ url, kind });
          if (targets.length >= budget) break;
        }
        if (targets.length >= budget) break;
      }
      if (targets.length >= budget) break;
    }
    if (targets.length >= budget) break;
  }
  const results = await mapLimit(targets, options.concurrency ?? 4, async (target) => ({
    ...target,
    probe: await probeSite(target.url, { timeout: options.scanTimeout ?? 3500 }),
  }));
  for (const item of results) {
    if (!item.probe.ok) continue;
    const kinds = new Set([
      item.kind,
      ...(item.probe.kinds ?? []),
      ...classifyHost(safeUrl(item.probe.finalUrl)?.hostname ?? ''),
    ]);
    addSite(store, {
      url: item.url,
      name: item.probe.title || safeUrl(item.url)?.hostname || item.url,
      kinds: [...kinds],
      source: 'hostname',
      evidence: [`同域候选 ${safeUrl(item.url)?.host || item.url}`],
    });
  }
  return results;
}

function siteName(site) {
  return site.names[0] || KNOWN_SITES.find((rule) => rule.id === site.ruleId)?.name || safeUrl(site.base)?.hostname || site.base;
}

function siteScore(site, projectHint) {
  const base = CONFIDENCE[bestConfidence(site.sources)]?.score ?? 30;
  const projectHit = `${site.folders.join(' ')} ${site.names.join(' ')}`
    .toLowerCase()
    .includes(String(projectHint ?? '').toLowerCase());
  return (
    base +
    (site.sameDomain ? 15 : 0) +
    (site.kinds.size > 1 ? 8 : 0) +
    (site.probe?.ok ? 5 : 0) +
    (site.probe && site.probe.ok === false ? -20 : 0) +
    (projectHint && projectHit ? 10 : 0)
  );
}

function toPlatformEntry(site, kind) {
  const rule = KNOWN_SITES.find((item) => item.id === site.ruleId);
  const verifiedApi = site.suiteApis.find((item) => item.kind === kind && item.ok);
  const entry = {
    kind,
    site: site.ruleId ?? safeUrl(site.base)?.hostname?.split('.')[0] ?? 'platform',
    name: siteName(site),
    url: site.base,
    tools: site.tools ?? null,
    command: site.commands?.[kind] ?? null,
    confidence: bestConfidence(site.sources),
    auth: site.probe?.needsLogin ? 'login' : site.tools ? 'script-managed' : rule ? 'login' : 'unknown',
    sameDomain: site.sameDomain === true,
    reachable: site.probe?.ok ?? null,
    evidence: site.evidence,
  };
  // 只记录真正探到的接口（401/403 也算存在）；不猜 UI 子路径。
  if (verifiedApi) entry.api = verifiedApi.path;
  if (site.suiteApis.length > 0) entry.suiteApis = site.suiteApis;
  return entry;
}

function siteSummary(site) {
  return {
    id: site.ruleId ?? safeUrl(site.base)?.hostname?.split('.')[0] ?? '',
    name: siteName(site),
    url: site.base,
    kinds: [...site.kinds],
    confidence: bestConfidence(site.sources),
    sources: [...site.sources],
    reachable: site.probe?.ok ?? null,
    status: site.probe?.status ?? null,
    title: site.probe?.title ?? '',
    finalUrl: site.probe?.finalUrl ?? null,
    needsLogin: site.probe?.needsLogin ?? null,
    tools: site.tools ?? null,
    evidence: site.evidence,
    ...(site.suiteApis.length > 0 ? { suiteApis: site.suiteApis } : {}),
  };
}

function summarizeProbe(probe) {
  return {
    ok: probe.ok,
    status: probe.status ?? null,
    ms: probe.ms ?? null,
    ...(probe.reason ? { reason: probe.reason } : {}),
    ...(probe.finalUrl ? { finalUrl: probe.finalUrl } : {}),
  };
}

function buildPlatformPayload(profile, sites, attempts, domains, registryPath) {
  for (const site of sites) {
    site.sameDomain = domains.has(registrableDomain(safeUrl(site.base)?.hostname ?? ''));
  }
  const ranked = {};
  for (const kind of PLATFORM_ORDER) {
    ranked[kind] = sites
      .filter((site) => site.kinds.has(kind))
      .sort((a, b) => siteScore(b, profile.project) - siteScore(a, profile.project) || a.base.localeCompare(b.base));
  }
  const platforms = {};
  for (const kind of PLATFORM_ORDER) {
    const primary = ranked[kind][0];
    platforms[kind] = primary
      ? { ...toPlatformEntry(primary, kind), alternates: ranked[kind].slice(1, 4).map((site) => toPlatformEntry(site, kind)) }
      : null;
  }
  const missing = PLATFORM_ORDER.filter((kind) => platforms[kind] === null);
  return {
    schema: 2,
    project: profile.project ?? '',
    generatedAt: new Date().toISOString(),
    domains: [...domains],
    platforms,
    missing,
    sites: sites.map(siteSummary),
    attempts: attempts.slice(0, 80),
    registry: registryPath,
    note: '日志/发布/缺陷平台自动探测结果；platforms[kind].url 可直接使用，tools/command 指向已生成的站点脚本。',
  };
}

/** 把主入口合并回 profile：platforms 存主入口，logs/release/bug 供书签与动作直接消费。 */
export function mergePlatformsIntoProfile(profile, platforms) {
  const changes = [];
  profile.platforms = profile.platforms && typeof profile.platforms === 'object' ? profile.platforms : {};
  for (const kind of PLATFORM_ORDER) {
    const entry = platforms?.[kind];
    if (!entry) continue;
    const slim = {
      site: entry.site,
      name: entry.name,
      url: entry.url,
      confidence: entry.confidence,
      detected: true,
    };
    if (entry.api) slim.api = entry.api;
    if (entry.tools) slim.tools = entry.tools;
    if (entry.command) slim.command = entry.command;
    if (entry.auth) slim.auth = entry.auth;

    const existing = profile.platforms[kind];
    const same = existing && (existing.url === entry.url || existing.site === entry.site);
    if (existing === undefined) {
      profile.platforms[kind] = slim;
      changes.push(`platforms.${kind}`);
    } else if (Array.isArray(existing)) {
      if (!existing.some((item) => item.url === entry.url || item.site === entry.site)) {
        existing.push(slim);
        changes.push(`platforms.${kind}+`);
      }
    } else if (same) {
      for (const field of ['name', 'api', 'tools', 'command', 'auth']) {
        if (existing[field] === undefined && slim[field] !== undefined) {
          existing[field] = slim[field];
          changes.push(`platforms.${kind}.${field}`);
        }
      }
    }
    // 用户手写的平台入口不覆盖；探测结果仍完整保存在 platforms.json 里。

    const arrayName = kind === 'log' ? 'logs' : kind;
    const array = Array.isArray(profile[arrayName]) ? profile[arrayName] : (profile[arrayName] = []);
    const item = {
      id: entry.site,
      site: entry.site,
      name: entry.name,
      url: entry.url,
      note: entry.name,
      api: entry.api,
      tools: entry.tools,
      command: entry.command,
      detected: true,
    };
    const found = array.find((candidate) => candidate.url === entry.url || candidate.site === entry.site || candidate.id === entry.site);
    if (found === undefined) {
      array.push(item);
      changes.push(`${arrayName}+${entry.site}`);
    } else {
      for (const field of ['site', 'name', 'api', 'tools', 'command', 'detected']) {
        if (found[field] === undefined && item[field] !== undefined) found[field] = item[field];
        if (field === 'detected' && found.detected === undefined) found.detected = true;
      }
    }
  }
  return changes;
}

function hasKind(store, kind) {
  return [...store.values()].some((site) => site.kinds.has(kind));
}

export function missingPlatformKinds(profile) {
  return PLATFORM_ORDER.filter((kind) => !hasPlatformKind(profile, kind));
}

export function hasPlatformKind(profile, kind) {
  if (profile.platforms?.[kind]) return true;
  if (kind === 'log' && list(profile, 'logs').length > 0) return true;
  return list(profile, kind).length > 0;
}

function updateRegistry(file, payload, project) {
  if (!file) return null;
  const doc = readRegistry(file);
  const now = payload.generatedAt;
  for (const site of payload.sites) {
    if (site.reachable === false || site.kinds.length === 0) continue;
    const base = site.url;
    const domain = registrableDomain(safeUrl(base)?.hostname ?? '');
    let item = doc.sites.find((candidate) => (candidate.base ?? candidate.url) === base);
    if (item === undefined) {
      item = { id: site.id, base, name: site.name, domain, kinds: [], projects: [], firstSeen: now, evidence: site.evidence?.[0] ?? '' };
      doc.sites.push(item);
    }
    item.id = item.id || site.id;
    item.name = site.name || item.name;
    item.domain = domain || item.domain || '';
    item.kinds = [...new Set([...(item.kinds ?? []), ...site.kinds])];
    item.projects = [...new Set([...(item.projects ?? []), project])];
    item.lastSeen = now;
    item.confidence = site.confidence ?? item.confidence;
  }
  doc.schema = doc.schema ?? 1;
  doc.updatedAt = now;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 探测日志 / 发布 / 缺陷三类平台入口并落盘。
 *
 * @param profile - env-profile（会被合并写入，除非 `writeProfile: false`）。
 * @param outDir - 输出目录（platforms.json 落这里）。
 * @param options - `{ profilePath, registry, probe, scan, bookmarks, scripts, writeProfile, timeout, scanTimeout, suiteTimeout, probeBudget, concurrency }`
 * @returns 探测结果（与 platforms.json 同构，外加 changes/profileWritten）。
 */
export async function discoverPlatforms(profile, outDir, options = {}) {
  const store = new Map();
  const attempts = [];
  const domains = collectDomains(profile);
  const projectDir = resolveProjectDir(profile, outDir);
  const registryPath = options.registry === false ? null : resolveRegistryPath(outDir, options.registry);

  addProvidedSites(profile, store);
  addEnvironmentSites(profile, store);
  if (options.scripts !== false) addScriptSites(projectDir, store);
  const registry = registryPath ? readRegistry(registryPath) : { sites: [] };
  if (options.registry !== false) addRegistrySites(registry, profile, domains, store);

  let missing = PLATFORM_ORDER.filter((kind) => !hasKind(store, kind));
  // 没有任何项目域名时（连业务地址都没给）不读书签：避免把用户别的项目的平台算进来。
  if (options.bookmarks !== false && missing.length > 0 && domains.size > 0) {
    addBookmarkSites(profile, domains, store, missing);
    missing = PLATFORM_ORDER.filter((kind) => !hasKind(store, kind));
  }
  if (options.scan !== false && options.probe !== false && missing.length > 0) {
    const scanned = await scanSameDomain(profile, store, missing, options);
    for (const item of scanned) attempts.push({ url: item.url, ...summarizeProbe(item.probe) });
    missing = PLATFORM_ORDER.filter((kind) => !hasKind(store, kind));
  }

  for (const site of store.values()) {
    const known = KNOWN_SITES.find((rule) => rule.id === site.ruleId) ?? matchKnownSite(siteInfo(site.base, siteName(site)));
    if (options.probe !== false) {
      const probe = await probeSite(site.base, { timeout: options.timeout ?? 6000 });
      site.probe = probe;
      attempts.push({ url: site.base, ...summarizeProbe(probe) });
      for (const kind of probe.kinds ?? []) site.kinds.add(kind);
      if (probe.ruleId && !site.ruleId) site.ruleId = probe.ruleId;
      if (probe.ok) {
        if (known !== null) site.sources.add('suite');
        else if (probe.kinds.length > 0) site.sources.add('signature');
      }
    }
    site.sameDomain = domains.has(registrableDomain(safeUrl(site.base)?.hostname ?? ''));
    if (options.probe !== false && site.probe?.ok && known !== null) {
      site.suiteApis = await probeSuiteApis(site.base, known, { timeout: options.suiteTimeout ?? 4000 });
    }
  }

  const payload = buildPlatformPayload(profile, [...store.values()], attempts, domains, registryPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'platforms.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const changes = options.writeProfile === false ? [] : mergePlatformsIntoProfile(profile, payload.platforms);
  if (options.writeProfile !== false && changes.length > 0 && typeof options.profilePath === 'string' && options.profilePath !== '') {
    try {
      fs.copyFileSync(options.profilePath, `${options.profilePath}.bak`);
    } catch {
      /* 备份失败不阻断写回 */
    }
    fs.writeFileSync(options.profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  }
  if (registryPath && options.updateRegistry !== false) updateRegistry(registryPath, payload, profile.project ?? '');
  return { ...payload, changes, profileWritten: changes.length > 0 };
}

async function main() {
  const [command, profilePath, ...rest] = process.argv.slice(2);
  if (!command || !profilePath) {
    console.log('用法：env-prep.mjs <validate|plan|apply|infer|branch|discover|platforms> <profile.json> [选项]');
    console.log('  --only a,b            只执行指定动作（discover/bookmark/clone/nacos/logs/hosts）');
    console.log('  --out dir             输出目录，默认 ./.env-prep');
    console.log('  --project <name>      覆盖项目名（默认从仓库前缀或 git 组名推断）');
    console.log('  --database <name>     infer 时强制指定库名');
    console.log('  --bookmark-mode a|b   auto/file/html，默认 auto');
    console.log('  --close-browser       允许为写书签关闭浏览器（终端里会提示等待）');
    console.log('  --force-close         同意已在对话里拿到，直接关闭，不再要求终端');
    console.log('  --confirm-timeout 30  关闭浏览器的确认等待秒数，超时强制关闭');
    console.log('  --branch-strategy <s> active|latest|profile，默认 active：排除默认分支后取最新提交');
    console.log('  --max-age <days>      只克隆最近 N 天有提交的仓库，默认 30；0 或 --no-age-filter 关闭');
    console.log('  --keep-branch         保持 profile 里的 branch / 远端默认分支（等价于 --branch-strategy profile）');
    console.log('  --no-discover         不自动探测日志/发布/缺陷平台（apply 默认探测缺失项）');
    console.log('  --no-probe            只看静态线索，不发任何探测请求');
    console.log('  --no-scan             不探测同域候选（脚本/书签/登记表仍参与）');
    console.log('  --no-bookmarks        不读浏览器书签');
    console.log('  --no-registry         不读也不写平台登记表');
    console.log('  --registry <file>     登记表路径，默认 <out>/.platforms.json');
    console.log('  --no-write-profile    discover 只写 platforms.json，不改 profile');
    console.log('  --probe-budget 24     同域候选探测的请求上限');
    console.log('  discover <profile>    探测日志/发布/缺陷平台入口，写 platforms.json 并合并回 profile');
    console.log('  platforms <profile>   读取已保存的平台入口（discover 的产物）');
    console.log('  branch <profile>      对已克隆仓库套用分支策略；--dry-run 只预览，--no-fetch 不拉远端');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(profilePath, 'utf8').replace(/^\uFEFF/, '');
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

  // 平台探测选项：默认启用，但每一项都能单独关掉；密码不会进入探测请求。
  const numeric = (name, fallback) => {
    const index = rest.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(rest[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const registryIndex = rest.indexOf('--registry');
  const registryArg = registryIndex === -1 ? undefined : rest[registryIndex + 1];
  const discoverOptions = {
    profilePath,
    registry: rest.includes('--no-registry') ? false : registryArg,
    probe: !rest.includes('--no-probe'),
    scan: !rest.includes('--no-scan'),
    bookmarks: !rest.includes('--no-bookmarks'),
    scripts: !rest.includes('--no-scripts'),
    writeProfile: !rest.includes('--no-write-profile'),
    timeout: numeric('--timeout', 6000),
    scanTimeout: numeric('--scan-timeout', 3500),
    suiteTimeout: numeric('--suite-timeout', 4000),
    probeBudget: numeric('--probe-budget', 24),
    concurrency: numeric('--concurrency', 4),
  };
  const projectDir = resolveProjectDir(profile, outDir);

  // 分支策略：默认 active（排除默认分支取最新提交）；--keep-branch / profile 保持原样。
  const strategyIndex = rest.indexOf('--branch-strategy');
  const requested = String(rest[strategyIndex + 1] ?? '').toLowerCase();
  const branchStrategy = rest.includes('--keep-branch') ? 'profile'
    : (['active', 'latest', 'profile'].includes(requested) ? requested : 'active');

  // 活跃度：默认只克隆最近 30 天有提交的仓库；--max-age 可调，0 / --no-age-filter 关闭。
  const ageIndex = rest.indexOf('--max-age');
  const maxAgeDays = rest.includes('--no-age-filter')
    ? 0
    : (ageIndex === -1 ? 30 : Math.max(0, Number(rest[ageIndex + 1] ?? 30) || 0));

  // branch：对已克隆的仓库套用分支策略（克隆后规则的手动版）。
  if (command === 'branch') {
    const output = switchAllBranches(profile, {
      branchStrategy,
      dryRun: rest.includes('--dry-run'),
      fetch: !rest.includes('--no-fetch'),
    });
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // discover：探测「日志 / 发布 / 缺陷」三类平台的入口并落盘。
  if (command === 'discover') {
    const result = await discoverPlatforms(profile, outDir, discoverOptions);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.missing.length > 0 ? 2 : 0;
    return;
  }

  // platforms：只读已保存的结果，供后续技能/脚本直接消费。
  if (command === 'platforms') {
    const file = path.join(outDir, 'platforms.json');
    if (!fs.existsSync(file)) {
      console.log(
        JSON.stringify(
          {
            project: profile.project,
            saved: false,
            missing: missingPlatformKinds(profile),
            hint: '还没有 platforms.json，先跑 discover（apply 遇到缺失平台时也会自动跑）',
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const summary = {};
    for (const kind of PLATFORM_ORDER) {
      const entry = saved.platforms?.[kind];
      summary[kind] = entry
        ? {
            site: entry.site,
            name: entry.name,
            url: entry.url,
            api: entry.api ?? null,
            tools: entry.tools ?? null,
            command: entry.command ?? null,
            confidence: entry.confidence,
            auth: entry.auth,
            alternates: (entry.alternates ?? []).map((item) => ({ site: item.site, url: item.url, confidence: item.confidence })),
          }
        : null;
    }
    console.log(
      JSON.stringify(
        {
          project: saved.project ?? profile.project,
          generatedAt: saved.generatedAt,
          platforms: summary,
          missing: saved.missing ?? [],
          registry: saved.registry ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = (saved.missing ?? []).length > 0 ? 2 : 0;
    return;
  }

  // apply：缺平台就自动探测（只探一次，结果供后面的书签/日志动作使用）。
  const noDiscover = rest.includes('--no-discover');
  const missingBefore = missingPlatformKinds(profile);
  const shouldDiscover = apply && !noDiscover && (only === null ? missingBefore.length > 0 : only.includes('discover'));
  let discovery = null;
  if (shouldDiscover) {
    try {
      discovery = await discoverPlatforms(profile, outDir, discoverOptions);
    } catch (error) {
      discovery = { ok: false, reason: error instanceof Error ? error.message : String(error), missing: missingBefore };
    }
  }

  const plan = buildPlan(profile, { autoDiscover: !noDiscover }).filter(
    (action) => !(discovery !== null && action.type === 'discover'),
  );
  if (discovery !== null) {
    plan.unshift({ type: 'discover', target: 'platforms', detail: '自动探测日志/发布/缺陷平台入口' });
  }
  const selected = only === null ? plan : plan.filter((action) => only.includes(action.type));

  const output = { project: profile.project, apply, problems, outDir, plan: selected, results: [] };
  // MCP 条目要手写：把 profile 的 patch 位置直接给出来，别再让用户自己找。
  const profilePatch = resolveProfilePatch();
  if (list(profile, 'databases').length > 0) {
    output.mcpPatch = profilePatch;
    output.mcpHint = profilePatch
      ? `数据库 MCP 条目写进 ${profilePatch} 的顶层数组（含凭据，勿提交）；DSH 的 HMR 会自动重载，没生效再重启`
      : '本机没找到 DSH profile（~/.dsh/profiles/*/cordis.patch.yml），MCP 条目按宿主方式配置';
  }
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
      if (action.type === 'discover') {
        output.results.push({
          ...action,
          ...(discovery ?? (await discoverPlatforms(profile, outDir, discoverOptions))),
        });
      } else if (action.type === 'hosts') {
        output.results.push({ ...action, ...applyHosts(profile, outDir) });
      } else if (action.type === 'clone') {
        const entry = list(profile, 'git').find((item) => item.id === action.entryId);
        const repo = (entry.repos ?? []).find((item) => (item.name ?? entry.id) === action.target) ?? { name: action.target };
        output.results.push({ ...action, ...cloneRepo(repo, entry, { branchStrategy, maxAgeDays }) });
      } else if (action.type === 'nacos') {
        const nacos = list(profile, 'nacos').find((item) => item.id === action.target);
        output.results.push({ ...action, configs: await fetchNacos(nacos, outDir) });
      } else if (action.type === 'logs') {
        const log = list(profile, 'logs').find((item) => item.id === action.target);
        const probed = await probeLogPlatform(log, outDir, projectDir);
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
