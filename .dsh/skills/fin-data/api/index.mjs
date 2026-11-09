/**
 * fin-data 统一查询入口。
 *
 * 消费方（9c 的 `stock-data.mjs`、金融看板的 host 半侧、后续任何脚本）只 import
 * 这一个文件，拿到的永远是同一种信封：
 *
 *   const result = await query({ kind: 'financials', instrument: '600519', options: { periods: 4 } });
 *   result.ok / result.data / result.meta.source / result.meta.asOf / result.meta.mock
 *
 * 数据从哪来由 fin-data 决定，不写在调用方：
 * - `financials` 走「真实指标优先 + 模拟兜底」的财报适配器；
 * - `bars` 可读 fin-data 自己落盘的 CSV（不复权），也可走实时源；
 * - 其余 kind 复用 `.dsh/skills/fin-data/adapter/` 的适配器，但那是 fin-data 的内部实现，消费方不直接引用。
 *
 * 错误语义：
 * - 请求本身写错（未知 kind / 少 instrument / 非法标的）→ **抛 `QueryError`**；
 * - 数据取不到（上游挂了、该市场不支持）→ 返回 `ok: false` 的信封，`data` 为 `null`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { get, getMany, listProviders } from '../adapter/index.mjs';
import { parseInstrument } from '../adapter/instruments.mjs';
import { DATA_DIR, readLocalSeries, toBars } from './bars-local.mjs';
import {
  ERROR_CODES,
  KIND_DOCS,
  KINDS,
  QueryError,
  failEnvelope,
  okEnvelope,
} from './contract.mjs';
import { queryFinancials } from './financials.mjs';
import { queryUniverse } from './universe.mjs';

export { ERROR_CODES, KINDS, QueryError, SCHEMA } from './contract.mjs';
export { DATA_DIR, FIN_DATA_ROOT } from './bars-local.mjs';
// 标的解析也由 fin-data 出口统一提供：9c 这类消费方不需要知道它底下是谁实现的。
export { parseInstrument, toSecuCode } from '../adapter/instruments.mjs';
export { toMetricRow, periodFromMetricRow, FINANCIALS } from './financials.mjs';
export { buildMockFinancials } from './mock-financials.mjs';
export { UNIVERSE_IDS } from './universe.mjs';

/** 本地文件里读出的 JSON（manifest / 交易日历 / 标的表）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 以 Asia/Shanghai 为准的 `YYYY-MM-DD`。 */
export function todayShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 交易日历里 <= 今天的最后一个交易日。 */
export function lastClosedSession(dates, today = todayShanghai()) {
  if (!Array.isArray(dates)) return null;
  let latest = null;
  for (const date of dates) {
    if (typeof date === 'string' && date <= today && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

/**
 * 把请求里的 instrument 解析成规范标的。
 * @param {object} request - query request.
 * @returns {object} canonical instrument.
 */
function requireInstrument(request) {
  const instrument = parseInstrument(request.instrument);
  if (instrument === undefined) {
    throw new QueryError(
      ERROR_CODES.INVALID_REQUEST,
      `kind "${request.kind}" 需要合法的 instrument，例如 600519 / sh600519 / cn:601318 / hk:02318`,
      { kind: request.kind },
    );
  }
  return instrument;
}

/** 委托给底层适配器时，各 kind 的 as-of 字段。 */
function asOfOf(kind, data) {
  if (data === null || data === undefined) return null;
  if (kind === 'quote') return data.quoteTime ?? null;
  if (kind === 'bars') return Array.isArray(data.bars) && data.bars.length > 0 ? data.bars.at(-1)[0] : null;
  if (kind === 'fx') return data.time ?? null;
  if (kind === 'search') return null;
  const rows = data.rows;
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0].reportDate ?? rows[0].date ?? rows[0].exDate ?? null;
  }
  return null;
}

/**
 * 其余 kind：交给 `.dsh/skills/fin-data/adapter/` 的适配器，再套上 fin-data 的信封。
 * @param {string} kind - data kind.
 * @param {object} request - query request.
 */
async function delegateQuery(kind, request) {
  const instrument = kind === 'search' || kind === 'fx' ? undefined : requireInstrument(request);
  const result = await get({
    kind,
    instrument: instrument?.key,
    query: request.query,
    pair: request.pair,
    options: request.options,
  });

  if (result.ok !== true) {
    return failEnvelope(kind, instrument?.key ?? null, result.error?.code ?? ERROR_CODES.UPSTREAM_DOWN, result.error?.message ?? '上游不可用', {
      source: result.meta?.source ?? null,
      fetchedAt: result.meta?.fetchedAt ?? null,
      cached: result.meta?.cached === true,
      stale: result.meta?.stale === true,
      ttlMs: result.meta?.ttlMs ?? null,
      degraded: result.meta?.degraded ?? [],
    }, result.warnings ?? []);
  }

  const adjust = kind === 'bars' ? 'qfq' : null;
  return okEnvelope(kind, instrument?.key ?? null, result.data, {
    source: result.meta?.source ?? null,
    fetchedAt: result.meta?.fetchedAt ?? null,
    asOf: asOfOf(kind, result.data),
    cached: result.meta?.cached === true,
    stale: result.meta?.stale === true,
    ttlMs: result.meta?.ttlMs ?? null,
    degraded: result.meta?.degraded ?? [],
    ...(adjust === null ? {} : { adjust }),
  }, result.warnings ?? []);
}

/**
 * `bars`：本地 CSV（不复权）或实时源（前复权）。
 * @param {object} request - query request.
 */
async function barsQuery(request) {
  const instrument = requireInstrument(request);
  const options = request.options ?? {};
  const source = String(options.source ?? 'live').toLowerCase();
  if (!['live', 'local', 'auto'].includes(source)) {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, `bars.source 必须是 live | local | auto，收到 "${options.source}"`, {
      kind: 'bars',
      instrument: instrument.key,
    });
  }

  if (source !== 'live') {
    const local = readLocalSeries(instrument, options);
    if (local.found) {
      return okEnvelope('bars', instrument.key, {
        instrument: instrument.key,
        symbol: local.symbol,
        bars: toBars(local.rows),
        rowCount: local.rows.length,
        local: local.local === true,
        file: path.relative(DATA_DIR, local.file).replaceAll('\\', '/'),
      }, {
        source: 'fin-data/csv',
        asOf: local.rows.at(-1)?.date ?? null,
        stale: false,
        adjust: 'none',
        ttlMs: 0,
      }, local.local === true
        ? ['本地日线来自 `data/local/`（按需拉取，未入库）。']
        : []);
    }
    if (source === 'local') {
      return failEnvelope('bars', instrument.key, ERROR_CODES.NOT_FOUND, `本地没有 ${instrument.key} 的日线（先跑 fin-data update 或用 source=live）`, {
        source: 'fin-data/csv',
        adjust: 'none',
      });
    }
  }

  return delegateQuery('bars', request);
}

/**
 * `status`：数据集状态。回答「数据截至哪天、有多新」只信这一处。
 */
async function statusQuery() {
  const manifest = readJson(path.join(DATA_DIR, 'manifest.json'));
  const calendar = readJson(path.join(DATA_DIR, 'calendar', 'trade-dates.json'));
  const instruments = readJson(path.join(DATA_DIR, 'instruments.json'));
  const dataset = manifest?.datasets?.['daily.cn'] ?? null;
  const today = todayShanghai();
  const closed = lastClosedSession(calendar?.dates, today);
  const lastStored = dataset?.lastTradeDate ?? null;
  const stale = closed !== null && lastStored !== null ? lastStored < closed : null;

  return okEnvelope('status', null, {
    dataset: 'daily.cn',
    timezone: 'Asia/Shanghai',
    today,
    asOf: lastStored,
    coverage: dataset?.coverage ?? null,
    symbolCount: dataset?.symbolCount ?? null,
    rowCount: dataset?.rowCount ?? null,
    byExchange: dataset?.byExchange ?? null,
    sources: dataset?.sources ?? null,
    lastClosedSession: closed,
    stale,
    instruments: instruments?.items !== undefined ? Object.keys(instruments.items).length : null,
    calendar: calendar === null ? null : { source: calendar.source, count: calendar.count, fetchedAt: calendar.fetchedAt },
    providers: listProviders(),
    kinds: KINDS,
    generatedAt: manifest?.generatedAt ?? null,
  }, {
    source: 'fin-data/manifest',
    asOf: lastStored,
    ttlMs: 60_000,
  }, stale === true ? [`本地日线落后一个交易日：最新收盘 ${closed}，本地截至 ${lastStored}，先跑 fin-data update。`] : []);
}

/**
 * 唯一查询入口。
 * @param {object} request - `{ kind, instrument?, query?, pair?, options? }`.
 * @returns {Promise<object>} 查询信封。
 */
export async function query(request) {
  if (request === null || typeof request !== 'object') {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, 'query() 需要一个请求对象，例如 { kind: "quote", instrument: "600519" }');
  }
  const kind = request.kind;
  if (!KINDS.includes(kind)) {
    throw new QueryError(ERROR_CODES.UNKNOWN_KIND, `未知 kind "${kind}"；可用：${KINDS.join(' / ')}`, { kind });
  }

  if (kind === 'status') return statusQuery(request);
  if (kind === 'universe') return queryUniverse(request);
  if (kind === 'financials') {
    const instrument = requireInstrument(request);
    try {
      return await queryFinancials({ ...request, instrument });
    } catch (error) {
      if (error instanceof QueryError) throw error;
      return failEnvelope(kind, instrument.key, ERROR_CODES.UPSTREAM_DOWN, error instanceof Error ? error.message : String(error), {});
    }
  }
  if (kind === 'bars') return barsQuery(request);
  return delegateQuery(kind, request);
}

/**
 * 批量查询（主要用于看板自选股：一次请求拿 N 个快照）。
 *
 * `quote` 会走底层适配器的批量接口（一次上游请求）；其他 kind 并发调用 `query()`。
 * @param {object} request - `{ kind, instruments, options }`.
 * @returns {Promise<object>} `{ schema, ok, kind, items, meta, warnings }`
 */
export async function queryMany(request) {
  if (request === null || typeof request !== 'object') {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, 'queryMany() 需要一个请求对象');
  }
  const kind = request.kind;
  if (!KINDS.includes(kind) || kind === 'status' || kind === 'universe') {
    throw new QueryError(ERROR_CODES.UNKNOWN_KIND, `queryMany() 不支持 kind "${kind}"`, { kind });
  }
  const instruments = request.instruments;
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, 'queryMany() 需要非空的 instruments 数组', { kind });
  }

  const list = instruments.map((value) => {
    const instrument = parseInstrument(value);
    if (instrument === undefined) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, `非法标的 "${value}"`, { kind });
    }
    return instrument;
  });

  let items;
  if (kind === 'quote') {
    const result = await getMany({ kind, instruments: list.map((instrument) => instrument.key), options: request.options });
    items = list.map((instrument) => {
      const found = result.items.find((item) => item.instrument === instrument.key);
      if (found === undefined) {
        return failEnvelope(kind, instrument.key, ERROR_CODES.NOT_FOUND, '批量接口没有返回该标的', {});
      }
      if (found.ok !== true) {
        return failEnvelope(kind, instrument.key, found.error?.code ?? ERROR_CODES.UPSTREAM_DOWN, found.error?.message ?? '上游不可用', {
          degraded: found.meta?.degraded ?? [],
        });
      }
      return okEnvelope(kind, instrument.key, found.data, {
        source: found.meta?.source ?? null,
        fetchedAt: found.meta?.fetchedAt ?? null,
        asOf: asOfOf(kind, found.data),
        cached: found.meta?.cached === true,
        stale: found.meta?.stale === true,
        ttlMs: found.meta?.ttlMs ?? null,
        degraded: found.meta?.degraded ?? [],
      });
    });
    const stale = items.some((item) => item.meta.stale === true);
    return {
      schema: 'fin-data.query/v1',
      ok: items.some((item) => item.ok === true),
      kind,
      items,
      invalid: result.invalid ?? [],
      meta: {
        sources: [...new Set(items.map((item) => item.meta.source).filter((source) => source !== null))],
        stale,
        fetchedAt: result.meta?.fetchedAt ?? null,
        degraded: result.meta?.degraded ?? [],
      },
      warnings: [],
    };
  }

  items = await Promise.all(list.map((instrument) => query({ kind, instrument: instrument.key, options: request.options })));
  const stale = items.some((item) => item.meta?.stale === true);
  return {
    schema: 'fin-data.query/v1',
    ok: items.some((item) => item.ok === true),
    kind,
    items,
    invalid: [],
    meta: {
      sources: [...new Set(items.map((item) => item.meta.source).filter((source) => source !== null))],
      stale,
      fetchedAt: new Date().toISOString(),
      degraded: [],
    },
    warnings: [],
  };
}

/**
 * 入口自述：有哪些 kind、各自怎么取数、底层适配器是谁。
 * 给 `stock-data.mjs providers`、看板调试面板与文档共用。
 */
export function describe() {
  return {
    schema: 'fin-data.query/v1',
    entry: 'skills/fin-data/api/index.mjs',
    cli: 'node .dsh/skills/fin-data/api/cli.mjs',
    kinds: KINDS.map((kind) => ({
      kind,
      description: KIND_DOCS[kind] ?? '',
      implementation: kind === 'status' ? 'fin-data/manifest'
        : kind === 'financials' ? 'eastmoney f10 + mock-financials'
          : kind === 'universe' ? 'data/universes（本地）| eastmoney b:DLMK0144（港股通）'
            : kind === 'bars' ? 'fin-data/csv（source=local）| tencent（source=live）'
              : 'fin-data 内部适配器',
      mock: kind === 'financials',
    })),
    providers: listProviders(),
    markets: ['cn', 'hk'],
    disclaimer: '模拟财报仅用于打通接口，不代表真实数据。',
  };
}
