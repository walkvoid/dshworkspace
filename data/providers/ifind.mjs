/**
 * iFinD (同花顺) provider, backed by the vendor's MCP service.
 *
 * The MCP client ships with the `ifind-finance-data` skill (`call-node.js`), so
 * this provider is a thin adapter: it loads that client, asks for a structured
 * real-time snapshot, and normalizes the returned table into the same quote
 * shape the rest of the layer uses.
 *
 * Only the structured tools are wired here. `get_stock_financials` and the
 * Hong Kong tools take a natural-language `query`, so their columns depend on
 * what the caller typed — good for an agent reading the answer, unsafe for a
 * pipeline that must reproduce the same number twice.
 *
 * The provider is optional: without a configured key it reports UNSUPPORTED and
 * the router falls through to the next provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, ProviderError, asProviderError } from '../errors.mjs';

/**
 * Where the vendor skill may live, in priority order.
 *
 * The install guide lets the user choose a skill root — project level (inside the
 * repository) or user level (`~/.dsh/skills`). Both are valid, so the provider
 * searches every root the harness itself scans instead of pinning one path;
 * otherwise a user-level install would be silently ignored and quotes would
 * quietly fall back to Tencent.
 */
function candidateDirs() {
  const home = os.homedir();
  return [
    process.env.IFIND_SKILL_DIR,
    path.resolve(fileURLToPath(new URL('../../.dsh/skills/ifind-finance-data', import.meta.url))),
    path.join(home, '.dsh', 'skills', 'ifind-finance-data'),
    path.join(home, '.agents', 'skills', 'ifind-finance-data'),
    path.join(home, '.config', 'agents', 'skills', 'ifind-finance-data'),
    path.join(home, '.claude', 'skills', 'ifind-finance-data'),
  ].filter((dir) => typeof dir === 'string' && dir !== '');
}

/**
 * Locate the installed skill by looking for its entry point.
 * @returns the absolute directory, or `null` when it is not installed anywhere.
 */
export function resolveSkillDir() {
  for (const dir of candidateDirs()) {
    if (fs.existsSync(path.join(dir, 'call-node.js'))) return dir;
  }
  return null;
}

/** Indicators we ask for; the service caps a request at ten. */
const INDICATORS = '最新价,涨跌幅,开盘价,最高价,最低价,成交额,成交量,总市值,市盈率TTM,市净率';

/** The service accepts at most ten symbols per call. */
const MAX_SYMBOLS = 10;

/** Cached CommonJS entry point, loaded on first use. */
let cachedClient;

/**
 * Read the key from the skill config without echoing it.
 * @param skillDir - skill directory; defaults to the resolved install location.
 * @returns `true` when a real key is configured.
 */
export function isConfigured(skillDir = resolveSkillDir()) {
  if (skillDir === null) return false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(skillDir, 'mcp_config.json'), 'utf8'));
    const token = typeof config.auth_token === 'string' ? config.auth_token.trim() : '';
    return token !== '' && token !== 'your mcp key';
  } catch {
    return false;
  }
}

/**
 * Load the vendor's MCP client (`call-node.js`).
 * @returns `{ call, listTools }`.
 */
function client() {
  if (cachedClient !== undefined) return cachedClient;
  const skillDir = resolveSkillDir();
  if (skillDir === null) {
    throw new ProviderError(
      'ifind',
      ERROR_CODES.UNSUPPORTED,
      'ifind skill is not installed (checked IFIND_SKILL_DIR, the repository, ~/.dsh/skills and ~/.agents/skills)',
    );
  }
  const entry = path.join(skillDir, 'call-node.js');
  const require = createRequire(import.meta.url);
  cachedClient = require(entry);
  return cachedClient;
}

/**
 * Unwrap the MCP envelope down to the table the service returned.
 * The payload is `{ content: [{ text }] }` where `text` is JSON that carries
 * `data.tables = [header, ...rows]`.
 * @param response - raw `call()` result.
 * @returns parsed payload.
 */
export function unwrap(response) {
  const text = response?.data?.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new ProviderError('ifind', ERROR_CODES.BAD_SHAPE, 'ifind response has no content text');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError('ifind', ERROR_CODES.BAD_SHAPE, 'ifind content is not JSON');
  }
  if (payload?.code !== 1) {
    throw new ProviderError('ifind', ERROR_CODES.UPSTREAM_DOWN, `ifind error: ${payload?.msg ?? 'unknown'}`);
  }
  return payload;
}

/**
 * Turn the tabular payload into row objects keyed by header name.
 * @param payload - parsed iFinD payload.
 * @returns one object per data row.
 */
export function tableRows(payload) {
  const tables = payload?.data?.tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new ProviderError('ifind', ERROR_CODES.BAD_SHAPE, 'ifind payload has no tables');
  }
  const [header, ...rows] = tables;
  if (!Array.isArray(header)) {
    throw new ProviderError('ifind', ERROR_CODES.BAD_SHAPE, 'ifind table has no header');
  }
  return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? null])));
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, digits = 4) => (value === null ? null : Number(value.toFixed(digits)));

/**
 * Map one iFinD row onto the shared quote shape.
 * @param row - header-keyed row.
 * @returns normalized quote, or `null` when the row has no price.
 */
export function toQuote(row) {
  const price = num(row['最新价']);
  if (price === null) return null;
  const changePct = num(row['涨跌幅']);
  const prevClose = changePct === null ? null : round(price / (1 + changePct / 100), 2);
  const code = String(row['证券代码'] ?? '');
  const match = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(code);
  const feedCode = match === null ? null : `${match[2].toLowerCase()}${match[1]}`;
  return {
    market: 'cn',
    code: feedCode ?? code,
    instrument: feedCode === null ? null : `cn:${feedCode}`,
    name: row['证券简称'] ?? null,
    price,
    prevClose,
    open: num(row['开盘价']),
    volume: num(row['成交量']),
    quoteTime: row['time'] ?? null,
    change: prevClose === null ? null : round(price - prevClose, 2),
    changePct,
    high: num(row['最高价']),
    low: num(row['最低价']),
    amount: num(row['成交额']),
    peTtm: num(row['市盈率TTM']),
    // The service reports market value in yuan; the layer speaks 亿元.
    totalCapYi: num(row['总市值']) === null ? null : round(num(row['总市值']) / 1e8, 2),
    floatCapYi: null,
    turnoverRate: null,
    pb: num(row['市净率']),
    currency: 'CNY',
    dividendYield: null,
  };
}

/** Chunk an array into groups of at most `size`. */
function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

export const ifindProvider = {
  name: 'ifind',
  capabilities: {
    kinds: ['quote'],
    markets: ['cn'],
  },

  /**
   * Batch quotes: the service accepts ten symbols per call.
   * @param request - normalized request carrying `instruments`.
   * @returns `{ data: { byInstrument } }`.
   */
  async fetchMany(request) {
    const instruments = request.instruments ?? [];
    if (!isConfigured()) {
      throw new ProviderError('ifind', ERROR_CODES.UNSUPPORTED, 'ifind is not configured (missing API key)');
    }
    try {
      const { call } = client();
      const byInstrument = {};
      for (const group of chunk(instruments, MAX_SYMBOLS)) {
        const symbols = group.map((instrument) => instrument.code.replace(/^(sh|sz|bj)/, '')).join(',');
        const payload = unwrap(
          await call('stock', 'stock_highfreq_quotes', { symbols, indicators: INDICATORS, data_mode: 'real_time' }),
        );
        for (const row of tableRows(payload)) {
          const quote = toQuote(row);
          if (quote?.instrument !== null && quote?.instrument !== undefined) byInstrument[quote.instrument] = quote;
        }
      }
      if (Object.keys(byInstrument).length === 0) {
        throw new ProviderError('ifind', ERROR_CODES.NOT_FOUND, 'ifind returned no usable quotes');
      }
      return { data: { byInstrument } };
    } catch (error) {
      throw asProviderError('ifind', error);
    }
  },

  /**
   * Single quote.
   * @param request - normalized request.
   * @returns `{ data: quote }`.
   */
  async fetch(request) {
    const { kind, instrument } = request;
    if (kind !== 'quote') {
      throw new ProviderError('ifind', ERROR_CODES.UNSUPPORTED, `kind "${kind}" is not wired to ifind yet`);
    }
    const { data } = await this.fetchMany({ ...request, instruments: [instrument] });
    const quote = data.byInstrument[instrument.key];
    if (quote === undefined) {
      throw new ProviderError('ifind', ERROR_CODES.NOT_FOUND, `no ifind quote for ${instrument.key}`);
    }
    return { data: quote };
  },
};
