/**
 * Host half of the Financial Dashboard bundle.
 *
 * One read-only route, `GET /financial-dashboard/quotes`, serves snapshot
 * quotes for a watchlist plus an optional daily K-line series to the browser
 * half. It answers only same-origin, authenticated browser requests: every
 * request first asks the composition's `connection` service for a rejection
 * (Host/Origin fence + browser authentication) before any upstream work.
 *
 * Fetching, normalization, caching, and stale fallback all live in the shared
 * data layer (`../../data/index.mjs`); this file only adapts the unified result
 * to the response shape the client already understands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, getMany } from '../../data/index.mjs';
import { parseInstrument } from '../../data/instruments.mjs';
import {
  STORE_FILE,
  THRESHOLDS,
  UNIVERSE,
  dateKey,
  listDays,
  readStore,
  runSelection,
  writeStore,
} from './picks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Cordis function-plugin name. */
export const name = 'financial-dashboard';

/** The route carrier and the trust fence guarding it. */
export const inject = ['webServer', 'connection'];

/** The exact route path the browser half calls. */
export const ROUTE_PATH = '/financial-dashboard/quotes';

/** 龟龟选股：当日榜单与历史记录。 */
export const PICKS_ROUTE_PATH = '/financial-dashboard/picks';

/** 全看板每天只在 16:05（香港/北京时间，港股收盘后）跑一次。 */
export const DAILY_HOUR = 16;

/** 16:05 抓港股收盘价（16:00 收盘，留 5 分钟给收盘竞价落定）。 */
export const DAILY_MINUTE = 5;

/** 下一次 16:05（香港/北京时间）的毫秒时间戳；测试也用它。 */
export function nextDailyRun(now = Date.now()) {
  const offset = 8 * 60 * 60 * 1000;
  const shanghai = new Date(now + offset);
  let target = Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate(),
    DAILY_HOUR - 8,
    DAILY_MINUTE,
    0,
  );
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target;
}

/** 16:05 预热的默认行情组合：两个指数 + 自选股，附一条日线。 */
export const DEFAULT_QUOTES = {
  codes: ['sh000001', 'sz399001', 'sh600519', 'sz000001'],
  daily: 'sh600519',
};

/** 当日行情快照落盘位置（运行期数据，git 忽略）。 */
const SNAPSHOT_FILE = path.join(HERE, '.data', 'quotes.json');

/** Upper bound on the codes one request may ask for. */
export const MAX_CODES = 24;

/** Daily bars the dashboard charts. */
const DAILY_BARS = 120;

/**
 * Re-export the snapshot parser so existing tooling keeps one import site.
 * @deprecated import from `data/providers/tencent.mjs` instead.
 */
export { parseQuoteText as parseSnapshot } from '../../data/providers/tencent.mjs';

/**
 * Map a normalized quote onto the field names the client reads.
 * @param quote - normalized quote from the data layer.
 * @returns the client-facing quote.
 */
export function toClientQuote(quote) {
  return {
    code: quote.code,
    name: quote.name,
    price: quote.price,
    prevClose: quote.prevClose,
    open: quote.open,
    volume: quote.volume,
    change: quote.change,
    changePct: quote.changePct,
    high: quote.high,
    low: quote.low,
    amount: quote.amount,
    turnover: quote.turnoverRate,
    pe: quote.peTtm,
    totalCap: quote.totalCapYi,
    floatCap: quote.floatCapYi,
    time: quote.quoteTime,
  };
}

/**
 * Normalize the comma-separated `codes` query value.
 * @param value - raw query value.
 * @returns accepted, de-duplicated codes in request order, capped by `MAX_CODES`.
 */
export function normalizeCodes(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  const codes = [];
  for (const raw of value.split(',')) {
    const instrument = parseInstrument(raw);
    if (instrument === undefined || seen.has(instrument.key)) continue;
    seen.add(instrument.key);
    codes.push(instrument.key);
    if (codes.length >= MAX_CODES) break;
  }
  return codes;
}

/**
 * Register the quotes route.
 * @param ctx - Host context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  const sendJson = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  /** Answer an untrusted or unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection({ headers: req.headers });
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /** Collect the reasons the data layer could not answer, for the error field. */
  const failureMessage = (result) => {
    const reasons = result.items.flatMap((item) => [
      ...(typeof item.error?.message === 'string' ? [item.error.message] : []),
      ...(item.meta?.degraded ?? []).map((entry) => entry.message),
    ]);
    return reasons[0] ?? 'upstream unavailable';
  };

  /** 当日行情快照：`{ date, entries: { key: payload } }`，一天一份，16:05 覆盖。 */
  const readSnapshot = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.entries === 'object') return parsed;
    } catch {
      /* 首次运行 */
    }
    return { date: null, entries: {} };
  };

  const writeSnapshot = (value) => {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    const temp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, SNAPSHOT_FILE);
  };

  /** 拉一份行情 +（可选）日线，拼成客户端认识的响应体。 */
  const buildQuotes = async (codes, dailyInstrument) => {
    const [snapshot, daily] = await Promise.all([
      getMany({ kind: 'quote', instruments: codes }),
      dailyInstrument === undefined
        ? Promise.resolve(undefined)
        : get({ kind: 'bars', instrument: dailyInstrument.key, options: { limit: DAILY_BARS } }),
    ]);

    const quotes = snapshot.items.filter((item) => item.ok === true).map((item) => toClientQuote(item.data));
    const dailyStale = daily !== undefined && (daily.ok !== true || daily.meta.stale === true);
    const stale = snapshot.meta.stale || dailyStale;
    const degraded = snapshot.items.some(
      (item) => item.ok !== true || (item.meta?.degraded?.length ?? 0) > 0,
    );
    const error = degraded ? failureMessage(snapshot) : undefined;

    return {
      ok: quotes.length > 0,
      stale,
      fetchedAt: snapshot.meta.fetchedAt,
      quotes,
      ...(daily === undefined
        ? {}
        : {
            daily: {
              code: dailyInstrument.code,
              bars: daily.ok === true ? daily.data.bars : [],
              stale: dailyStale,
            },
          }),
      ...(error === undefined ? {} : { error }),
    };
  };

  const handler = async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      res.end();
      return;
    }

    const url = new URL(String(req.url ?? ''), 'http://localhost');
    const codes = normalizeCodes(url.searchParams.get('codes') ?? '');
    if (codes.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: 'codes must be a comma-separated list of sh/sz/bj/hk codes',
        quotes: [],
      });
      return;
    }

    const dailyInstrument = parseInstrument(url.searchParams.get('daily') ?? '');
    const key = `${codes.join(',')}|${dailyInstrument?.key ?? ''}`;
    const force = url.searchParams.get('refresh') === '1';
    const stored = readSnapshot();
    const today = dateKey();

    // 一天只打一次上游：当天已有这份快照就直接复用；手动 refresh 才重拉。
    if (!force && stored.date === today && stored.entries?.[key] !== undefined) {
      sendJson(res, 200, { ...stored.entries[key], cached: true });
      return;
    }
    if (!force && stored.date !== null && stored.date !== today && stored.entries?.[key] !== undefined) {
      sendJson(res, 200, { ...stored.entries[key], cached: true, carriedOver: true, date: stored.date });
      return;
    }

    const payload = await buildQuotes(codes, dailyInstrument);
    if (payload.ok && payload.stale !== true) {
      const next = stored.date === today ? stored : { date: today, entries: {} };
      next.entries[key] = payload;
      writeSnapshot(next);
    }
    sendJson(res, 200, { ...payload, date: today });
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    `financial-dashboard: GET ${ROUTE_PATH}`,
  );

  /* ------------------------------------------------------------------ */
  /*                            龟龟选股                                 */
  /* ------------------------------------------------------------------ */

  /** 同一时刻只允许跑一次选股；并发请求共享这个 promise。 */
  let running = null;

  /**
   * 保证「今天」有一份结果：已有就直接读，没有就跑一次并落盘。
   * @param force - true 时强制重跑并覆盖当天结果（手动刷新用）。
   */
  const ensureToday = (force = false) => {
    const today = dateKey();
    const store = readStore(STORE_FILE);
    const existing = store.runs?.[today];
    if (!force && existing !== undefined) return Promise.resolve(existing);
    if (running !== null) return running;
    running = (async () => {
      const result = await runSelection();
      const latest = readStore(STORE_FILE);
      const runs = { ...(latest.runs ?? {}) };
      runs[result.date] = result;
      writeStore({ version: 1, updatedAt: new Date().toISOString(), runs });
      return result;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const picksHandler = async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      res.end();
      return;
    }

    const url = new URL(String(req.url ?? ''), 'http://localhost');
    try {
      if (url.searchParams.get('history') === '1') {
        sendJson(res, 200, { ok: true, days: listDays(readStore(STORE_FILE)) });
        return;
      }

      const date = url.searchParams.get('date') ?? '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date !== dateKey()) {
        const run = readStore(STORE_FILE).runs?.[date];
        if (run === undefined) {
          sendJson(res, 404, { ok: false, error: `没有 ${date} 的选股记录` });
          return;
        }
        sendJson(res, 200, { ok: true, ...run, historical: true, thresholds: THRESHOLDS });
        return;
      }

      // 看板每天 16:05 生成一份；当天还没生成时，沿用最近一份并标明日期。
      const store = readStore(STORE_FILE);
      const today = dateKey();
      const run = store.runs?.[today];
      if (run !== undefined) {
        sendJson(res, 200, {
          ok: true,
          ...run,
          historical: false,
          thresholds: THRESHOLDS,
          universeSize: UNIVERSE.length,
        });
        return;
      }

      if (url.searchParams.get('refresh') === '1') {
        const forced = await ensureToday(true);
        sendJson(res, 200, {
          ok: true,
          ...forced,
          historical: false,
          thresholds: THRESHOLDS,
          universeSize: UNIVERSE.length,
        });
        return;
      }

      const latest = Object.values(store.runs ?? {}).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      if (latest === undefined) {
        // 全新安装：没有任何历史，先跑一次做种子。
        const seeded = await ensureToday(true);
        sendJson(res, 200, {
          ok: true,
          ...seeded,
          historical: false,
          thresholds: THRESHOLDS,
          universeSize: UNIVERSE.length,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...latest,
        historical: true,
        carriedOver: true,
        thresholds: THRESHOLDS,
        universeSize: UNIVERSE.length,
        nextRunAt: nextDailyRunIso(),
      });
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PICKS_ROUTE_PATH, handler: picksHandler }),
    `financial-dashboard: GET ${PICKS_ROUTE_PATH}`,
  );

  /* ------------------------------------------------------------------ */
  /*                        每天 16:05 跑一次                            */
  /* ------------------------------------------------------------------ */

  const nextDailyRunIso = () => new Date(nextDailyRun()).toISOString();

  /** 16:05 的日常：选股 + 行情快照。 */
  const runDaily = async (force) => {
    await ensureToday(force).catch(() => {
      /* 上游不可用时保留旧结果 */
    });
    const codes = DEFAULT_QUOTES.codes.map((code) => parseInstrument(code)?.key).filter((key) => key !== undefined);
    const dailyInstrument = parseInstrument(DEFAULT_QUOTES.daily);
    const payload = await buildQuotes(codes, dailyInstrument).catch(() => null);
    if (payload !== null && payload.ok && payload.stale !== true) {
      const today = dateKey();
      const stored = readSnapshot();
      const next = stored.date === today ? stored : { date: today, entries: {} };
      next.entries[`${codes.join(',')}|${dailyInstrument?.key ?? ''}`] = payload;
      writeSnapshot(next);
    }
  };

  ctx.effect(() => {
    let timer;

    const schedule = () => {
      const delay = Math.max(1_000, nextDailyRun() - Date.now());
      timer = setTimeout(async () => {
        await runDaily(true).catch(() => {});
        schedule();
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
    };

    // 启动补跑：今天 16:05 已过、且当天还没有结果时补一次（保证一天只有一份）。
    const catchUp = setTimeout(() => {
      const now = Date.now();
      const today = dateKey();
      const missing = readStore(STORE_FILE).runs?.[today] === undefined;
      const shanghai = new Date(now + 8 * 60 * 60 * 1000);
      const todayAt15 = Date.UTC(
        shanghai.getUTCFullYear(),
        shanghai.getUTCMonth(),
        shanghai.getUTCDate(),
        DAILY_HOUR - 8,
        DAILY_MINUTE,
        0,
      );
      if (missing && now >= todayAt15) runDaily(false).catch(() => {});
    }, 5_000);
    if (typeof catchUp.unref === 'function') catchUp.unref();

    schedule();
    return () => {
      clearTimeout(catchUp);
      clearTimeout(timer);
    };
  }, 'financial-dashboard: 16:05 daily run');
}
