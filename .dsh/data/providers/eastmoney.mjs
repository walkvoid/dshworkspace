/**
 * Eastmoney F10 fundamentals, dividends, and annual reports (A shares).
 *
 * Hong Kong statements use a different report (`RPT_HKF10_FN_MAININDICATOR`)
 * with its own field names; that mapping is deliberately not guessed here — the
 * provider reports UNSUPPORTED for Hong Kong until the mapping is verified.
 */
import { fetchJson } from '../http.mjs';
import { ERROR_CODES, ProviderError, asProviderError } from '../errors.mjs';
import { toSecuCode } from '../instruments.mjs';

const F10_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';

const REFERER = 'https://data.eastmoney.com/';

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

/** 元 -> 亿元. */
const toYi = (value) => (value === null ? null : round(value / 1e8, 2));

/**
 * Build one F10 request URL.
 * @param params - report name, filter, page size, sort.
 * @returns the request URL.
 */
function f10Url({ reportName, filter, pageSize, sortColumns, sortTypes, columns = 'ALL' }) {
  const query = new URLSearchParams({
    reportName,
    columns,
    filter,
    pageSize: String(pageSize),
    sortColumns,
    sortTypes,
  });
  return `${F10_URL}?${query}`;
}

/**
 * Read `result.data` from an F10 response.
 * @param body - parsed JSON.
 * @param context - used in the error message.
 * @returns row array.
 */
function rowsOf(body, context) {
  const rows = body?.result?.data;
  if (!Array.isArray(rows)) {
    throw new ProviderError('eastmoney', ERROR_CODES.BAD_SHAPE, `no rows for ${context}`);
  }
  return rows;
}

/**
 * Normalize one periodic financial row (A shares).
 * @param row - eastmoney row.
 * @returns normalized row; identifiers and periods are kept as-is.
 */
export function normalizeFundamentalRow(row) {
  return {
    reportDate: row.REPORT_DATE?.slice(0, 10) ?? null,
    reportName: row.REPORT_DATE_NAME ?? null,
    noticeDate: row.NOTICE_DATE?.slice(0, 10) ?? null,
    currency: row.CURRENCY ?? null,
    // Hong Kong rows report the listing currency; kept null here for key parity.
    listingCurrency: null,
    eps: num(row.EPSJB),
    bps: num(row.BPS),
    revenueYi: toYi(num(row.TOTALOPERATEREVE)),
    revenueYoY: round(num(row.TOTALOPERATEREVETZ), 2),
    netProfitYi: toYi(num(row.PARENTNETPROFIT)),
    netProfitYoY: round(num(row.PARENTNETPROFITTZ), 2),
    deductNetProfitYi: toYi(num(row.KCFJCXSYJLR)),
    deductedYoY: round(num(row.KCFJCXSYJLRTZ), 2),
    roe: round(num(row.ROEJQ), 2),
    netMargin: round(num(row.XSJLL), 2),
    debtRatio: round(num(row.ZCFZL), 2),
    interestDebtRatio: round(num(row.INTEREST_DEBT_RATIO), 2),
    ocfYi: toYi(num(row.NETCASH_OPERATE_PK)),
    icfYi: toYi(num(row.NETCASH_INVEST_PK)),
    ocfPerShare: num(row.MGJYXJJE),
    totalAssetsYi: toYi(num(row.TOTAL_ASSETS_PK)),
    totalEquityYi: toYi(num(row.TOTAL_EQUITY_PK)),
    totalShares: num(row.TOTAL_SHARE),
    investCashYi: toYi(num(row.NETCASH_INVEST_PK)),
    finCashYi: toYi(num(row.NETCASH_FINANCE_PK)),
    // 港股报表才直接给每股派息与股息率；A 股由分红明细另行推算。
    dps: null,
    dividendYieldPct: null,
    payoutRatioSnapshot: null,
  };
}

/**
 * Normalize one periodic financial row (Hong Kong shares).
 *
 * Two deliberate differences from the A-share shape:
 * - the report has no deducted-profit or interest-debt columns, so those are null;
 * - `currency` is the listing currency reported by the source. Hong Kong
 *   statements are often presented in RMB, so cross-currency math (penetration
 *   return against a HKD market cap) is NOT done here — see `stock-data.mjs`.
 *
 * @param row - eastmoney HK row.
 * @returns normalized row with the same keys as the A-share row.
 */
export function normalizeHkFundamentalRow(row) {
  const totalAssets = num(row.TOTAL_ASSETS);
  const totalLiabilities = num(row.TOTAL_LIABILITIES);
  // A-share rows report total equity (including minorities); the HK report gives
  // parent equity. Derive assets - liabilities so the field means the same thing
  // in both markets, and fall back only when the pieces are missing.
  const totalEquity = totalAssets !== null && totalLiabilities !== null ? totalAssets - totalLiabilities : null;
  return {
    reportDate: row.STD_REPORT_DATE?.slice(0, 10) ?? null,
    reportName: row.REPORT_TYPE ?? null,
    noticeDate: null,
    // The HK field is the listing currency, not the statement currency, so it is
    // not reported as `currency` (which means statement currency everywhere else).
    currency: null,
    listingCurrency: row.CURRENCY ?? null,
    eps: num(row.BASIC_EPS),
    bps: num(row.BPS),
    revenueYi: toYi(num(row.OPERATE_INCOME)),
    revenueYoY: round(num(row.OPERATE_INCOME_YOY), 2),
    netProfitYi: toYi(num(row.HOLDER_PROFIT)),
    netProfitYoY: round(num(row.HOLDER_PROFIT_YOY), 2),
    deductNetProfitYi: null,
    deductedYoY: null,
    roe: round(num(row.ROE_AVG), 2),
    netMargin: round(num(row.NET_PROFIT_RATIO), 2),
    debtRatio: round(num(row.DEBT_ASSET_RATIO), 2),
    interestDebtRatio: null,
    ocfYi: toYi(num(row.NETCASH_OPERATE)),
    icfYi: toYi(num(row.NETCASH_INVEST)),
    ocfPerShare: num(row.PER_NETCASH_OPERATE),
    totalAssetsYi: toYi(totalAssets),
    totalEquityYi: toYi(totalEquity ?? num(row.TOTAL_PARENT_EQUITY)),
    totalShares: num(row.ISSUED_COMMON_SHARES),
    investCashYi: toYi(num(row.NETCASH_INVEST)),
    finCashYi: toYi(num(row.NETCASH_FINANCE)),
    dps: num(row.DPS_HKD),
    dividendYieldPct: round(num(row.DIVIDEND_RATE), 2),
    payoutRatioSnapshot: round(num(row.DIVI_RATIO), 4),
  };
}

/**
 * Normalize one dividend record.
 * @param row - eastmoney row.
 * @returns normalized row.
 */
export function normalizeDividendRow(row) {
  return {
    reportDate: row.REPORT_DATE?.slice(0, 10) ?? null,
    fiscalYear: Number(row.REPORT_DATE?.slice(0, 4)) || null,
    plan: row.IMPL_PLAN_PROFILE ?? null,
    cashPer10: num(row.PRETAX_BONUS_RMB),
    exDate: row.EX_DIVIDEND_DATE?.slice(0, 10) ?? null,
    recordDate: row.EQUITY_RECORD_DATE?.slice(0, 10) ?? null,
    status: row.ASSIGN_PROGRESS ?? null,
  };
}

/**
 * Normalize one annual-report row.
 * @param row - eastmoney row.
 * @returns normalized row.
 */
export function normalizeAnnualRow(row) {
  return {
    fiscalYear: Number(row.REPORT_DATE?.slice(0, 4)) || null,
    reportDate: row.REPORT_DATE?.slice(0, 10) ?? null,
    netProfitYi: toYi(num(row.PARENTNETPROFIT)),
    totalShares: num(row.TOTAL_SHARE),
  };
}

/**
 * Normalize one annual-report row (Hong Kong shares).
 * @param row - eastmoney HK row.
 * @returns normalized row.
 */
export function normalizeHkAnnualRow(row) {
  return {
    fiscalYear: Number(row.STD_REPORT_DATE?.slice(0, 4)) || null,
    reportDate: row.STD_REPORT_DATE?.slice(0, 10) ?? null,
    netProfitYi: toYi(num(row.HOLDER_PROFIT)),
    totalShares: num(row.ISSUED_COMMON_SHARES),
  };
}

/**
 * Accept either a parsed body or a raw row array.
 * @param body - parsed body.
 * @returns rows.
 */
const asRows = (body) => (Array.isArray(body) ? body : body?.result?.data);

/** Parse an A-share fundamentals response body. */
export const parseFundamentals = (body) => asRows(body).map(normalizeFundamentalRow);

/** Parse a Hong Kong fundamentals response body. */
export const parseHkFundamentals = (body) => asRows(body).map(normalizeHkFundamentalRow);

/** Parse a dividends response body. */
export const parseDividends = (body) => asRows(body).map(normalizeDividendRow);

/** Parse an A-share annual-report response body. */
export const parseAnnual = (body) => asRows(body).map(normalizeAnnualRow);

/**
 * Parse a Hong Kong annual report.
 * The HK report mixes quarterly rows, so only the fiscal-year rows are kept;
 * `DATE_TYPE_CODE === '001'` marks a full-year report.
 */
export const parseHkAnnual = (body) => asRows(body).filter((row) => row.DATE_TYPE_CODE === '001').map(normalizeHkAnnualRow);

export const eastmoneyProvider = {
  name: 'eastmoney',
  capabilities: {
    kinds: ['fundamentals', 'dividends', 'annual'],
    markets: ['cn', 'hk'],
  },

  async fetch(request) {
    const { kind, instrument } = request;
    const isHk = instrument.market === 'hk';
    try {
      const secuCode = toSecuCode(instrument);

      if (kind === 'fundamentals' && isHk) {
        const url = f10Url({
          reportName: 'RPT_HKF10_FN_MAININDICATOR',
          filter: `(SECUCODE="${secuCode}")`,
          pageSize: request.options?.periods ?? 4,
          sortColumns: 'STD_REPORT_DATE',
          sortTypes: '-1',
        });
        const body = await fetchJson(url, { referer: REFERER });
        const rows = parseHkFundamentals(rowsOf(body, secuCode));
        return { data: { instrument: instrument.key, rows } };
      }

      if (kind === 'annual' && isHk) {
        // One page holds several quarters; ask for more rows than years wanted.
        const url = f10Url({
          reportName: 'RPT_HKF10_FN_MAININDICATOR',
          filter: `(SECUCODE="${secuCode}")`,
          pageSize: (request.options?.years ?? 3) * 4,
          sortColumns: 'STD_REPORT_DATE',
          sortTypes: '-1',
        });
        const body = await fetchJson(url, { referer: REFERER });
        const rows = parseHkAnnual(rowsOf(body, secuCode)).slice(0, request.options?.years ?? 3);
        return { data: { instrument: instrument.key, rows } };
      }

      if (kind === 'dividends' && isHk) {
        // No dividend-detail report is mapped for Hong Kong yet; the main
        // indicator carries DPS_HKD / DIVIDEND_RATE instead (see fundamentals).
        throw new ProviderError('eastmoney', ERROR_CODES.UNSUPPORTED, 'Hong Kong dividend history is not mapped yet');
      }

      if (kind === 'fundamentals') {
        const url = f10Url({
          reportName: 'RPT_F10_FINANCE_MAINFINADATA',
          filter: `(SECUCODE="${secuCode}")`,
          pageSize: request.options?.periods ?? 4,
          sortColumns: 'REPORT_DATE',
          sortTypes: '-1',
        });
        const body = await fetchJson(url, { referer: REFERER });
        const rows = parseFundamentals(rowsOf(body, secuCode));
        return { data: { instrument: instrument.key, rows } };
      }

      if (kind === 'dividends') {
        const url = f10Url({
          reportName: 'RPT_SHAREBONUS_DET',
          filter: `(SECURITY_CODE="${instrument.code.replace(/^(sh|sz|bj)/, '')}")`,
          pageSize: request.options?.limit ?? 12,
          sortColumns: 'REPORT_DATE',
          sortTypes: '-1',
        });
        const body = await fetchJson(url, { referer: REFERER });
        const rows = parseDividends(rowsOf(body, secuCode));
        return { data: { instrument: instrument.key, rows } };
      }

      if (kind === 'annual') {
        const url = f10Url({
          reportName: 'RPT_F10_FINANCE_MAINFINADATA',
          columns: 'SECUCODE,REPORT_DATE,REPORT_TYPE,PARENTNETPROFIT,TOTAL_SHARE',
          filter: `(SECUCODE="${secuCode}")(REPORT_TYPE="年报")`,
          pageSize: request.options?.years ?? 3,
          sortColumns: 'REPORT_DATE',
          sortTypes: '-1',
        });
        const body = await fetchJson(url, { referer: REFERER });
        const rows = parseAnnual(rowsOf(body, secuCode));
        return { data: { instrument: instrument.key, rows } };
      }

      throw new ProviderError('eastmoney', ERROR_CODES.UNSUPPORTED, `kind "${kind}" is not served by eastmoney`);
    } catch (error) {
      throw asProviderError('eastmoney', error);
    }
  },
};
