/**
 * Hong Kong cash-dividend announcements are a fixed label/value table, not
 * prose, so they can be parsed deterministically:
 *
 *   股息類型          中期（半年期）
 *   宣派股息的報告期末  2026年6月30日
 *   宣派股息          每 股 0.98RMB
 *   除淨日            2026年9月2日
 *   股息派發日         2026年10月16日
 *
 * The parser normalizes traditional label characters once, then reads labels by
 * regex; anything without a declared per-share amount is treated as noise
 * ("沒收未領取的股息", "股息貨幣選擇表格" and similar).
 */

/** Traditional characters that appear inside the labels we match. */
const TRADITIONAL = { 淨: '净', 類: '类', 報: '报', 幣: '币', 發: '发', 額: '额' };

/**
 * Fold the label characters so one set of simplified patterns matches both
 * simplified and traditional filings.
 * @param text - raw announcement body.
 * @returns normalized text.
 */
export function normalizeAnnouncementText(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[淨類報幣發額]/g, (char) => TRADITIONAL[char] ?? char);
}

/**
 * Read the value after the first label on its line.
 * @param lines - normalized lines.
 * @param label - label text.
 * @returns trimmed value, or `null`.
 */
function valueAfter(lines, label) {
  for (const line of lines) {
    const at = line.indexOf(label);
    if (at === -1) continue;
    const value = line.slice(at + label.length).trim();
    if (value !== '') return value;
  }
  return null;
}

/**
 * Parse a Chinese date or return `null` when it is absent or still pending.
 * @param value - text such as `2026年9月2日` or `待公布`.
 * @returns ISO date (`YYYY-MM-DD`) or `null`.
 */
export function parseChineseDate(value) {
  if (typeof value !== 'string') return null;
  const match = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse one Hong Kong cash-dividend announcement.
 * @param content - `notice_content` text from the announcement API.
 * @returns parsed fields; `perShare` is `null` when the announcement carries no
 *   declared amount (i.e. it is not a dividend declaration).
 */
export function parseHkDividend(content) {
  const text = normalizeAnnouncementText(content);
  const lines = text.split('\n');

  const declared = /宣派股息\s*每\s*股\s*([\d.,]+)\s*([A-Za-z]{3,4})/.exec(text);
  const perShare = declared === null ? null : Number(declared[1].replace(/,/g, ''));
  const currency = declared === null ? null : declared[2].toUpperCase();

  return {
    type: valueAfter(lines, '股息类型'),
    nature: valueAfter(lines, '股息性质'),
    periodEnd: parseChineseDate(valueAfter(lines, '宣派股息的报告期末')),
    perShare: Number.isFinite(perShare) ? perShare : null,
    currency,
    payoutCurrency: /([A-Z]{3})/.exec(valueAfter(lines, '派息金额及公司预设派发货币') ?? '')?.[1] ?? null,
    exDate: parseChineseDate(valueAfter(lines, '除净日')),
    payDate: parseChineseDate(valueAfter(lines, '股息派发日')),
    pending: /待公布|待公佈/.test(text),
  };
}

/**
 * Turn parsed announcements into normalized dividend rows.
 *
 * Rows keep the declared currency: Hong Kong companies often declare in RMB and
 * pay in HKD, so converting here would bake in an assumption. Consumers convert
 * with an explicit FX rate.
 *
 * @param items - `{ announcement, parsed }` pairs.
 * @returns de-duplicated dividend rows, newest report period first.
 */
export function toHkDividendRows(items) {
  const kept = new Map();
  for (const { announcement, parsed } of items) {
    if (parsed.perShare === null || parsed.exDate === null) continue;
    const key = `${parsed.periodEnd ?? 'unknown'}|${parsed.type ?? 'unknown'}`;
    const row = {
      reportDate: parsed.periodEnd,
      fiscalYear: parsed.periodEnd === null ? null : Number(parsed.periodEnd.slice(0, 4)),
      plan: `${parsed.type ?? '股息'} 每股 ${parsed.perShare} ${parsed.currency ?? ''}`.trim(),
      cashPer10: Number((parsed.perShare * 10).toFixed(4)),
      exDate: parsed.exDate,
      recordDate: null,
      status: 'announced',
      currency: parsed.currency,
      payDate: parsed.payDate,
      artCode: announcement.artCode,
      url: announcement.url,
    };
    const previous = kept.get(key);
    // Later announcements supersede earlier ones ("(更新)" versions, corrections).
    if (previous === undefined || announcement.date >= previous.noticeDate) {
      kept.set(key, { ...row, noticeDate: announcement.date });
    }
  }
  return [...kept.values()]
    .sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)))
    .map(({ noticeDate, ...row }) => row);
}
