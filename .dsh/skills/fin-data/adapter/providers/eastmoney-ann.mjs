/**
 * Eastmoney announcement feed: titles first, full text second.
 *
 * Hong Kong dividends do not exist as a structured report in the F10 API, but
 * every declaration is published as an announcement whose body carries a fixed
 * label/value table (see `data/dividend-parse.mjs`). This provider turns that
 * feed into `announcements` rows and, for Hong Kong, into normalized `dividends`
 * rows with a real ex-date — the field the F10 snapshot could not provide.
 *
 * The content endpoint answers with an empty body on a repeated identical URL,
 * so every read appends a cache-busting timestamp and a retry is attempted once.
 */
import { parseHkDividend, toHkDividendRows } from '../dividend-parse.mjs';
import { ERROR_CODES, ProviderError, asProviderError } from '../errors.mjs';
import { fetchJson } from '../http.mjs';

const LIST_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const CONTENT_URL = 'https://np-cnotice-stock.eastmoney.com/api/content/ann';
const REFERER = 'https://data.eastmoney.com/';

/** Titles worth opening: everything else is noise for a dividend question. */
const DIVIDEND_TITLE = /股息|分红|派息|dividend/i;

/** Upper bound on announcement bodies fetched per request. */
const MAX_CONTENT_FETCHES = 16;

/** Announcements per list page. */
const PAGE_SIZE = 100;

/** How many list pages to walk before giving up on older declarations. */
const MAX_PAGES = 6;

/** Stop once this many distinct periods parsed cleanly (≈3 fiscal years). */
const TARGET_DECLARATIONS = 6;

/** Pause between announcement reads, so a request never looks like a crawl. */
const CONTENT_DELAY_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Six-digit A-share or five-digit Hong Kong code. */
const digitsOf = (instrument) => instrument.code.replace(/^(sh|sz|bj|hk)/, '');

/**
 * List recent announcements for one instrument.
 * @param instrument - canonical instrument.
 * @param limit - how many rows to ask for.
 * @param pageIndex - 1-based page.
 * @returns announcement rows, newest first.
 */
export async function listAnnouncements(instrument, limit, pageIndex = 1) {
  const query = new URLSearchParams({
    sr: '-1',
    page_size: String(limit),
    page_index: String(pageIndex),
    ann_type: instrument.market === 'hk' ? 'H' : 'A',
    client_source: 'web',
    stock_list: digitsOf(instrument),
  });
  const body = await fetchJson(`${LIST_URL}?${query}`, { referer: REFERER });
  const rows = body?.data?.list;
  if (!Array.isArray(rows)) {
    throw new ProviderError('eastmoney-ann', ERROR_CODES.BAD_SHAPE, `no announcement list for ${instrument.key}`);
  }
  return rows.map((row) => ({
    artCode: row.art_code,
    date: String(row.notice_date ?? '').slice(0, 10),
    title: row.title ?? '',
    url: `https://data.eastmoney.com/notices/detail/${digitsOf(instrument)}/${row.art_code}.html`,
  }));
}

/**
 * Read one announcement body.
 * @param artCode - announcement id.
 * @returns the plain-text body.
 */
export async function readAnnouncement(artCode) {
  const url = `${CONTENT_URL}?art_code=${encodeURIComponent(artCode)}&client_source=web&page_index=1&_=${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = await fetchJson(url, { referer: REFERER });
    const content = body?.data?.notice_content;
    if (typeof content === 'string' && content.trim() !== '') return content;
    await sleep(CONTENT_DELAY_MS);
  }
  throw new ProviderError('eastmoney-ann', ERROR_CODES.BAD_SHAPE, `empty announcement body for ${artCode}`);
}

/**
 * Collect parsable dividend declarations for one Hong Kong instrument.
 * @param instrument - canonical instrument.
 * @returns normalized dividend rows.
 */
/**
 * Derive a dividend period key from an announcement title.
 * Hong Kong titles carry the period and the payout kind, e.g.
 * `(更新)截至2026年6月30日止六个月中期股息` -> `2026-06-30|中期`.
 * @param title - announcement title.
 * @returns period key, or `null` when the title does not describe a payout period.
 */
export function periodKeyFromTitle(title) {
  const date = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(title);
  if (date === null) return null;
  const kind = /中期/.test(title) ? '中期' : /末期/.test(title) ? '末期' : null;
  if (kind === null) return null;
  const [, year, month, day] = date;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}|${kind}`;
}

export async function readHkDividends(instrument) {
  // Titles carry the payout period, so de-duplicate there first: one candidate
  // per (period, kind), keeping the latest announcement. This avoids fetching a
  // body for every currency-election form and unclaimed-dividend notice.
  const byPeriod = new Map();
  const distinctPeriods = () => [...byPeriod.keys()].filter((key) => !key.startsWith('code:')).length;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const announcements = await listAnnouncements(instrument, PAGE_SIZE, page);
    for (const row of announcements) {
      if (!DIVIDEND_TITLE.test(row.title)) continue;
      const key = periodKeyFromTitle(row.title) ?? `code:${row.artCode}`;
      const previous = byPeriod.get(key);
      if (previous === undefined || row.date >= previous.date) byPeriod.set(key, row);
    }
    // Only titles that name a period count toward the stop condition; notices
    // without one must not stop the walk on the first page.
    if (distinctPeriods() >= TARGET_DECLARATIONS + 1) break;
  }

  // Announcements whose title states a period are almost always real
  // declarations; the rest are election forms and notices, so they go last.
  const candidates = [...byPeriod.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      const rankA = keyA.startsWith('code:') ? 1 : 0;
      const rankB = keyB.startsWith('code:') ? 1 : 0;
      if (rankA !== rankB) return rankA - rankB;
      return b.date.localeCompare(a.date);
    })
    .map(([, row]) => row)
    .slice(0, MAX_CONTENT_FETCHES);

  const parsed = [];
  const periods = new Set();
  for (const announcement of candidates) {
    if (periods.size >= TARGET_DECLARATIONS) break;
    try {
      const content = await readAnnouncement(announcement.artCode);
      const fields = parseHkDividend(content);
      if (fields.perShare !== null && fields.exDate !== null) {
        parsed.push({ announcement, parsed: fields });
        periods.add(`${fields.periodEnd ?? 'unknown'}|${fields.type ?? 'unknown'}`);
      }
    } catch {
      // One unreadable announcement must not sink the whole dividend history.
    }
    await sleep(CONTENT_DELAY_MS);
  }

  // 特别股息没有「财年 / 报告期」，上面的排序会把它们排到最后、被 6 个周期的
  // 停止条件截掉。单独补最近两份特别股息——李宁 2026-11-05 的 60 亿就是这种。
  const specials = [...byPeriod.values()]
    .filter((row) => periodKeyFromTitle(row.title) === null && /特别股息|特別股息/.test(row.title))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 2);
  for (const announcement of specials) {
    try {
      const content = await readAnnouncement(announcement.artCode);
      const fields = parseHkDividend(content);
      if (fields.perShare !== null && fields.exDate !== null) {
        parsed.push({ announcement, parsed: fields });
      }
    } catch {
      // 同上：读不到就跳过。
    }
    await sleep(CONTENT_DELAY_MS);
  }

  const rows = toHkDividendRows(parsed);
  if (rows.length === 0) {
    throw new ProviderError('eastmoney-ann', ERROR_CODES.NOT_FOUND, `no parsable dividend announcement for ${instrument.key}`);
  }
  return rows;
}

export const eastmoneyAnnProvider = {
  name: 'eastmoney-ann',
  capabilities: {
    kinds: ['announcements', 'dividends'],
    markets: ['cn', 'hk'],
  },

  async fetch(request) {
    const { kind, instrument } = request;
    try {
      if (kind === 'announcements') {
        const rows = await listAnnouncements(instrument, request.options?.limit ?? 40);
        return { data: { instrument: instrument.key, rows } };
      }
      if (kind === 'dividends') {
        if (instrument.market !== 'hk') {
          // A-share dividends come from the structured F10 report, not from prose.
          throw new ProviderError(
            'eastmoney-ann',
            ERROR_CODES.UNSUPPORTED,
            'A-share dividends are served by the structured eastmoney report',
          );
        }
        const rows = await readHkDividends(instrument);
        return { data: { instrument: instrument.key, rows } };
      }
      throw new ProviderError('eastmoney-ann', ERROR_CODES.UNSUPPORTED, `kind "${kind}" is not served by eastmoney-ann`);
    } catch (error) {
      throw asProviderError('eastmoney-ann', error);
    }
  },
};
