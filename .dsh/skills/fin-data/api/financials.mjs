/**
 * `financials`：财报查询入口（利润表 / 资产负债表 / 现金流量表 + 指标）。
 *
 * 两个实现：
 * 1. **真实适配器**：复用 fin-data 内部已有的东财 F10 指标（A 股 / 港股），
 *    把「指标行」摊平成三大表的关键项；港股再补一张资产负债表的净现金明细。
 * 2. **模拟实现**：`mock-financials.mjs`，真实源不可用（或显式 `source: 'mock'`）时兜底。
 *    真实财报源的接入属于后续工作，接口形状先固定下来。
 *
 * `source` 语义：
 *   - `auto`（默认）先真实、失败回落模拟，并在 `warnings` 里说明原因；
 *   - `real` 只认真实数据，拿不到就 `ok: false`（宁可缺，不给假数）；
 *   - `mock` 只给模拟数据，便于联调与演示。
 *
 * 金额单位统一为**元**；比率字段保留百分数或 0~1 小数（见字段名）。
 */

import { get } from '../adapter/index.mjs';
import {
  ERROR_CODES,
  FINANCIALS_SOURCES,
  MOCK_DISCLAIMER,
  QueryError,
  failEnvelope,
  fromYi,
  okEnvelope,
  round,
  toYi,
} from './contract.mjs';
import { fetchHkBalance } from './hk-balance.mjs';
import { buildMockFinancials } from './mock-financials.mjs';

/** fin-data 的规范写法：`600519.SH` / `00700.HK`。 */
function finDataSymbol(instrument) {
  if (instrument.market === 'hk') return `${instrument.code}.HK`;
  return `${instrument.code.replace(/^(sh|sz|bj)/, '')}.${instrument.code.slice(0, 2).toUpperCase()}`;
}

/** 报告期类型。 */
function periodTypeOf(reportDate) {
  const month = Number(String(reportDate ?? '').slice(5, 7));
  if (month === 3) return 'Q1';
  if (month === 6) return 'H1';
  if (month === 9) return 'Q3';
  if (month === 12) return 'FY';
  return null;
}

/** 港股 F10 用 `reportName` 当报表类型（三季报 / 年报…）；A 股是完整名称。 */
function fiscalYearOf(reportDate) {
  const year = Number(String(reportDate ?? '').slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/**
 * 把一条「财务指标行」摊平成财报结构。
 * @param {object} row - normalized fundamentals row from the data layer.
 * @param {object} [balance] - 港股资产负债表摘要（元）。
 * @returns {object} one financial period.
 */
export function periodFromMetricRow(row, balance = null) {
  const money = (value) => (value === null ? null : round(value, 0));
  const perShare = (value) => (value === null ? null : round(value, 4));
  const assets = fromYi(row.totalAssetsYi);
  const equity = fromYi(row.totalEquityYi);
  const liabilities = assets !== null && equity !== null ? assets - equity : null;
  const ocf = fromYi(row.ocfYi);
  const icf = fromYi(row.icfYi);
  return {
    reportDate: row.reportDate ?? null,
    reportName: row.reportName ?? null,
    fiscalYear: fiscalYearOf(row.reportDate),
    periodType: periodTypeOf(row.reportDate),
    noticeDate: row.noticeDate ?? null,
    currency: row.currency ?? null,
    income: {
      revenue: money(fromYi(row.revenueYi)),
      // 东财指标表没有营业利润列；缺就是缺，不用净利润倒推。
      operatingProfit: null,
      netProfit: money(fromYi(row.netProfitYi)),
      deductNetProfit: money(fromYi(row.deductNetProfitYi)),
      eps: perShare(row.eps),
      netMargin: row.netMargin ?? null,
      revenueYoY: row.revenueYoY ?? null,
      netProfitYoY: row.netProfitYoY ?? null,
      deductNetProfitYoY: row.deductedYoY ?? null,
    },
    balance: {
      totalAssets: money(assets),
      totalLiabilities: money(liabilities),
      equity: money(equity),
      bps: perShare(row.bps),
      debtRatio: row.debtRatio ?? null,
      cash: balance?.cash ?? null,
      interestDebt: balance?.interestDebt ?? null,
      netCash: balance?.netCash ?? null,
    },
    cashflow: {
      ocf: money(ocf),
      icf: money(icf),
      fcf: ocf !== null && icf !== null ? money(ocf + icf) : null,
      investCash: money(fromYi(row.investCashYi)),
      finCash: money(fromYi(row.finCashYi)),
      ocfPerShare: perShare(row.ocfPerShare),
    },
    ratios: {
      roe: row.roe ?? null,
      netMargin: row.netMargin ?? null,
      debtRatio: row.debtRatio ?? null,
      interestDebtRatio: row.interestDebtRatio ?? null,
      dividendYieldPct: row.dividendYieldPct ?? null,
      payoutRatio: row.payoutRatioSnapshot ?? null,
      dividendPerShare: row.dps ?? null,
    },
    shares: { totalShares: row.totalShares ?? null },
    source: 'eastmoney',
    mock: false,
  };
}

/**
 * 财报结构 -> 旧的「指标行」形状。
 *
 * 9c 的因子计算与看板的选股阈值都建立在这组字段上；让它们继续读 `*Yi`，
 * 比在每个消费方写一遍「元 / 亿元」换算更不容易出错。
 * @param {object} period - one financial period.
 */
export function toMetricRow(period) {
  if (period === null || period === undefined) return null;
  return {
    reportDate: period.reportDate ?? null,
    reportName: period.reportName ?? null,
    noticeDate: period.noticeDate ?? null,
    currency: period.currency ?? null,
    listingCurrency: period.listingCurrency ?? null,
    eps: period.income?.eps ?? null,
    bps: period.balance?.bps ?? null,
    revenueYi: toYi(period.income?.revenue),
    revenueYoY: period.income?.revenueYoY ?? null,
    netProfitYi: toYi(period.income?.netProfit),
    netProfitYoY: period.income?.netProfitYoY ?? null,
    deductNetProfitYi: toYi(period.income?.deductNetProfit),
    deductedYoY: period.income?.deductNetProfitYoY ?? null,
    roe: period.ratios?.roe ?? null,
    netMargin: period.ratios?.netMargin ?? null,
    debtRatio: period.ratios?.debtRatio ?? null,
    interestDebtRatio: period.ratios?.interestDebtRatio ?? null,
    ocfYi: toYi(period.cashflow?.ocf),
    icfYi: toYi(period.cashflow?.icf),
    ocfPerShare: period.cashflow?.ocfPerShare ?? null,
    totalAssetsYi: toYi(period.balance?.totalAssets),
    totalEquityYi: toYi(period.balance?.equity),
    totalShares: period.shares?.totalShares ?? null,
    investCashYi: toYi(period.cashflow?.investCash),
    finCashYi: toYi(period.cashflow?.finCash),
    dps: period.ratios?.dividendPerShare ?? null,
    dividendYieldPct: period.ratios?.dividendYieldPct ?? null,
    payoutRatioSnapshot: period.ratios?.payoutRatio ?? null,
    netCashYi: toYi(period.balance?.netCash),
    mock: period.mock === true,
  };
}

/** 把 `options` 收敛成这一层认识的参数。 */
function normalizeOptions(options = {}) {
  const source = String(options.source ?? 'auto').toLowerCase();
  if (!FINANCIALS_SOURCES.includes(source)) {
    throw new QueryError(
      ERROR_CODES.INVALID_REQUEST,
      `financials.source 必须是 ${FINANCIALS_SOURCES.join(' | ')}，收到 "${options.source}"`,
      { kind: 'financials' },
    );
  }
  const periods = Math.min(8, Math.max(1, Number(options.periods) || 4));
  return { source, periods, balance: options.balance !== false };
}

/** 真实源的失败原因（用于 auto 回落时写进 warnings）。 */
function reasonOf(result) {
  return result?.error?.message ?? 'unknown upstream failure';
}

/**
 * 查询一只标的的财报。
 * @param {object} request - `{ instrument, options }`，instrument 已解析。
 * @returns {Promise<object>} fin-data 查询信封。
 */
export async function queryFinancials(request) {
  const instrument = request.instrument;
  const { source, periods, balance } = normalizeOptions(request.options);

  if (source === 'mock') {
    const data = buildMockFinancials(instrument, { periods });
    return okEnvelope('financials', instrument.key, data, {
      source: 'mock',
      asOf: data.periods[0]?.reportDate ?? null,
      mock: true,
      ttlMs: null,
    }, ['财报为模拟数据（金额单位：元），仅用于打通接口。']);
  }

  // 港股净现金明细与指标行并行拉取，避免多打一轮往返。
  const balancePromise =
    balance && instrument.market === 'hk' ? fetchHkBalance(instrument).catch(() => null) : Promise.resolve(null);

  const result = await get({ kind: 'fundamentals', instrument: instrument.key, options: { periods } });
  const balanceDetail = await balancePromise;

  if (result.ok !== true) {
    if (source === 'real') {
      return failEnvelope('financials', instrument.key, ERROR_CODES.UPSTREAM_DOWN, reasonOf(result), {}, [
        '真实财报源不可用；需要模拟数据请显式传 options.source="mock"。',
      ]);
    }
    const data = buildMockFinancials(instrument, { periods });
    return okEnvelope('financials', instrument.key, data, {
      source: 'mock',
      asOf: data.periods[0]?.reportDate ?? null,
      mock: true,
      degraded: result.meta?.degraded ?? [],
    }, [
      `真实财报源不可用（${reasonOf(result)}），已回落为模拟财报。`,
      '模拟财报以元为单位，不代表真实经营情况。',
    ]);
  }

  const periodsOut = (result.data?.rows ?? []).map((row) => {
    const period = periodFromMetricRow(row, instrument.market === 'hk' ? balanceDetail : null);
    period.listingCurrency = row.listingCurrency ?? null;
    return period;
  });

  if (periodsOut.length === 0) {
    if (source === 'real') {
      return failEnvelope('financials', instrument.key, ERROR_CODES.NOT_FOUND, '上游返回了空的财报列表', {}, []);
    }
    const data = buildMockFinancials(instrument, { periods });
    return okEnvelope('financials', instrument.key, data, {
      source: 'mock',
      asOf: data.periods[0]?.reportDate ?? null,
      mock: true,
      degraded: result.meta?.degraded ?? [],
    }, ['上游财报为空，已回落为模拟财报。']);
  }

  const mock = periodsOut.some((period) => period.mock === true);
  return okEnvelope(
    'financials',
    instrument.key,
    {
      symbol: finDataSymbol(instrument),
      market: instrument.market,
      currency: periodsOut[0]?.currency ?? (instrument.market === 'hk' ? null : 'CNY'),
      unit: '元',
      periods: periodsOut,
      mock,
      disclaimer: mock ? MOCK_DISCLAIMER : null,
    },
    {
      source: 'eastmoney',
      asOf: periodsOut[0]?.reportDate ?? null,
      cached: result.meta?.cached === true,
      stale: result.meta?.stale === true,
      mock,
      ttlMs: result.meta?.ttlMs ?? null,
      degraded: result.meta?.degraded ?? [],
    },
    result.meta?.stale === true ? [`财报为过期缓存（抓取于 ${result.meta.fetchedAt}）。`] : [],
  );
}

/** 财报口径的常量，供文档/CLI/调用方引用。 */
export const FINANCIALS = {
  unit: '元',
  ratioUnit: '百分数（%），payoutRatio 为 0~1 小数',
  periods: '按 reportDate 倒序，最多 8 期',
  sources: FINANCIALS_SOURCES,
  netCash: '港股本项来自资产负债表明细；A 股指标表没有该列，返回 null',
};

/** 供 9c 的「派生指标」复算时引用，单位与小数位保持一致。 */
export const money = { toYi, fromYi, round };
