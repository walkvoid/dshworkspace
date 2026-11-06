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
import { get, getMany } from '../../data/index.mjs';
import { parseInstrument } from '../../data/instruments.mjs';

/** Cordis function-plugin name. */
export const name = 'financial-dashboard';

/** The route carrier and the trust fence guarding it. */
export const inject = ['webServer', 'connection'];

/** The exact route path the browser half calls. */
export const ROUTE_PATH = '/financial-dashboard/quotes';

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

    sendJson(res, 200, {
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
    });
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    `financial-dashboard: GET ${ROUTE_PATH}`,
  );
}
