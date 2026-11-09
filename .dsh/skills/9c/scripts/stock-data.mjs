#!/usr/bin/env node
/**
 * 人格化个股分析的数据接地脚本（A 股 / 港股），取自 **fin-data 的统一查询入口**。
 *
 * 取数、归一、缓存、降级、来源与新近度全部由 `fin-data/api` 负责；
 * 本脚本只做「取什么」和「怎么算」，不再直接引用 fin-data 的 `adapter/` 内部实现。
 *
 * 用法：
 *   node .dsh/skills/9c/scripts/stock-data.mjs resolve 中国平安
 *   node .dsh/skills/9c/scripts/stock-data.mjs quote 601318
 *   node .dsh/skills/9c/scripts/stock-data.mjs all 中国平安
 *   node .dsh/skills/9c/scripts/stock-data.mjs all hk:02318         # 港股：行情 + 财报 + 分红公告
 *   node .dsh/skills/9c/scripts/stock-data.mjs providers            # fin-data 入口自述
 *
 * 输出：单个 JSON 到 stdout。取不到的字段一律 null，不做猜测。
 * `dataQuality.financials === "mock"` 时，财报为 fin-data 的模拟数据，不能当作真实经营数据。
 */
import {
  describe as describeFinData,
  parseInstrument,
  query,
  toMetricRow,
  toSecuCode,
} from '../../fin-data/api/index.mjs';

/** 输出里保留的行情字段（与改造前逐字段一致）。 */
const QUOTE_KEYS = [
  'code',
  'name',
  'price',
  'prevClose',
  'changePct',
  'high',
  'low',
  'turnoverRate',
  'peTtm',
  'pb',
  'totalCapYi',
  'floatCapYi',
  'quoteTime',
];

/** 输出里保留的财务字段。 */
const FUNDAMENTAL_KEYS = [
  'reportDate',
  'reportName',
  'noticeDate',
  'currency',
  'eps',
  'bps',
  'revenueYi',
  'revenueYoY',
  'netProfitYi',
  'netProfitYoY',
  'deductNetProfitYi',
  'deductedYoY',
  'roe',
  'netMargin',
  'debtRatio',
  'interestDebtRatio',
  'ocfYi',
  'icfYi',
  'ocfPerShare',
  'totalAssetsYi',
  'totalEquityYi',
  'totalShares',
  'investCashYi',
  'finCashYi',
];

/** 输出里保留的分红字段。 */
const DIVIDEND_KEYS = ['reportDate', 'fiscalYear', 'plan', 'cashPer10', 'exDate', 'recordDate', 'status'];

/** 输出里保留的年报字段。 */
const ANNUAL_KEYS = ['fiscalYear', 'reportDate', 'netProfitYi', 'totalShares'];

const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));

const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

/** 元 -> 亿元。 */
const toYi = (value) => (value === null ? null : round(value / 1e8, 2));

/** 把最近 365 天内的每股派息加总，得到 TTM 每股分红。 */
function ttmDividend(rows, now) {
  const cutoff = now - 365 * 24 * 3600 * 1000;
  let perShare = 0;
  const used = [];
  for (const row of rows) {
    if (row.cashPer10 === null || row.exDate === null) continue;
    const at = Date.parse(`${row.exDate}T00:00:00+08:00`);
    if (!Number.isFinite(at) || at < cutoff) continue;
    perShare += row.cashPer10 / 10;
    used.push({ exDate: row.exDate, perShare: round(row.cashPer10 / 10, 4) });
  }
  return { perShare: round(perShare, 4), used };
}

/**
 * 按财年汇总派息，并与该财年归母净利润相除，得到历年派息率。
 * 派息记录按"所属报告期"归入财年：2025-12-31 的分红记入 2025 财年。
 */
function payoutByFiscalYear(annual, dividends) {
  const buckets = new Map();
  for (const row of annual) {
    if (row.fiscalYear === null) continue;
    buckets.set(row.fiscalYear, {
      fiscalYear: row.fiscalYear,
      netProfitYi: row.netProfitYi,
      totalShares: row.totalShares,
      dps: 0,
      count: 0,
    });
  }
  for (const row of dividends) {
    if (row.cashPer10 === null || row.fiscalYear === null) continue;
    const bucket = buckets.get(row.fiscalYear);
    if (bucket === undefined) continue;
    bucket.dps += row.cashPer10 / 10;
    bucket.count += 1;
  }

  const complete = [...buckets.values()].filter(
    (b) => b.netProfitYi !== null && b.netProfitYi > 0 && b.dps > 0 && b.totalShares !== null,
  );
  // 最老的财年常常只抓到一半派息（公告超出回溯范围），用"派息记录数与最多年份一致"
  // 过滤掉这些残年，否则"最低派息率"会被一个残缺的年份压低。
  const typicalCount = complete.reduce((max, b) => Math.max(max, b.count), 0);

  return complete
    .filter((b) => b.count === typicalCount)
    .map((b) => {
      const totalDivYi = toYi(b.dps * b.totalShares);
      return {
        fiscalYear: b.fiscalYear,
        dps: round(b.dps, 4),
        totalDivYi,
        payoutRatio: totalDivYi === null ? null : round(totalDivYi / b.netProfitYi, 4),
      };
    });
}

/**
 * 派生指标。公式与口径写在 `formulas` 里，方便回答时原样引用。
 * 这里是"够用的近似"，不是审计口径。
 */
function derive(quote, fundamentals, annual, dividends, now, options = {}) {
  const latest = fundamentals[0] ?? null;
  const ttm = ttmDividend(dividends, now);
  const price = quote.price;
  const marketCapYi = quote.totalCapYi;
  const crossCurrency = options.crossCurrency === true;
  const fxRate = options.fxRate ?? null;

  // 有逐笔明细（A 股表格 / 港股公告）就用明细；没有才退回东财快照的
  // DPS_HKD、股息率与派息率。两者都不猜测。
  const declaredCurrency = dividends[0]?.currency ?? null;
  const declaredDps = dividends.length > 0 ? ttm.perShare : (latest?.dps ?? null);
  // 港股常以人民币宣派、按港币派付；与港币股价相除前先换汇。
  const needsFx = crossCurrency && declaredCurrency !== null && !/HKD/i.test(declaredCurrency);
  const priceDps =
    declaredDps === null ? null : needsFx ? (fxRate === null ? null : round(declaredDps / fxRate, 4)) : declaredDps;
  const snapshotYield =
    dividends.length === 0 && latest?.dividendYieldPct !== null && latest?.dividendYieldPct !== undefined
      ? round(latest.dividendYieldPct / 100, 4)
      : null;
  const dividendYieldTtm =
    dividends.length > 0
      ? priceDps !== null && price !== null && price > 0
        ? round(priceDps / price, 4)
        : null
      : snapshotYield;

  const payouts = payoutByFiscalYear(annual, dividends);
  const ratios = payouts.map((p) => p.payoutRatio).filter((r) => r !== null);
  // "最低股息支付率"取可得财年里的最小值：他问的是"就算按公司最抠的派息比例，
  // 我能拿回多少"，所以用最小值而不是平均值。
  const minimumPayoutRatio =
    ratios.length === 0 ? (latest?.payoutRatioSnapshot ?? null) : round(Math.min(...ratios), 4);

  const normalized = annual[0] ?? null;
  // 港股报表多以人民币列示、市值按港币计：有汇率就换算成人民币再比，
  // 拿不到汇率就不给这个数——宁缺，不给一个币种错配的结论。
  const marketCapCnyYi =
    marketCapYi === null ? null : crossCurrency ? (fxRate === null ? null : round(marketCapYi * fxRate, 2)) : marketCapYi;
  const penetrationReturn =
    marketCapCnyYi === null ||
    normalized?.netProfitYi === null ||
    normalized?.netProfitYi === undefined ||
    minimumPayoutRatio === null ||
    marketCapCnyYi <= 0
      ? null
      : round((normalized.netProfitYi * minimumPayoutRatio) / marketCapCnyYi, 4);

  // 因子三的"真实可支配现金"代理：经营现金流净额 + 投资现金流净额。
  const freeCashFlowProxyYi =
    latest !== null && latest.ocfYi !== null && latest.icfYi !== null
      ? round(latest.ocfYi + latest.icfYi, 2)
      : null;

  return {
    dividendPerShareTtm: declaredDps,
    dividendYieldTtm,
    normalizedNetProfitYi: normalized?.netProfitYi ?? null,
    normalizedNetProfitYear: normalized?.fiscalYear ?? null,
    minimumPayoutRatio,
    payoutByFiscalYear: payouts,
    penetrationReturn,
    ...(crossCurrency
      ? {
          penetrationBasis: dividends.length > 0 ? 'minimum-payout' : 'payout-snapshot',
          fxRate,
          marketCapCnyYi,
          dividendCurrency: declaredCurrency,
          dividendPerSharePriceCurrency: priceDps,
        }
      : {}),
    freeCashFlowProxyYi,
    dividendRecordsUsed: ttm.used,
    formulas: {
      dividendYieldTtm:
        dividends.length > 0
          ? needsFx
            ? '最近 365 天每股宣派派息 / HKDCNY 汇率 / 当前股价'
            : '最近 365 天内每股税前派息合计 / 当前股价'
          : '数据源直接给出的股息率（港股快照 DIVIDEND_RATE）',
      normalizedNetProfitYi: '最近一个完整财年的归母净利润',
      minimumPayoutRatio:
        dividends.length > 0
          ? '各财年（派息总额 / 归母净利润）中的最小值'
          : '数据源给出的派息率快照（DIVI_RATIO，非历年最小值）',
      penetrationReturn: crossCurrency
        ? fxRate === null
          ? '港股需汇率换算，本次未取到汇率，不计算（返回 null）'
          : '(最近年报归母净利润 × 最低派息率) / (港币市值 × HKDCNY 汇率)'
        : '(最近年报归母净利润 × 最低派息率) / 总市值',
      freeCashFlowProxyYi: '经营现金流净额 + 投资现金流净额（投资净额已含资本开支与对外投资，均为负向流出）',
    },
  };
}

/** 港股财务快照额外提供的字段；A 股没有这些列，输出里也不会出现。 */
const HK_EXTRA_KEYS = ['dps', 'dividendYieldPct', 'payoutRatioSnapshot'];

/** 港股分红公告解析出来的字段；A 股没有，输出里也不会出现。 */
const HK_DIVIDEND_KEYS = ['currency', 'payDate', 'artCode', 'url'];

/** 把统一层返回的候选映射回本脚本的历史输出形状。 */
const mapCandidate = (candidate) => ({
  code: candidate.code,
  secuCode: candidate.market === 'hk' ? `${candidate.code}.HK` : toSecuCode(parseInstrument(candidate.instrument)),
  name: candidate.name,
  kind: candidate.kind,
});

/**
 * 取数并组装单个标的。
 * @param input - 名称、代码或 `market:code`。
 * @param options - `periods`。
 */
async function buildSubject(input, options) {
  const warnings = [];

  let instrument = parseInstrument(input);
  let resolvedFrom = null;
  if (instrument === undefined) {
    const found = await query({ kind: 'search', query: input });
    const first = found.ok ? found.data.candidates[0] : undefined;
    if (first === undefined) {
      throw new Error(`无法解析标的："${input}"。请改用代码，例如 601318 / hk:02318。`);
    }
    instrument = parseInstrument(first.instrument);
    // 只保留与选中标的市场相同的候选，避免 A/H 双上市时把两个市场混进同一份输出。
    const sameMarket = found.data.candidates.filter((candidate) => candidate.market === instrument.market);
    resolvedFrom = { query: input, candidates: sameMarket.map(mapCandidate) };
  }

  const [quoteResult, financialsResult, annualResult, dividendsResult, fxResult] = await Promise.all([
    query({ kind: 'quote', instrument: instrument.key }),
    query({ kind: 'financials', instrument: instrument.key, options: { periods: options.periods } }),
    query({ kind: 'annual', instrument: instrument.key, options: { years: 3 } }),
    query({ kind: 'dividends', instrument: instrument.key, options: { limit: 12 } }),
    instrument.market === 'hk' ? query({ kind: 'fx', pair: 'HKDCNY' }) : Promise.resolve(undefined),
  ]);

  if (!quoteResult.ok) throw new Error(`行情取数失败：${quoteResult.error.message}`);

  const toFundamental = (row) => {
    const base = pick(row, FUNDAMENTAL_KEYS);
    // 港股快照独有的列，只有真的有值时才出现，A 股输出保持原样。
    for (const key of HK_EXTRA_KEYS) {
      if (row[key] !== null && row[key] !== undefined) base[key] = row[key];
    }
    return base;
  };

  const toDividend = (row) => {
    const base = pick(row, DIVIDEND_KEYS);
    // 港股公告解析出来的字段：只在有值时出现，A 股输出保持原样。
    for (const key of HK_DIVIDEND_KEYS) {
      if (row[key] !== null && row[key] !== undefined) base[key] = row[key];
    }
    return base;
  };

  // 财报统一走 fin-data 的 financials 入口；`toMetricRow` 把它摊回本脚本历史字段。
  const fundamentals = financialsResult.ok
    ? (financialsResult.data.periods ?? []).map((period) => toFundamental(toMetricRow(period)))
    : [];
  const annual = annualResult.ok ? annualResult.data.rows.map((row) => pick(row, ANNUAL_KEYS)) : [];
  const dividends = dividendsResult.ok ? dividendsResult.data.rows.map(toDividend) : [];

  for (const [label, result] of [
    ['财报', financialsResult],
    ['年报', annualResult],
    ['分红', dividendsResult],
  ]) {
    if (result.ok) {
      if (result.meta.stale) warnings.push(`${label}数据为过期缓存（${result.meta.fetchedAt}）`);
      continue;
    }
    // 港股没有逐笔分红明细是数据源限制，不是故障：说清楚替代口径。
    if (label === '分红' && instrument.market === 'hk') {
      warnings.push('港股无逐笔分红明细（数据源不提供），股息率与派息率改用财务快照的 DIVIDEND_RATE / DIVI_RATIO。');
      continue;
    }
    warnings.push(`${label}数据不可用：${result.error.message}`);
  }

  const financialsMock = financialsResult.ok && financialsResult.meta.mock === true;
  if (financialsMock) {
    warnings.unshift(
      '财报为 fin-data 的模拟数据（source=mock），不是真实经营数据；本次定量结论只用于联调接口，不能作为投资依据。',
    );
  }
  if (instrument.market === 'hk') {
    if (dividendsResult.ok) {
      warnings.push('港股分红来自港交所派息公告解析（含除净日、派息日），宣派币种可能与实付币种不同，股息率已按 HKDCNY 折成港币。');
    }
    warnings.push(
      '港股报表多以人民币列示、市值按港币计：穿透回报率按 HKDCNY 汇率换算，派息率按已解析公告的财年合计计算。',
    );
    if (fxResult?.ok !== true) warnings.push(`汇率不可用：${fxResult?.error?.message ?? 'unknown'}，穿透回报率不计算`);
  } else if (financialsResult.ok && fundamentals[0]?.currency !== null && fundamentals[0]?.currency !== 'CNY') {
    warnings.push('非人民币报表，跨市场比较需换算。');
  }

  const quote = pick(quoteResult.data, QUOTE_KEYS);

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    // provenance 全部来自 fin-data 的信封，不再写死来源字符串。
    sources: {
      quote: quoteResult.meta.source,
      financials: financialsResult.ok ? financialsResult.meta.source : null,
      annual: annualResult.ok ? annualResult.meta.source : null,
      dividends: dividendsResult.ok ? dividendsResult.meta.source : null,
      fx: fxResult?.ok === true ? fxResult.meta.source : null,
    },
    asOf: {
      quote: quoteResult.meta.asOf,
      financials: financialsResult.ok ? financialsResult.meta.asOf : null,
      annual: annualResult.ok ? annualResult.meta.asOf : null,
      dividends: dividendsResult.ok ? dividendsResult.meta.asOf : null,
    },
    dataQuality: {
      financials: financialsResult.ok ? (financialsMock ? 'mock' : 'real') : 'unavailable',
      financialsDisclaimer: financialsResult.ok ? (financialsResult.data.disclaimer ?? null) : null,
    },
    subject: {
      code: quoteResult.data.code,
      secuCode: toSecuCode(instrument),
      name: quoteResult.data.name || input,
      resolvedFrom,
    },
    quote,
    fundamentals,
    annual,
    dividends,
    derived: derive(quote, fundamentals, annual, dividends, Date.now(), {
      crossCurrency: instrument.market === 'hk',
      fxRate: fxResult?.ok === true ? fxResult.data.rate : null,
    }),
    warnings,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'stock-data.mjs — 人格化个股分析的数据接地（A 股 / 港股行情，取自 fin-data）',
      '',
      '  node .dsh/skills/9c/scripts/stock-data.mjs resolve <名称>     名称 -> 候选代码',
      '  node .dsh/skills/9c/scripts/stock-data.mjs quote <代码>       仅快照行情',
      '  node .dsh/skills/9c/scripts/stock-data.mjs all <名称|代码>    行情 + 财报 + 分红 + 派生指标（默认）',
      '  node .dsh/skills/9c/scripts/stock-data.mjs providers          fin-data 查询入口自述',
      '',
      '选项：--periods <n>  取最近 n 期财报，默认 4（最多 8）',
      '',
      '代码写法：601318 / sh601318 / cn:601318 / hk:02318 / 02318',
      '港股有行情、财报与年报；无分红明细，穿透回报率因跨币种返回 null。',
      '',
      '输出为 JSON；取不到的字段一律 null，不做猜测。',
      'dataQuality.financials = "mock" 表示财报为模拟数据（fin-data 接口联调用）。',
      '',
    ].join('\n'),
  );
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    return 0;
  }
  const periodIndex = args.indexOf('--periods');
  const periods = periodIndex === -1 ? 4 : Math.min(8, Math.max(1, Number(args[periodIndex + 1]) || 4));
  const positional = args.filter(
    (arg, index) => arg !== '--periods' && (periodIndex === -1 || index !== periodIndex + 1),
  );
  const [command, target] = positional;

  if (command === 'providers') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...describeFinData() }, null, 2)}\n`);
    return 0;
  }

  if (target === undefined) {
    printHelp();
    return 1;
  }

  if (command === 'resolve') {
    const result = await query({ kind: 'search', query: target });
    const candidates = result.ok ? result.data.candidates.map(mapCandidate) : [];
    process.stdout.write(`${JSON.stringify({ ok: result.ok, query: target, candidates }, null, 2)}\n`);
    return candidates.length === 0 ? 2 : 0;
  }

  if (command === 'quote') {
    const instrument = parseInstrument(target);
    if (instrument === undefined) throw new Error(`无法识别的代码：${target}`);
    const result = await query({ kind: 'quote', instrument: instrument.key });
    if (!result.ok) throw new Error(`行情取数失败：${result.error.message}`);
    process.stdout.write(
      `${JSON.stringify({ ok: true, quote: pick(result.data, QUOTE_KEYS), meta: result.meta }, null, 2)}\n`,
    );
    return 0;
  }

  if (command === 'all') {
    const payload = await buildSubject(target, { periods });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  printHelp();
  return 1;
}

main(process.argv).then(
  (code) => {
    // 用 exitCode 而不是 process.exit：后者会在 Windows 管道场景下
    // 与仍在刷新的 stdout 抢生命周期，偶发截断或 libuv assertion。
    process.exitCode = code;
  },
  (error) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  },
);
