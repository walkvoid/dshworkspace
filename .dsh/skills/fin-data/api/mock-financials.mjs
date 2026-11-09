/**
 * 模拟财报（`financials` 的 mock 实现）。
 *
 * 目的只有一个：把「财报查询接口」先钉死，让 9c 与看板可以按最终形状取数；
 * 真实财报源的接入（东财完整三表 / iFinD / 公告解析）以后只替换 provider，
 * 不动任何消费方。
 *
 * 约定：
 * - **确定性**：同一 `symbol + 报告期` 永远得到同一组数字（seed 由标的与年份决定），
 *   方便测试、方便复现；
 * - **可识别**：每个报告期带 `mock: true`、`source: 'mock'`，响应带免责声明；
 * - **形状与真实一致**：字段、单位（元）、报告期命名规则都和真实适配器完全一样，
 *   所以消费方不需要写两套代码。
 */

import { MOCK_DISCLAIMER, round } from './contract.mjs';

/** FNV-1a 32 位哈希，用作 PRNG 种子。 */
function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** mulberry32：小而稳的可复现 PRNG，返回 [0,1)。 */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 区间取值。 */
const between = (random, min, max) => min + random() * (max - min);

/** 沪/深/北交易所后缀；港股用 `.HK`。 */
function finDataSymbol(instrument) {
  if (instrument.market === 'hk') return `${instrument.code}.HK`;
  return `${instrument.code.replace(/^(sh|sz|bj)/, '')}.${instrument.code.slice(0, 2).toUpperCase()}`;
}

/** 报告期类型：一季报 / 半年报 / 三季报 / 年报。 */
function periodOf(reportDate) {
  const month = Number(reportDate.slice(5, 7));
  if (month === 3) return { type: 'Q1', name: '一季报', cumulative: 0.22 };
  if (month === 6) return { type: 'H1', name: '半年报', cumulative: 0.48 };
  if (month === 9) return { type: 'Q3', name: '三季报', cumulative: 0.73 };
  return { type: 'FY', name: '年报', cumulative: 1 };
}

/**
 * 最近 N 个「已过披露窗口」的报告期（按时间倒序）。
 * 用 20 天披露滞后近似：报告期结束后 20 天内不生成，避免出现未来的财报。
 * @param {number} count - how many periods.
 * @param {Date} now - current time.
 */
function recentReportDates(count, now) {
  const cutoff = new Date(now.getTime() - 20 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const year = Number(cutoff.slice(0, 4));
  const ends = [];
  for (let y = year; y >= year - 3 && ends.length < count; y -= 1) {
    for (const month of ['12', '09', '06', '03']) {
      const day = month === '03' || month === '12' ? '31' : '30';
      const date = `${y}-${month}-${day}`;
      if (date <= cutoff) ends.push(date);
      if (ends.length >= count) break;
    }
  }
  return ends.slice(0, count);
}

/** 一家「模拟公司」的年度量级；只由 symbol 决定，跨报告期保持一致。 */
function companyProfile(instrument) {
  const random = prng(hash(`fin-data|company|${finDataSymbol(instrument)}`));
  return {
    // 8 亿 ~ 80 亿股：A 股/港股主板常见量级，避免算出 0.1 元的每股指标。
    shares: Math.round(between(random, 8e8, 8e9)),
    // 收入取对数均匀：中小市值居多，也有千亿级的大公司。
    revenueYi: Math.exp(between(random, Math.log(80), Math.log(2500))),
    marginPct: between(random, 4, 42),
    roePct: between(random, 3, 32),
    debtPct: between(random, 15, 72),
    cashConversion: between(random, 0.55, 1.85),
    capexRate: between(random, 0.02, 0.28),
    payoutRatio: between(random, 0.2, 0.9),
    yieldPct: between(random, 0.6, 6.5),
    currency: instrument.market === 'hk' ? 'HKD' : 'CNY',
  };
}

/** 某个财年的年度收入（元），带一点年际波动。 */
function annualRevenue(profile, instrument, year) {
  const random = prng(hash(`fin-data|year|${finDataSymbol(instrument)}|${year}`));
  const drift = between(random, -0.12, 0.22);
  return profile.revenueYi * (1 + drift * 0.05 * (year - 2026)) * 1e8;
}

/**
 * 生成一个报告期。所有金额单位：元；比率为百分数或 0~1 的小数（见字段名）。
 * 利润表/现金流量表按报告期**累计**；资产负债表是期末时点值。
 * @param {object} instrument - canonical instrument.
 * @param {string} reportDate - `YYYY-MM-DD`.
 */
function mockPeriod(instrument, reportDate) {
  const profile = companyProfile(instrument);
  const year = Number(reportDate.slice(0, 4));
  const period = periodOf(reportDate);
  const random = prng(hash(`fin-data|period|${finDataSymbol(instrument)}|${reportDate}`));

  const annual = annualRevenue(profile, instrument, year);
  const previous = annualRevenue(profile, instrument, year - 1);
  // 小幅扰动：同一报告期不同季度看着像真的，但幅度受控。
  const jitter = between(random, 0.97, 1.03);
  const revenue = annual * period.cumulative * jitter;
  const margin = (profile.marginPct + between(random, -1.5, 1.5)) / 100;
  const netProfit = revenue * margin;

  const annualNetProfit = annual * margin;
  const equity = annualNetProfit / (profile.roePct / 100);
  const assets = equity / (1 - profile.debtPct / 100);
  const liabilities = assets - equity;
  const ocf = netProfit * profile.cashConversion;
  const invest = -revenue * profile.capexRate;
  const finCash = -(ocf + invest) * between(random, 0.35, 0.75);
  const annualEps = annualNetProfit / profile.shares;
  const dps = annualEps * profile.payoutRatio;

  const revenueYoY = previous > 0 ? ((annual - previous) / previous) * 100 : null;

  return {
    reportDate,
    reportName: `${year}${period.name}`,
    fiscalYear: year,
    periodType: period.type,
    noticeDate: null,
    currency: profile.currency,
    income: {
      revenue: round(revenue, 0),
      operatingProfit: round(netProfit / between(random, 1.05, 1.45), 0),
      netProfit: round(netProfit, 0),
      deductNetProfit: round(netProfit * between(random, 0.82, 0.98), 0),
      eps: round(netProfit / profile.shares, 4),
      netMargin: round(margin * 100, 2),
      revenueYoY: round(revenueYoY, 2),
      netProfitYoY: round(revenueYoY * between(random, 0.6, 1.5), 2),
      deductNetProfitYoY: round(revenueYoY * between(random, 0.5, 1.4), 2),
    },
    balance: {
      totalAssets: round(assets, 0),
      totalLiabilities: round(liabilities, 0),
      equity: round(equity, 0),
      bps: round(equity / profile.shares, 4),
      debtRatio: round(profile.debtPct, 2),
      cash: round(assets * between(random, 0.05, 0.25), 0),
      interestDebt: round(liabilities * between(random, 0.1, 0.5), 0),
      netCash: null,
    },
    cashflow: {
      ocf: round(ocf, 0),
      icf: round(invest, 0),
      fcf: round(ocf + invest, 0),
      investCash: round(invest, 0),
      finCash: round(finCash, 0),
      ocfPerShare: round(ocf / profile.shares, 4),
    },
    ratios: {
      roe: round(profile.roePct, 2),
      netMargin: round(margin * 100, 2),
      debtRatio: round(profile.debtPct, 2),
      interestDebtRatio: null,
      dividendYieldPct: round(profile.yieldPct, 2),
      payoutRatio: round(profile.payoutRatio, 4),
      dividendPerShare: round(dps, 4),
    },
    shares: { totalShares: profile.shares },
    source: 'mock',
    mock: true,
  };
}

/**
 * 生成一份完整的模拟财报。
 * @param {object} instrument - canonical instrument.
 * @param {object} [options] - `periods`（1~8）与 `now`。
 * @returns `{ symbol, market, currency, unit, periods, mock, disclaimer }`
 */
export function buildMockFinancials(instrument, options = {}) {
  const periods = Math.min(8, Math.max(1, Number(options.periods) || 4));
  const now = options.now ?? new Date();
  const dates = recentReportDates(periods, now);
  const profile = companyProfile(instrument);
  return {
    symbol: finDataSymbol(instrument),
    market: instrument.market,
    currency: profile.currency,
    unit: '元',
    periods: dates.map((date) => mockPeriod(instrument, date)),
    mock: true,
    disclaimer: MOCK_DISCLAIMER,
  };
}

/** 模拟财报的金额量级定义，给文档与测试引用。 */
export const MOCK_UNIT = { money: '元', ratio: '%', fraction: '0~1' };
