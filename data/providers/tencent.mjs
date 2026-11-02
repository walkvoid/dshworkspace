/**
 * Tencent quotes: A shares and Hong Kong shares from the same snapshot feed.
 *
 * The upstream reuses one endpoint for both markets but lays the fields out
 * differently (Hong Kong inserts the English name, the currency, and the
 * dividend yield). Normalizing that difference here is the whole point of the
 * provider: consumers see one quote shape, `currency` aside.
 *
 * Fields are positional, so the parsers are covered by fixtures under
 * `data/test/fixtures/`; a layout change must break a test, not the answer.
 */
import { fetchJson, fetchText } from '../http.mjs';
import { ERROR_CODES, ProviderError, asProviderError } from '../errors.mjs';
import { toTencentCode } from '../instruments.mjs';

/** Snapshot feed: codes are appended comma-separated. */
const SNAPSHOT_URL = 'https://qt.gtimg.cn/q=';

/** Name search (smartbox). */
const HINT_URL = 'https://smartbox.gtimg.cn/s3/?t=all&q=';

/** Adjusted daily K-line feed. */
const BARS_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** Foreign-exchange feed: the pair is the query. */
const FX_URL = 'https://qt.gtimg.cn/q=wh';

/**
 * Parse a foreign-exchange snapshot.
 * @param text - decoded feed body.
 * @param pair - expected pair, e.g. `HKDCNY`.
 * @returns `{ pair, rate, time }`, or `undefined` when the feed has no record.
 */
export function parseFx(text, pair) {
  const pattern = new RegExp(`v_wh${pair}="([^"]*)"`, 'i');
  const match = pattern.exec(text);
  if (match === null) return undefined;
  const fields = match[1].split('~');
  const rate = Number(fields[3]);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return {
    pair: pair.toUpperCase(),
    name: (fields[1] ?? '').trim() || pair.toUpperCase(),
    rate,
    time: (fields[5] ?? '').trim() || null,
  };
}

/** One `v_<code>="a~b~c…";` record. */
const RECORD = /v_([a-z]{2}\d{4,6})="([^"]*)"/g;

/** Read one `~`-separated field as a finite number, or `null`. */
function num(fields, index) {
  const raw = fields[index];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a snapshot body into normalized quotes.
 * @param text - decoded body (the feed is GBK, decoded by the caller).
 * @returns one quote per record, in feed order.
 */
export function parseQuoteText(text) {
  const quotes = [];
  RECORD.lastIndex = 0;
  let match;
  while ((match = RECORD.exec(text)) !== null) {
    const feedCode = match[1].toLowerCase();
    const fields = match[2].split('~');
    if (fields.length < 35) continue;
    const market = feedCode.startsWith('hk') ? 'hk' : 'cn';
    const digits = feedCode.replace(/^[a-z]{2}/, '');
    const quote = {
      market,
      code: market === 'hk' ? digits.padStart(5, '0') : feedCode,
      instrument: `${market}:${market === 'hk' ? digits.padStart(5, '0') : feedCode}`,
      name: (fields[1] ?? '').trim(),
      price: num(fields, 3),
      prevClose: num(fields, 4),
      open: num(fields, 5),
      volume: num(fields, 6),
      quoteTime: (fields[30] ?? '').trim() || null,
      change: num(fields, 31),
      changePct: num(fields, 32),
      high: num(fields, 33),
      low: num(fields, 34),
      amount: num(fields, 37),
      peTtm: num(fields, 39),
      totalCapYi: num(fields, 45),
      floatCapYi: num(fields, 44),
      currency: market === 'hk' ? 'HKD' : 'CNY',
    };
    if (market === 'cn') {
      // A-share layout: turnover rate at 38 and price/book at 46.
      quote.turnoverRate = num(fields, 38);
      quote.pb = num(fields, 46);
      quote.dividendYield = null;
    } else {
      // Hong Kong layout: English name at 46 shifts price/book; the dividend
      // yield sits at 47. Turnover rate is not published for this market.
      quote.turnoverRate = null;
      quote.pb = null;
      quote.dividendYield = num(fields, 47);
    }
    quotes.push(quote);
  }
  return quotes;
}

/**
 * Parse the smartbox name search body.
 * @param text - decoded body, shape `v_hint="sh~601318~中国平安~zgpa~GP-A^hk~02318~…"`.
 * @returns candidates in feed order.
 */
export function parseSmartbox(text) {
  const match = /v_hint="([\s\S]*)"/.exec(text);
  if (match === null) return [];
  let body;
  try {
    body = JSON.parse(`"${match[1]}"`);
  } catch {
    body = match[1];
  }
  const candidates = [];
  for (const segment of body.split('^')) {
    const [market, code, name, , kind] = segment.split('~');
    if (market !== 'sh' && market !== 'sz' && market !== 'bj' && market !== 'hk') continue;
    if (market === 'hk') {
      if (!/^\d{4,5}$/.test(code ?? '')) continue;
      const digits = code.padStart(5, '0');
      candidates.push({ market: 'hk', code: digits, instrument: `hk:${digits}`, name, kind: kind ?? null });
      continue;
    }
    if (!/^\d{6}$/.test(code ?? '')) continue;
    candidates.push({ market: 'cn', code: `${market}${code}`, instrument: `cn:${market}${code}`, name, kind: kind ?? null });
  }
  return candidates;
}

/**
 * Parse the K-line feed into `[date, open, close, high, low, volume]` bars.
 * @param body - parsed JSON body.
 * @param code - the feed code that was requested.
 * @returns newest-last bars; empty when the feed returned nothing usable.
 */
export function parseBars(body, code) {
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

/** Upper bound on codes per snapshot request, mirroring the feed's practical limit. */
const MAX_BATCH = 24;

export const tencentProvider = {
  name: 'tencent',
  capabilities: {
    kinds: ['quote', 'bars', 'search', 'fx'],
    markets: ['cn', 'hk'],
  },

  /**
   * Batch quotes for a watchlist: one upstream request for N instruments.
   * @param request - normalized request carrying `instruments`.
   * @returns `{ data: { byInstrument } }` keyed by canonical instrument.
   */
  async fetchMany(request) {
    const instruments = request.instruments ?? [];
    if (instruments.length === 0) {
      throw new ProviderError('tencent', ERROR_CODES.BAD_SHAPE, 'fetchMany requires at least one instrument');
    }
    if (instruments.length > MAX_BATCH) {
      throw new ProviderError('tencent', ERROR_CODES.BAD_SHAPE, `fetchMany accepts at most ${MAX_BATCH} instruments`);
    }
    try {
      const codes = instruments.map(toTencentCode);
      const text = await fetchText(`${SNAPSHOT_URL}${codes.join(',')}`, { encoding: 'gbk', referer: 'https://gu.qq.com/' });
      const quotes = parseQuoteText(text);
      if (quotes.length === 0) {
        throw new ProviderError('tencent', ERROR_CODES.BAD_SHAPE, 'batch snapshot returned no quotes');
      }
      const byInstrument = {};
      for (const quote of quotes) byInstrument[quote.instrument] = quote;
      return { data: { byInstrument } };
    } catch (error) {
      throw asProviderError('tencent', error);
    }
  },

  /**
   * @param request - normalized request from `data/index.mjs`.
   * @returns normalized payload for the requested kind.
   */
  async fetch(request) {
    const { kind, instrument } = request;
    try {
      if (kind === 'search') {
        const text = await fetchText(`${HINT_URL}${encodeURIComponent(request.query)}`);
        const candidates = parseSmartbox(text);
        if (candidates.length === 0) {
          throw new ProviderError('tencent', ERROR_CODES.NOT_FOUND, `no candidate for "${request.query}"`);
        }
        return { data: { candidates } };
      }

      if (kind === 'fx') {
        const pair = String(request.pair ?? '').toUpperCase();
        const text = await fetchText(`${FX_URL}${pair}`, { encoding: 'gbk', referer: 'https://gu.qq.com/' });
        const parsed = parseFx(text, pair);
        if (parsed === undefined) {
          throw new ProviderError('tencent', ERROR_CODES.NOT_FOUND, `no fx quote for ${pair}`);
        }
        return { data: parsed };
      }

      const feedCode = toTencentCode(instrument);

      if (kind === 'quote') {
        const text = await fetchText(`${SNAPSHOT_URL}${feedCode}`, { encoding: 'gbk', referer: 'https://gu.qq.com/' });
        const quotes = parseQuoteText(text);
        const quote = quotes.find((item) => item.instrument === instrument.key);
        if (quote === undefined) {
          throw new ProviderError('tencent', ERROR_CODES.NOT_FOUND, `no quote for ${instrument.key}`);
        }
        return { data: quote };
      }

      if (kind === 'bars') {
        const query = new URLSearchParams({ param: `${feedCode},day,,,${request.options?.limit ?? 120},qfq` });
        const body = await fetchJson(`${BARS_URL}?${query}`, { referer: 'https://gu.qq.com/' });
        const bars = parseBars(body, feedCode);
        if (bars.length === 0) {
          throw new ProviderError('tencent', ERROR_CODES.BAD_SHAPE, `no bars for ${instrument.key}`);
        }
        return { data: { instrument: instrument.key, bars } };
      }

      throw new ProviderError('tencent', ERROR_CODES.UNSUPPORTED, `kind "${kind}" is not served by tencent`);
    } catch (error) {
      throw asProviderError('tencent', error);
    }
  },
};
