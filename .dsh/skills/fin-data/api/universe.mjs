/**
 * `universe`：标的集合（指数成分 / 港股通名单）。
 *
 * 看板选股需要「港股通」成员表，9c 与分析脚本也可能需要指数成分。以前这些请求散落在
 * 消费方（看板自己打东财板块接口、自己缓存），现在收进 fin-data：
 *
 *   query({ kind: 'universe', options: { id: 'hk-connect' } })
 *   query({ kind: 'universe', options: { id: 'sse50' } })
 *
 * - `sse50`（以及以后写入 `data/universes/<id>.json` 的集合）直接读本地文件，离线可用；
 * - `hk-connect` 走东财板块接口，按自然日缓存（进程内），失败返回 `ok: false`，
 *   不写假名单——消费方自己决定"拿不到就不过滤"还是报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './bars-local.mjs';
import { ERROR_CODES, QueryError, failEnvelope, okEnvelope } from './contract.mjs';

/** 东方财富板块接口 + 港股通板块代码。 */
const CONNECT_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const CONNECT_BOARD = 'b:DLMK0144';
const CONNECT_SOURCE = 'eastmoney:b:DLMK0144';

/** 进程内的港股通缓存：`{ date, members }`。 */
let connectCache = { date: null, members: null };

/** 以 Asia/Shanghai 为准的 `YYYY-MM-DD`。 */
function todayShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 一页 100 条，最多 12 页；只要代码，字段越少越稳。 */
async function fetchHkConnect() {
  const byCode = new Map();
  for (let page = 1; page <= 12; page += 1) {
    const query = new URLSearchParams({
      pn: String(page),
      pz: '100',
      po: '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: CONNECT_BOARD,
      fields: 'f12,f14',
    });
    const response = await fetch(`${CONNECT_URL}?${query.toString()}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (!response.ok) throw new Error(`HK Connect list HTTP ${response.status}`);
    const body = await response.json();
    const diff = body?.data?.diff ?? [];
    for (const row of diff) {
      if (!row?.f12) continue;
      byCode.set(String(row.f12), { symbol: `${row.f12}.HK`, code: String(row.f12), name: row.f14 || null });
    }
    if (diff.length < 100) break;
  }
  if (byCode.size === 0) throw new Error('HK Connect list is empty');
  return [...byCode.values()];
}

/** 本地 `data/universes/<id>.json` -> 成员列表。 */
function readLocalUniverse(id) {
  const file = path.join(DATA_DIR, 'universes', `${id}.json`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed?.members) ? parsed.members : [];
  const members = raw
    .map((member) => ({
      symbol: member.symbol ?? null,
      code: String(member.symbol ?? '').replace(/\..*$/, '') || null,
      name: member.name ?? null,
      kind: member.kind ?? null,
    }))
    .filter((member) => member.symbol !== null);
  return {
    id,
    asOf: parsed.asOf ?? null,
    source: parsed.source ?? 'fin-data/universes',
    members,
    count: members.length,
  };
}

/** 现成的集合；顺序即尝试顺序（本地优先，远端兜底）。 */
export const UNIVERSE_IDS = ['sse50', 'hk-connect'];

/**
 * 查询一个标的集合。
 * @param {object} request - `{ options: { id } }`。
 * @returns {Promise<object>} 查询信封；`data = { id, asOf, source, members, count }`。
 */
export async function queryUniverse(request) {
  const id = String(request.options?.id ?? '').toLowerCase();
  if (id === '') {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, `universe 需要 options.id，可用：${UNIVERSE_IDS.join(' / ')}`, {
      kind: 'universe',
    });
  }
  if (!UNIVERSE_IDS.includes(id)) {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, `未知 universe "${id}"；可用：${UNIVERSE_IDS.join(' / ')}`, {
      kind: 'universe',
    });
  }

  if (id !== 'hk-connect') {
    const local = readLocalUniverse(id);
    if (local === null) {
      return failEnvelope('universe', null, ERROR_CODES.NOT_FOUND, `没有 data/universes/${id}.json`, {
        source: 'fin-data/universes',
      });
    }
    return okEnvelope('universe', null, local, { source: local.source, asOf: local.asOf, ttlMs: 0 });
  }

  const today = todayShanghai();
  if (connectCache.date === today && connectCache.members !== null) {
    return okEnvelope('universe', null, {
      id,
      asOf: today,
      source: CONNECT_SOURCE,
      members: connectCache.members,
      count: connectCache.members.length,
    }, { source: CONNECT_SOURCE, asOf: today, cached: true, ttlMs: 24 * 60 * 60 * 1000 });
  }

  try {
    const members = await fetchHkConnect();
    connectCache = { date: today, members };
    return okEnvelope('universe', null, { id, asOf: today, source: CONNECT_SOURCE, members, count: members.length }, {
      source: CONNECT_SOURCE,
      asOf: today,
      ttlMs: 24 * 60 * 60 * 1000,
    });
  } catch (error) {
    return failEnvelope(
      'universe',
      null,
      ERROR_CODES.UPSTREAM_DOWN,
      error instanceof Error ? error.message : String(error),
      { source: CONNECT_SOURCE },
    );
  }
}
