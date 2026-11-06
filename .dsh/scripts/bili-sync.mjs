#!/usr/bin/env node
/**
 * 9c 视频同步：B 站投稿列表 → 字幕/转写 → 文档 prompt → COS 上传。
 *
 *   node .dsh/scripts/bili-sync.mjs list [--days 365]
 *   node .dsh/scripts/bili-sync.mjs subtitles [--limit 20]
 *   node .dsh/scripts/bili-sync.mjs docs [--api-base ... --api-key ... --model ...]
 *   node .dsh/scripts/bili-sync.mjs upload [--prefix 9c/docs]
 *   node .dsh/scripts/bili-sync.mjs all
 *
 * 只读写 .dsh/skills/9c/knowledge/；不把转写/密钥写进仓库。
 * B 站接口需要外网；不可达时用 --list-file 导入另一台机器抓好的列表。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 仓库内是 <repo>/.dsh/scripts，copy 安装后是 <技能根>/../scripts，两者都只差一级，按 DSH 根推即可。
const DSH_ROOT = path.resolve(HERE, '..');
const SKILL_ROOT = path.join(DSH_ROOT, 'skills', '9c');
const KNOWLEDGE = path.join(SKILL_ROOT, 'knowledge');
const SOURCES_FILE = path.join(KNOWLEDGE, 'sources.jsonl');
const STATE_FILE = path.join(KNOWLEDGE, 'sync-state.json');
const TRANSCRIPTS_DIR = path.join(KNOWLEDGE, 'transcripts');
const PROMPTS_DIR = path.join(KNOWLEDGE, 'prompts');
const DOCS_DIR = path.join(KNOWLEDGE, 'docs');
const MID = '322005137';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 财经词表，用于判断一条字幕到底是不是这个频道的视频。
 * 频道里每支视频都在谈股票/估值/股息，实测正常转写每万字符命中 20~85 次。
 */
const FINANCE_TERMS = /股票|估值|股息|仓位|持仓|市值|市盈|现金流|财报|指数|基金|债券|利率|美元|利润|营收|分红|港股|A股|涨|跌/g;

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const has = (name) => args.includes(`--${name}`);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
  39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56,
  59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

function usage() {
  console.log(`用法：node .dsh/scripts/bili-sync.mjs <list|subtitles|docs|upload|update|status|all> [选项]

  list       拉取 UP 主近 N 天投稿，写 knowledge/sources.jsonl
    --days 365 / --max-pages 50 / --since YYYY-MM-DD
    --list-file <json>   离线列表（[{bvid,title,pubdate,durationSec}]）
  subtitles  拉取视频字幕，写 knowledge/transcripts/<bvid>.md
    --limit 20 / --bvid BV... / --force 重新拉已有转写
  docs       为每份转写生成文档 prompt；有 --api-base/--api-key 时直接调模型
    --api-base https://api.deepseek.com/v1 --api-key ... --model deepseek-chat
  upload     把 knowledge/docs/*.md 上传到 COS（未配置 COS 时自动跳过）
    --prefix 9c/docs / --env-file .env-prep/cos-mcp.env / --no-cos
  update     增量更新：从 sync-state.json 的 lastVideoPublishedAt 开始
    list → subtitles → docs → 可选 upload，并写回 sync-state.json
    --limit 10 / --no-cos / --since YYYY-MM-DD
  status     统计 sources / transcripts / docs
  all        list → subtitles → docs → upload`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { lastSyncedAt: null, lastVideoPublishedAt: null, lastVideoBvid: null };
  try {
    return { lastSyncedAt: null, lastVideoPublishedAt: null, lastVideoBvid: null, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { lastSyncedAt: null, lastVideoPublishedAt: null, lastVideoBvid: null };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function isoDate(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 10);
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hh = String(Math.floor(value / 3600)).padStart(2, '0');
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const ss = String(value % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': UA,
      referer: 'https://space.bilibili.com/322005137/video',
      ...(process.env.BILI_COOKIE ? { cookie: process.env.BILI_COOKIE } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeout ?? 20_000),
  }).catch((error) => {
    throw new Error(`B 站接口不可达（${error.message}）。请确认网络/代理，或设置 BILI_COOKIE，或改用 --list-file。`);
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`B 站返回非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
  }
}

let wbi = null;
async function getWbi() {
  if (wbi) return wbi;
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const img = nav?.data?.wbi_img?.img_url;
  const sub = nav?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error('拿不到 WBI 签名 key（nav 返回异常）');
  const imgKey = img.split('/').pop().split('.')[0];
  const subKey = sub.split('/').pop().split('.')[0];
  const mixin = WBI_TAB.map((index) => `${imgKey}${subKey}`[index]).join('').slice(0, 32);
  wbi = { imgKey, subKey, mixin };
  return wbi;
}

function signedQuery(params, mixin) {
  const all = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = encodeURIComponent(String(all[key])).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return `${encodeURIComponent(key)}=${value}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

function parseDuration(value) {
  if (typeof value === 'number') return value;
  const parts = String(value ?? '').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function listVideos(options = {}) {
  const days = Number(options.days ?? flag('days', '365')) || 365;
  const maxPages = Number(flag('max-pages', '50')) || 50;
  const since = options.since ?? flag('since', '');
  const sinceMs = since ? Date.parse(`${since}T00:00:00+08:00`) : NaN;
  const cutoff = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000)
    : Math.floor(Date.now() / 1000) - days * 86_400;
  const listFile = flag('list-file', '');
  let items = [];
  let total = 0;

  if (listFile !== '') {
    const raw = JSON.parse(fs.readFileSync(listFile, 'utf8').replace(/^\uFEFF/, ''));
    items = Array.isArray(raw) ? raw : raw.videos ?? raw.list ?? [];
    total = items.length;
  } else {
    const { mixin } = await getWbi();
    for (let page = 1; page <= maxPages; page += 1) {
      const query = signedQuery({ mid: MID, ps: 30, pn: page, order: 'pubdate', platform: 'web' }, mixin);
      const json = await fetchJson(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`);
      if (json.code !== 0) throw new Error(`B 站列表接口返回 ${json.code}：${json.message ?? ''}`);
      const vlist = json.data?.list?.vlist ?? [];
      total = json.data?.page?.count ?? total;
      if (vlist.length === 0) break;
      let older = 0;
      for (const item of vlist) {
        // The modern arc/search response spells the publish time `created`;
        // older payloads used `pubdate`. Reading only one of them made every
        // item look undated and dropped the whole listing.
        const pubdate = Number(item.pubdate ?? item.created ?? 0);
        if (pubdate >= cutoff) {
          items.push({
            bvid: item.bvid,
            title: item.title,
            pubdate,
            durationSec: parseDuration(item.duration ?? item.length),
            author: item.author,
            play: item.play,
            url: `https://www.bilibili.com/video/${item.bvid}`,
          });
        } else {
          older += 1;
        }
      }
      if (older === vlist.length) break;
    }
  }

  const existing = new Map(readJsonl(SOURCES_FILE).map((item) => [item.bvid, item]));
  const rows = items
    .filter((item) => item.bvid && Number(item.pubdate ?? 0) >= cutoff)
    .map((item) => {
      const old = existing.get(item.bvid) ?? {};
      return {
        bvid: item.bvid,
        title: item.title ?? old.title ?? '',
        publishedAt: new Date(Number(item.pubdate) * 1000).toISOString().slice(0, 10),
        pubdate: Number(item.pubdate),
        durationSec: Number(item.durationSec ?? old.durationSec ?? 0),
        type: old.type ?? (/复盘|结算|直播|周记|投资记录/.test(item.title ?? '') ? 'case' : 'method'),
        url: item.url ?? `https://www.bilibili.com/video/${item.bvid}`,
        status: old.status ?? 'listed',
        note: old.note ?? '',
      };
    })
    .sort((a, b) => b.pubdate - a.pubdate);

  writeJsonl(SOURCES_FILE, rows);
  console.log(JSON.stringify({ totalOnSpace: total, kept: rows.length, days, since: since || null, file: SOURCES_FILE }, null, 2));
  return { totalOnSpace: total, kept: rows.length, rows };
}

async function fetchSubtitle(source) {
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${source.bvid}`);
  if (view.code !== 0) throw new Error(`view ${view.code}: ${view.message ?? ''}`);
  const data = view.data;
  const cid = data.cid ?? data.pages?.[0]?.cid;
  if (!cid) throw new Error('view 没有 cid');
  const player = await fetchJson(`https://api.bilibili.com/x/player/v2?bvid=${source.bvid}&cid=${cid}`);
  const subtitles = player?.data?.subtitle?.subtitles ?? [];
  const picked = subtitles.find((item) => /zh|ai/i.test(item.lan ?? '')) ?? subtitles[0];
  if (!picked) return { ok: false, reason: '没有可用字幕（可能需要 BILI_COOKIE，或该视频只有音频）' };
  const url = picked.subtitle_url?.startsWith('//') ? `https:${picked.subtitle_url}` : picked.subtitle_url;
  if (!url) return { ok: false, reason: '字幕没有 subtitle_url' };
  const body = await fetchJson(url);
  const cues = Array.isArray(body.body) ? body.body : [];
  // B 站偶尔把别的视频的 AI 字幕挂到本视频上（实测同一个 cid 连取三次能拿到
  // 旅行 vlog / 歌词 / 科普三种内容）。字幕覆盖不到视频六成、或比视频还长，
  // 都说明它不是这条视频的：宁可标 no-subtitle，也不把垃圾写进知识库。
  const duration = Number(data.duration ?? 0);
  const lastCue = cues.reduce((max, cue) => Math.max(max, Number(cue.from) || 0), 0);
  const coverage = duration > 0 ? lastCue / duration : 1;
  if (lastCue > duration + 60) {
    return {
      ok: false,
      reason: `字幕末条 ${formatTime(lastCue)} 超过视频时长 ${formatTime(duration)}，疑似上游串条，已丢弃`,
    };
  }
  if (coverage < 0.6) {
    return {
      ok: false,
      reason: `字幕只覆盖视频 ${Math.round(coverage * 100)}%（末条 ${formatTime(lastCue)} / 时长 ${formatTime(duration)}），疑似上游串条或字幕残缺，已丢弃`,
    };
  }
  const lines = cues
    .map((item) => `[${formatTime(item.from)}] ${String(item.content ?? '').trim()}`)
    .filter((line) => line.length > 12)
    .join('\n');
  // 时长对得上不代表字幕是这条视频的：串过来的可能是同长度的别家内容。这个频道
  // 每条视频都在讲股票，所以「财经词密度」是一道便宜的语义闸门——实测正常转写
  // 每万字符 20~85 次，串条内容都在 15 以下，中间有明显断层。
  const financeHits = (lines.match(FINANCE_TERMS) || []).length;
  const density = lines.length > 0 ? financeHits / (lines.length / 10000) : 0;
  if (density < 15) {
    return {
      ok: false,
      reason: `字幕与财经主题不符（财经词密度 ${density.toFixed(1)}/万字符，正常值 20+），疑似串条，已丢弃`,
    };
  }
  const markdown = [
    `# ${data.title}`,
    '',
    `- bvid: ${source.bvid}`,
    `- 发布日期: ${new Date(Number(data.pubdate) * 1000).toISOString().slice(0, 10)}`,
    `- 时长: ${formatTime(data.duration)}`,
    `- 来源: B站字幕（${picked.lan ?? 'unknown'}）`,
    `- 校对: 未人工校对，股票名/数字需复核`,
    '',
    '## 转写',
    '',
    lines,
    '',
  ].join('\n');
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const file = path.join(TRANSCRIPTS_DIR, `${source.bvid}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  return { ok: true, file, chars: lines.length };
}

async function subtitles(options = {}) {
  const rows = readJsonl(SOURCES_FILE);
  if (rows.length === 0) throw new Error(`没有 ${SOURCES_FILE}，先跑 list`);
  const only = flag('bvid', '');
  const limit = Number(options.limit ?? flag('limit', '0')) || 0;
  const force = has('force');
  const candidates = rows.filter((row) => only === '' || row.bvid === only);
  const targets = candidates.slice(0, limit > 0 ? limit : undefined);
  const results = [];
  for (const source of targets) {
    const transcriptFile = path.join(TRANSCRIPTS_DIR, `${source.bvid}.md`);
    if (!force && fs.existsSync(transcriptFile)) {
      results.push({ bvid: source.bvid, ok: true, skipped: true, file: transcriptFile });
      continue;
    }
    try {
      let result = await fetchSubtitle(source);
      // 上游串条是随机的：同一条视频重取往往就能拿到正确字幕，所以对
      // 「疑似串条 / 字幕残缺」这类可重试的拒绝再取两次，其余失败不重试。
      for (let attempt = 0; attempt < 2 && !result.ok && /疑似上游串条|字幕残缺/.test(result.reason ?? ''); attempt += 1) {
        result = await fetchSubtitle(source);
      }
      results.push({ bvid: source.bvid, ...result });
      if (result.ok) source.status = 'transcribed';
      else source.status = 'no-subtitle';
      source.note = result.ok ? '' : result.reason;
    } catch (error) {
      results.push({ bvid: source.bvid, ok: false, reason: error instanceof Error ? error.message : String(error) });
      source.status = 'failed';
      source.note = error instanceof Error ? error.message : String(error);
    }
  }
  writeJsonl(SOURCES_FILE, rows);
  const summary = {
    total: targets.length,
    ok: results.filter((item) => item.ok && !item.skipped).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0 && options.noExit !== true) process.exitCode = 2;
  return summary;
}

function docPrompt(transcript, source) {
  return `你是「史诗级韭菜」公开视频的研究助理。基于下面带时间戳的转写，写一份结构化 Markdown 文档。

硬规则：
1. 只写转写里明确出现的内容；不推断、不补常识、不写投资建议。
2. 原话必须带 [HH:MM:SS] 时间戳；转述与原文分开。
3. 区分“明确规则 / 案例 / 他的犹豫或反问 / 与现有框架冲突”。
4. 股票名、数字看不清就写“待核对”，不要猜。
5. 输出 Markdown，不要代码块包裹整篇。

固定结构：
# 标题
- bvid / 发布日期 / 时长 / 来源
## 一句话结论
## 他讲了什么
## 可执行规则（只写明确说过的）
## 案例与标的
## 关键原话（带时间戳）
## 与现有 framework 的差异 / 冲突
## 可抽取的 claims（JSONL，每行一条，status=candidate）

视频：${source.bvid} ${source.title}（${source.publishedAt}）
转写：
---
${transcript}
---`;
}

async function callLlm(prompt, apiBase, apiKey, model) {
  const base = apiBase.replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('LLM 返回空内容');
  return content;
}

async function docs() {
  const rows = readJsonl(SOURCES_FILE);
  const byBvid = new Map(rows.map((row) => [row.bvid, row]));
  const apiBase = flag('api-base', process.env.LLM_BASE_URL ?? '');
  const apiKey = flag('api-key', process.env.LLM_API_KEY ?? '');
  const model = flag('model', process.env.LLM_MODEL ?? 'deepseek-chat');
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const transcriptFiles = fs.existsSync(TRANSCRIPTS_DIR)
    ? fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith('.md') && name !== 'README.md')
    : [];
  const results = [];
  for (const fileName of transcriptFiles) {
    const bvid = path.basename(fileName, '.md');
    const transcriptFile = path.join(TRANSCRIPTS_DIR, fileName);
    const transcript = fs.readFileSync(transcriptFile, 'utf8');
    const title = transcript.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? bvid;
    const source = byBvid.get(bvid) ?? { bvid, title, publishedAt: '', durationSec: 0 };
    const prompt = docPrompt(transcript, source);
    const promptFile = path.join(PROMPTS_DIR, `${bvid}.doc.prompt.md`);
    fs.writeFileSync(promptFile, `${prompt}\n`, 'utf8');
    if (apiBase !== '' && apiKey !== '') {
      try {
        const content = await callLlm(prompt, apiBase, apiKey, model);
        const docFile = path.join(DOCS_DIR, `${bvid}.md`);
        fs.writeFileSync(docFile, `${content}\n`, 'utf8');
        results.push({ bvid, ok: true, doc: docFile });
      } catch (error) {
        results.push({ bvid, ok: false, reason: error instanceof Error ? error.message : String(error), prompt: promptFile });
      }
    } else {
      results.push({ bvid, ok: false, reason: '未配置 LLM，仅生成 prompt', prompt: promptFile });
    }
  }
  console.log(JSON.stringify({ total: results.length, ok: results.filter((item) => item.ok).length, results }, null, 2));
  // 没配 LLM 只生成 prompt 不算失败；配了 LLM 但全部失败才返回非 0。
  if (apiBase !== '' && apiKey !== '' && results.length > 0 && results.every((item) => !item.ok)) process.exitCode = 2;
  return { total: results.length, ok: results.filter((item) => item.ok).length, results };
}

function upload(options = {}) {
  const prefix = flag('prefix', '9c/docs');
  const envFile = flag('env-file', '.env-prep/cos-mcp.env');
  const envPath = path.isAbsolute(envFile) ? envFile : path.resolve(process.cwd(), envFile);
  const envConfigured =
    fs.existsSync(envPath) ||
    (process.env.COS_REGION && process.env.COS_BUCKET && process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
  if (options.noCos === true || has('no-cos') || !envConfigured) {
    const report = { ok: true, skipped: true, reason: 'COS 未配置或 --no-cos：文档只保存在本地' };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(HERE, 'cos-upload.mjs'), '--dir', DOCS_DIR, '--prefix', prefix, '--env-file', envFile, '--json'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 },
  );
  console.log((result.stdout ?? '').trim());
  if (result.status !== 0) {
    console.error((result.stderr ?? '').trim());
    process.exitCode = result.status ?? 1;
  }
  return { ok: result.status === 0, skipped: false };
}

function status() {
  const sources = readJsonl(SOURCES_FILE);
  const state = readState();
  const transcripts = fs.existsSync(TRANSCRIPTS_DIR)
    ? fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith('.md') && name !== 'README.md')
    : [];
  const docs = fs.existsSync(DOCS_DIR) ? fs.readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md')) : [];
  const docBvids = new Set(docs.map((name) => path.basename(name, '.md')));
  const pendingDocs = transcripts.filter((name) => !docBvids.has(path.basename(name, '.md'))).length;
  console.log(
    JSON.stringify(
      {
        sources: sources.length,
        byStatus: sources.reduce((acc, item) => ((acc[item.status] = (acc[item.status] ?? 0) + 1), acc), {}),
        transcripts: transcripts.length,
        docs: docs.filter((name) => name !== 'README.md').length,
        pendingDocs,
        lastVideoPublishedAt: state.lastVideoPublishedAt ?? null,
        lastSyncedAt: state.lastSyncedAt ?? null,
        sourcesFile: SOURCES_FILE,
      },
      null,
      2,
    ),
  );
}

async function update() {
  const state = readState();
  const overlapDays = Number(flag('overlap-days', '2')) || 0;
  const sinceArg = flag('since', '');
  let since = sinceArg;
  if (since === '' && state.lastVideoPublishedAt) {
    const start = new Date(`${state.lastVideoPublishedAt}T00:00:00+08:00`);
    start.setDate(start.getDate() - overlapDays);
    since = start.toISOString().slice(0, 10);
  }
  const listed = await listVideos({ since: since || undefined, days: Number(flag('days', '365')) || 365 });
  const sub = await subtitles({ noExit: true, limit: Number(flag('limit', '0')) || 0 });
  const docResult = await docs();
  const uploadResult = upload();

  const newest = listed.rows.reduce(
    (best, row) => (best === null || String(row.publishedAt) > String(best.publishedAt) ? row : best),
    null,
  );
  const nextState = {
    lastSyncedAt: new Date().toISOString(),
    lastVideoPublishedAt: newest?.publishedAt ?? state.lastVideoPublishedAt ?? null,
    lastVideoBvid: newest?.bvid ?? state.lastVideoBvid ?? null,
    lastRun: {
      since: since || null,
      listed: listed.kept,
      transcriptsOk: sub.ok,
      transcriptsSkipped: sub.skipped,
      transcriptsFailed: sub.failed,
      docPrompts: docResult.total,
      docGenerated: docResult.ok,
      cos: uploadResult.skipped ? 'skipped' : uploadResult.ok ? 'uploaded' : 'failed',
    },
  };
  writeState(nextState);
  const pendingDocs = docResult.results.filter((item) => !item.ok && item.prompt).length;
  const report = {
    ok: sub.failed === 0,
    since: since || null,
    state: nextState,
    pendingDocs,
    note:
      pendingDocs > 0
        ? '有转写但还没有文档：读 knowledge/prompts/*.doc.prompt.md 生成 docs，再跑 upload'
        : '没有待处理文档',
  };
  console.log(JSON.stringify(report, null, 2));
  if (sub.failed > 0) process.exitCode = 2;
  return report;
}

async function main() {
  if (command === 'help' || command === '--help') return usage();
  if (command === 'list') return listVideos();
  if (command === 'subtitles') return subtitles();
  if (command === 'docs') return docs();
  if (command === 'upload') return upload();
  if (command === 'update') return update();
  if (command === 'status') return status();
  if (command === 'all') {
    await listVideos();
    await subtitles();
    await docs();
    upload();
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
