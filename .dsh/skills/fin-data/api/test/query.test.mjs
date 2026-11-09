/**
 * fin-data 查询入口的离线契约测试。
 *
 *   node --test .dsh/skills/fin-data/api/test/query.test.mjs
 *
 * 只覆盖**不依赖网络**的行为：请求校验、模拟财报的形状与确定性、
 * 本地日线的读取与口径、status 与 manifest 的一致性、财报 -> 指标行的回写。
 * 真实上游的行为由 `.dsh/skills/fin-data/adapter/test/contract.test.mjs`（fixtures）覆盖。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DATA_DIR,
  ERROR_CODES,
  KINDS,
  QueryError,
  buildMockFinancials,
  describe,
  periodFromMetricRow,
  query,
  queryMany,
  toMetricRow,
  todayShanghai,
} from '../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
const dataset = manifest.datasets['daily.cn'];

test('describe() 暴露入口、kind 与适配器', () => {
  const info = describe();
  assert.equal(info.schema, 'fin-data.query/v1');
  assert.equal(info.entry, 'skills/fin-data/api/index.mjs');
  assert.ok(info.kinds.some((item) => item.kind === 'financials' && item.mock === true));
  assert.ok(info.providers.some((item) => item.name === 'tencent'));
  assert.equal(info.kinds.length, KINDS.length);
});

test('未知 kind 与非法标的直接抛 QueryError，不返回空壳信封', async () => {
  await assert.rejects(() => query({ kind: 'pe' }), (error) => {
    assert.ok(error instanceof QueryError);
    assert.equal(error.code, ERROR_CODES.UNKNOWN_KIND);
    return true;
  });
  await assert.rejects(() => query({ kind: 'quote', instrument: '贵州茅台' }), (error) => {
    assert.equal(error.code, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
  await assert.rejects(() => queryMany({ kind: 'quote', instruments: [] }), (error) => {
    assert.equal(error.code, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});

test('financials 的模拟数据：形状固定、可复现、永远可识别', async () => {
  const first = await query({ kind: 'financials', instrument: '600519', options: { source: 'mock', periods: 3 } });
  const second = await query({ kind: 'financials', instrument: '600519', options: { source: 'mock', periods: 3 } });

  assert.equal(first.ok, true);
  assert.equal(first.schema, 'fin-data.query/v1');
  assert.equal(first.meta.mock, true);
  assert.equal(first.meta.source, 'mock');
  assert.equal(first.data.mock, true);
  assert.equal(first.data.unit, '元');
  assert.equal(first.data.symbol, '600519.SH');
  assert.equal(first.data.periods.length, 3);
  assert.ok(first.data.disclaimer.includes('模拟'));

  // 确定性：同一标的、同一报告期，两次调用完全一致。
  assert.deepEqual(first.data, second.data);

  const period = first.data.periods[0];
  assert.match(period.reportDate, /^\d{4}-(03-31|06-30|09-30|12-31)$/);
  assert.match(period.reportName, /^\d{4}(一季报|半年报|三季报|年报)$/);
  assert.equal(period.mock, true);
  assert.equal(period.source, 'mock');
  assert.ok(period.income.netProfit > 0);
  assert.ok(period.income.revenue > period.income.netProfit);
  assert.ok(period.income.eps > 0);
  assert.ok(period.balance.totalAssets > period.balance.equity);
  assert.ok(period.shares.totalShares > 0);
  // 现金流量表口径：fcf = ocf + icf。
  assert.equal(period.cashflow.fcf, period.cashflow.ocf + period.cashflow.icf);
  // 报告期按时间倒序。
  assert.ok(period.reportDate > first.data.periods[1].reportDate);
});

test('financials 的模拟数据对港股同样可用，币种跟随市场', () => {
  const data = buildMockFinancials({ market: 'hk', code: '00700', key: 'hk:00700' }, { periods: 1 });
  assert.equal(data.symbol, '00700.HK');
  assert.equal(data.currency, 'HKD');
  assert.equal(data.periods[0].currency, 'HKD');
});

test('bars(source=local) 读 fin-data 落盘的 CSV，并标明不复权', async () => {
  const result = await query({ kind: 'bars', instrument: '600519', options: { source: 'local', limit: 5 } });
  assert.equal(result.ok, true);
  assert.equal(result.meta.source, 'fin-data/csv');
  assert.equal(result.meta.adjust, 'none');
  assert.equal(result.data.bars.length, 5);
  assert.equal(result.data.bars.at(-1)[0], dataset.lastTradeDate);
  assert.equal(result.data.bars.at(-1)[1].toFixed(2), result.data.bars.at(-1)[1].toFixed(2));
  for (const bar of result.data.bars) {
    assert.match(bar[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(bar[1] > 0 && bar[2] > 0); // open / close
    assert.ok(bar[5] >= 0); // volume
  }
});

test('bars(source=local) 对没有落盘的标的返回 ok:false，而不是编造序列', async () => {
  const result = await query({ kind: 'bars', instrument: '300750', options: { source: 'local' } });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.error.code, ERROR_CODES.NOT_FOUND);
});

test('status 与 manifest 是同一份事实', async () => {
  const result = await query({ kind: 'status' });
  assert.equal(result.ok, true);
  assert.equal(result.data.asOf, dataset.lastTradeDate);
  assert.equal(result.data.symbolCount, dataset.symbolCount);
  assert.equal(result.data.rowCount, dataset.rowCount);
  assert.equal(result.data.today, todayShanghai());
  assert.equal(result.data.timezone, 'Asia/Shanghai');
  assert.ok(Array.isArray(result.data.providers));
  assert.equal(typeof result.data.lastClosedSession, 'string');
  assert.equal(result.data.stale, dataset.lastTradeDate < result.data.lastClosedSession);
});

test('universe: sse50 直接读本地集合，离线可用', async () => {
  const result = await query({ kind: 'universe', options: { id: 'sse50' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.id, 'sse50');
  assert.equal(result.data.count, result.data.members.length);
  assert.ok(result.data.members.length >= 50);
  assert.ok(result.data.members.some((member) => member.symbol === '600519.SH'));
  assert.equal(result.data.members.find((member) => member.symbol === '000016.SH')?.kind, 'index');
});

test('universe: 缺 id / 未知 id 都是请求错误，不是空集合', async () => {
  await assert.rejects(() => query({ kind: 'universe', options: {} }), (error) => {
    assert.equal(error.code, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
  await assert.rejects(() => query({ kind: 'universe', options: { id: 'nope' } }), (error) => {
    assert.equal(error.code, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});

test('财报 -> 指标行：亿元口径可无损回写，供 9c / 看板复用', () => {
  const period = {
    reportDate: '2026-09-30',
    reportName: '2026三季报',
    noticeDate: '2026-10-31',
    currency: 'CNY',
    income: {
      revenue: 1332.84 * 1e8,
      netProfit: 644.67 * 1e8,
      deductNetProfit: 643.25 * 1e8,
      eps: 51.53,
      revenueYoY: 1.82,
      netProfitYoY: -0.25,
    },
    balance: { totalAssets: 3183.05 * 1e8, equity: 2804.22 * 1e8, bps: 216.95, debtRatio: 11.9, netCash: 21.01 * 1e8 },
    cashflow: { ocf: 840.59 * 1e8, icf: 258.25 * 1e8, ocfPerShare: 67.24 },
    ratios: { roe: 24.47, netMargin: 50.94, debtRatio: 11.9, payoutRatio: 0.5132, dividendYieldPct: 1.27 },
    shares: { totalShares: 1250081601 },
    source: 'eastmoney',
    mock: false,
  };
  const row = toMetricRow(period);
  assert.equal(row.revenueYi, 1332.84);
  assert.equal(row.netProfitYi, 644.67);
  assert.equal(row.ocfYi, 840.59);
  assert.equal(row.icfYi, 258.25);
  assert.equal(row.totalAssetsYi, 3183.05);
  assert.equal(row.netCashYi, 21.01);
  assert.equal(row.payoutRatioSnapshot, 0.5132);
  assert.equal(row.mock, false);

  const back = periodFromMetricRow({
    ...row,
    listingCurrency: null,
  });
  assert.equal(back.income.revenue, 133284000000);
  assert.equal(back.cashflow.fcf, 109884000000);
  assert.equal(back.periodType, 'Q3');
});
