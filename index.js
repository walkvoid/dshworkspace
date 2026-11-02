/**
 * Host half of the Financial Dashboard bundle.
 *
 * One read-only route, `GET /financial-dashboard/quotes`, proxies Tencent's
 * quote feed and its daily K-line feed to the browser half. The route answers
 * only same-origin, authenticated browser requests: every request first asks
 * the composition's `connection` service for a rejection (Host/Origin fence +
 * browser authentication) before any upstream work happens.
 *
 * Both feeds keep a process-local memory cache, keyed by request:
 * - snapshot quotes: 10 s, keyed by the normalized code list;
 * - daily K-lines: 5 min, keyed by the stock code.
 * A failed refresh never empties the response: the last cached payload is
 * returned with `stale: true` so the dashboard degrades instead of blanking.
 */

/** Cordis function-plugin name. */
export const name = 'financial-dashboard';

/** The route carrier and the trust fence guarding it. */
export const inject = ['webServer', 'connection'];

/** The exact route path the browser half calls. */
export const ROUTE_PATH = '/financial-dashboard/quotes';

/** Tencent snapshot feed; codes are appended comma-separated. */
const SNAPSHOT_URL = 'https://qt.gtimg.cn/q=';

/** Tencent adjusted daily K-line feed; the code is part of the query. */
const DAILY_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** Snapshot cache lifetime. */
const SNAPSHOT_TTL_MS = 10_000;

/** Daily K-line cache lifetime. */
const DAILY_TTL_MS = 5 * 60_000;

/** Upstream timeout, so one hung request cannot pin a cache entry open. */
const FETCH_TIMEOUT_MS = 8_000;

/** Upper bound on the codes one request may ask for. */
const MAX_CODES = 24;

/** Upper bound on retained cache entries per feed. */
const MAX_CACHE_ENTRIES = 40;

/** Accepted code shape: exchange prefix plus six digits. */
const CODE_PATTERN = /^(sh|sz|bj)\d{6}$/;

/** The feed rejects default Node clients, so identify as a browser. */
const UPSTREAM_HEADERS = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  referer: 'https://gu.qq.com/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

/**
 * Normalize one candidate code.
 * @param value - raw query value.
 * @returns the lower-case code, or `undefined` when it is not an accepted code.
 */
export function normalizeCode(value) {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : undefined;
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
    const code = normalizeCode(raw);
    if (code === undefined || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
    if (codes.length >= MAX_CODES) break;
  }
  return codes;
}

/**
 * Decode an upstream body. The snapshot feed is GBK; the K-line feed is UTF-8.
 * @param bytes - raw response bytes.
 * @param encoding - preferred encoding label.
 * @returns decoded text.
 */
export function decodeUpstream(bytes, encoding = 'gbk') {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Read one `~`-separated field as a finite number, or `null` when absent. */
function numberField(fields, index) {
  const raw = fields[index];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse the snapshot feed's `v_<code>="a~b~c…";` lines.
 * @param text - decoded upstream body.
 * @returns one quote per parsed line, in feed order.
 */
export function parseSnapshot(text) {
  const quotes = [];
  const pattern = /v_([a-z]{2}\d{6})="([^"]*)"/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const fields = match[2].split('~');
    if (fields.length < 35) continue;
    quotes.push({
      code: match[1].toLowerCase(),
      name: (fields[1] ?? '').trim(),
      price: numberField(fields, 3),
      prevClose: numberField(fields, 4),
      open: numberField(fields, 5),
      volume: numberField(fields, 6),
      change: numberField(fields, 31),
      changePct: numberField(fields, 32),
      high: numberField(fields, 33),
      low: numberField(fields, 34),
      amount: numberField(fields, 37),
      turnover: numberField(fields, 38),
      pe: numberField(fields, 39),
      totalCap: numberField(fields, 45),
      floatCap: numberField(fields, 44),
      time: (fields[30] ?? '').trim() || null,
    });
  }
  return quotes;
}

/**
 * Parse the K-line feed into `[date, open, close, high, low, volume]` bars.
 * @param body - decoded upstream JSON.
 * @param code - the requested code.
 * @returns newest-last bars; empty when the feed returned nothing usable.
 */
export function parseDaily(body, code) {
  const node = body?.data?.[code];
  const rows = node?.qfqday ?? node?.day;
  if (!Array.isArray(rows)) return [];
  const bars = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    if (![open, close, high, low].every(Number.isFinite)) continue;
    const volume = Number(row[5]);
    bars.push([String(row[0]), open, close, high, low, Number.isFinite(volume) ? volume : 0]);
  }
  return bars;
}

/** Bounded insertion-order cache eviction. */
function trimCache(cache, limit) {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}

/** A short, safe error message for a rejected upstream call. */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Register the quotes route.
 * @param ctx - Host context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  /** Normalized code list -> the last good snapshot. */
  const snapshotCache = new Map();
  /** Code -> the last good daily series. */
  const dailyCache = new Map();
  /** Request-deduplication for concurrent identical upstream calls. */
  const inflight = new Map();

  /** Run `task` once per key while it is pending. */
  const once = (key, task) => {
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const running = task().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, running);
    return running;
  };

  const fetchUpstream = async (url) => {
    const response = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    return response.arrayBuffer();
  };

  const fetchSnapshot = async (codes) => {
    const bytes = await fetchUpstream(`${SNAPSHOT_URL}${codes.join(',')}`);
    const quotes = parseSnapshot(decodeUpstream(bytes, 'gbk'));
    if (quotes.length === 0) throw new Error('upstream returned no quotes');
    return quotes;
  };

  const fetchDaily = async (code) => {
    const query = new URLSearchParams({ param: `${code},day,,,120,qfq` });
    const bytes = await fetchUpstream(`${DAILY_URL}?${query.toString()}`);
    const text = decodeUpstream(bytes, 'utf-8');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('upstream returned malformed K-line JSON');
    }
    const bars = parseDaily(body, code);
    if (bars.length === 0) throw new Error('upstream returned no daily bars');
    return bars;
  };

  /**
   * Resolve one snapshot, from cache when fresh, then upstream, then the last
   * cached payload marked stale.
   * @param codes - normalized codes to ask for.
   */
  const readSnapshot = async (codes) => {
    const key = codes.join(',');
    const cached = snapshotCache.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < SNAPSHOT_TTL_MS) {
      return { quotes: cached.quotes, fetchedAt: cached.fetchedAt, stale: false, cached: true };
    }
    try {
      const quotes = await once(`snapshot:${key}`, () => fetchSnapshot(codes));
      const fetchedAt = Date.now();
      snapshotCache.set(key, { at: fetchedAt, quotes, fetchedAt });
      trimCache(snapshotCache, MAX_CACHE_ENTRIES);
      return { quotes, fetchedAt, stale: false, cached: false };
    } catch (error) {
      if (cached !== undefined) {
        return {
          quotes: cached.quotes,
          fetchedAt: cached.fetchedAt,
          stale: true,
          cached: true,
          error: errorMessage(error),
        };
      }
      return {
        quotes: [],
        fetchedAt: null,
        stale: true,
        cached: false,
        ok: false,
        error: errorMessage(error),
      };
    }
  };

  /**
   * Resolve one daily series under the same fresh / upstream / stale-cache rule.
   * @param code - normalized code.
   */
  const readDaily = async (code) => {
    const cached = dailyCache.get(code);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < DAILY_TTL_MS) {
      return { code, bars: cached.bars, fetchedAt: cached.fetchedAt, stale: false };
    }
    try {
      const bars = await once(`daily:${code}`, () => fetchDaily(code));
      const fetchedAt = Date.now();
      dailyCache.set(code, { at: fetchedAt, bars, fetchedAt });
      trimCache(dailyCache, MAX_CACHE_ENTRIES);
      return { code, bars, fetchedAt, stale: false };
    } catch (error) {
      if (cached !== undefined) {
        return {
          code,
          bars: cached.bars,
          fetchedAt: cached.fetchedAt,
          stale: true,
          error: errorMessage(error),
        };
      }
      return { code, bars: [], fetchedAt: null, stale: true, error: errorMessage(error) };
    }
  };

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
        error: 'codes must be a comma-separated list of sh/sz/bj codes',
        quotes: [],
      });
      return;
    }
    const dailyCode = normalizeCode(url.searchParams.get('daily') ?? '');
    const snapshot = await readSnapshot(codes);
    const daily = dailyCode === undefined ? undefined : await readDaily(dailyCode);
    sendJson(res, 200, {
      ok: snapshot.ok !== false,
      stale: snapshot.stale || daily?.stale === true,
      fetchedAt: snapshot.fetchedAt,
      quotes: snapshot.quotes,
      ...(daily === undefined ? {} : { daily }),
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    });
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    `financial-dashboard: GET ${ROUTE_PATH}`,
  );
}
