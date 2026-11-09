/**
 * Contract tests for the data layer.
 *
 * Two kinds of guarantees:
 * 1. parsers against frozen upstream fixtures — an upstream layout change must
 *    break a test here, not a user's answer;
 * 2. router semantics — fallback, stale reads, and honest failures — against
 *    fake providers, with no network.
 *
 * Run: node --test .dsh/skills/fin-data/adapter/test/
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { get, getMany, clearCache, listProviders, registerProvider } from '../index.mjs';
import { parseInstrument, toSecuCode } from '../instruments.mjs';
import { parseHkDividend, toHkDividendRows } from '../dividend-parse.mjs';
import { isConfigured, resolveSkillDir } from '../providers/ifind.mjs';
import { tableRows, toQuote as toIfindQuote } from '../providers/ifind.mjs';
import { parseBars, parseFx, parseQuoteText, parseSmartbox } from '../providers/tencent.mjs';
import {
  parseAnnual,
  parseDividends,
  parseFundamentals,
  parseHkAnnual,
  parseHkFundamentals,
} from '../providers/eastmoney.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name));
const fixtureText = (name, encoding = 'utf-8') => new TextDecoder(encoding).decode(fixture(name));
const fixtureJson = (name) => JSON.parse(fixtureText(name));

test('instrument parsing covers the accepted spellings', () => {
  assert.equal(parseInstrument('601318').key, 'cn:sh601318');
  assert.equal(parseInstrument('sh600519').key, 'cn:sh600519');
  assert.equal(parseInstrument('cn:601318').key, 'cn:sh601318');
  assert.equal(parseInstrument('300750').key, 'cn:sz300750');
  assert.equal(parseInstrument('830799').key, 'cn:bj830799');
  assert.equal(parseInstrument('hk:02318').key, 'hk:02318');
  assert.equal(parseInstrument('02318').key, 'hk:02318');
  assert.equal(parseInstrument('700').key, 'hk:00700');
  assert.equal(parseInstrument(''), undefined);
  assert.equal(parseInstrument('中国平安'), undefined);
  assert.equal(toSecuCode(parseInstrument('601318')), '601318.SH');
  assert.equal(toSecuCode(parseInstrument('hk:02318')), '02318.HK');
});

test('tencent A-share quote fixture parses into the normalized shape', () => {
  const [quote] = parseQuoteText(fixtureText('tencent-quote-cn.txt', 'gbk'));
  assert.equal(quote.instrument, 'cn:sh601318');
  assert.equal(quote.market, 'cn');
  assert.equal(quote.name, '中国平安');
  assert.equal(quote.currency, 'CNY');
  assert.ok(quote.price > 0);
  assert.ok(quote.totalCapYi > 1000);
  assert.notEqual(quote.pb, null, 'A-share layout exposes price/book at index 46');
  assert.notEqual(quote.turnoverRate, null, 'A-share layout exposes turnover at index 38');
});

test('tencent Hong Kong quote fixture normalizes to the same keys as A shares', () => {
  const [quote] = parseQuoteText(fixtureText('tencent-quote-hk.txt', 'gbk'));
  assert.equal(quote.instrument, 'hk:02318');
  assert.equal(quote.currency, 'HKD');
  assert.equal(quote.name, '中国平安');
  assert.ok(quote.price > 0);
  assert.ok(quote.peTtm > 0);
  // Hong Kong inserts the English name at index 46, which shifts price/book.
  assert.equal(quote.pb, null);
  assert.equal(quote.turnoverRate, null);

  const [cnQuote] = parseQuoteText(fixtureText('tencent-quote-cn.txt', 'gbk'));
  assert.deepEqual(Object.keys(quote).sort(), Object.keys(cnQuote).sort());
});

test('smartbox search keeps both markets and canonical instruments', () => {
  const text = fixtureText('tencent-quote-cn.txt', 'gbk');
  assert.deepEqual(parseQuoteText(text).length, 1);
  const hint = parseSmartbox('v_hint="sh~601318~\\u4e2d\\u56fd\\u5e73\\u5b89~zgpa~GP-A^hk~02318~\\u4e2d\\u56fd\\u5e73\\u5b89~zgpa~GP"');
  assert.equal(hint[0].instrument, 'cn:sh601318');
  assert.equal(hint[1].instrument, 'hk:02318');
  assert.equal(hint[1].code, '02318');
});

test('bars parser drops malformed rows and keeps numeric ones', () => {
  const bars = parseBars(
    { data: { sh601318: { qfqday: [['2026-10-30', '50.1', '50.5', '51.0', '49.9', '1000'], ['bad'], ['2026-10-31', 'x', '1', '1', '1', '1']] } } },
    'sh601318',
  );
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0], ['2026-10-30', 50.1, 50.5, 51, 49.9, 1000]);
});

test('eastmoney fundamentals fixture maps to normalized rows', () => {
  const rows = parseFundamentals(fixtureJson('eastmoney-fundamentals-cn.json'));
  assert.equal(rows.length, 2);
  const [latest] = rows;
  assert.equal(latest.reportDate, '2026-09-30');
  assert.equal(typeof latest.netProfitYi, 'number');
  assert.equal(typeof latest.debtRatio, 'number');
  assert.equal(typeof latest.ocfYi, 'number');
  // Every row must expose the full key set consumers rely on.
  for (const key of ['roe', 'netMargin', 'totalShares', 'investCashYi', 'finCashYi']) {
    assert.ok(key in latest, `missing key ${key}`);
  }
});

test('eastmoney dividend and annual fixtures map to normalized rows', () => {
  const dividends = parseDividends(fixtureJson('eastmoney-dividends-cn.json'));
  assert.ok(dividends.length >= 1);
  assert.equal(typeof dividends[0].cashPer10, 'number');
  assert.equal(dividends[0].fiscalYear, 2026);

  const annual = parseAnnual(fixtureJson('eastmoney-annual-cn.json'));
  assert.equal(annual.length, 3);
  assert.deepEqual(
    annual.map((row) => row.fiscalYear),
    [2025, 2024, 2023],
  );
  assert.ok(annual[0].netProfitYi > annual[2].netProfitYi);
});

test('router falls back to the next provider and records the failure', async () => {
  clearCache();
  registerProvider({
    name: 'fake-down',
    capabilities: { kinds: ['quote'], markets: ['cn'] },
    async fetch() {
      throw new Error('boom');
    },
  });
  registerProvider({
    name: 'fake-up',
    capabilities: { kinds: ['quote'], markets: ['cn'] },
    async fetch() {
      return { data: { price: 1 } };
    },
  });

  const result = await get({
    kind: 'quote',
    instrument: 'cn:601318',
    policy: { quote: ['fake-down', 'fake-up'] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.source, 'fake-up');
  assert.equal(result.meta.degraded.length, 1);
  assert.equal(result.meta.degraded[0].provider, 'fake-down');
});

test('router returns the stale cache instead of an empty answer', async () => {
  clearCache();
  let calls = 0;
  registerProvider({
    name: 'flaky',
    capabilities: { kinds: ['fundamentals'], markets: ['cn'] },
    async fetch() {
      calls += 1;
      if (calls > 1) throw new Error('upstream died');
      return { data: { rows: [{ netProfitYi: 10 }] } };
    },
  });

  const first = await get({ kind: 'fundamentals', instrument: 'cn:601318', policy: { fundamentals: ['flaky'] }, ttlMs: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.meta.stale, false);

  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await get({ kind: 'fundamentals', instrument: 'cn:601318', policy: { fundamentals: ['flaky'] }, ttlMs: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.meta.stale, true);
  assert.deepEqual(second.data, { rows: [{ netProfitYi: 10 }] });
  assert.match(second.warnings.join(' '), /last cached payload/);
});

test('router reports an honest failure when nothing can answer', async () => {
  clearCache();
  registerProvider({
    name: 'broken',
    capabilities: { kinds: ['dividends'], markets: ['cn'] },
    async fetch() {
      throw new Error('nope');
    },
  });
  const result = await get({ kind: 'dividends', instrument: 'cn:601318', policy: { dividends: ['broken'] } });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.error.providers.length, 1);
});

test('a policy naming an unregistered provider warns instead of throwing', async () => {
  clearCache();
  const result = await get({ kind: 'quote', instrument: 'cn:601318', policy: { quote: ['ghost', 'tencent'] } });
  assert.ok(result.warnings.some((warning) => warning.includes('ghost')));
});

test('hong kong fundamentals map to the same key set as A shares', () => {
  const cnRows = parseFundamentals(fixtureJson('eastmoney-fundamentals-cn.json'));
  const hkRows = parseHkFundamentals(fixtureJson('eastmoney-fundamentals-hk.json'));
  assert.ok(hkRows.length >= 2);
  assert.deepEqual(Object.keys(hkRows[0]).sort(), Object.keys(cnRows[0]).sort());

  const [latest] = hkRows;
  assert.equal(latest.reportDate, '2026-09-30');
  assert.match(latest.reportName, /三季报/);
  assert.equal(latest.netProfitYi, 966.45);
  assert.equal(latest.roe, 9.45);
  assert.equal(latest.debtRatio, 89.8);
  assert.equal(latest.dividendYieldPct, 6.32);
  assert.equal(typeof latest.dps, 'number');
  // The HK report has no deducted-profit or interest-debt column.
  assert.equal(latest.deductNetProfitYi, null);
  assert.equal(latest.interestDebtRatio, null);
  // Total equity is derived as assets - liabilities so it means the same thing
  // in both markets (the HK report itself exposes parent equity only).
  assert.equal(latest.totalEquityYi, 14750.7);
});

test('hong kong annual rows keep only full-year reports', () => {
  const annual = parseHkAnnual(fixtureJson('eastmoney-fundamentals-hk.json'));
  assert.ok(annual.length >= 2, `expected at least two annual rows, got ${annual.length}`);
  assert.ok(
    annual.every((row) => row.reportDate.endsWith('12-31')),
    'every annual row must close the fiscal year',
  );
  assert.equal(annual[0].netProfitYi, 1347.78);
  assert.deepEqual(
    annual.map((row) => row.fiscalYear),
    [...annual.map((row) => row.fiscalYear)].sort((a, b) => b - a),
    'annual rows stay newest first',
  );
});

test('fx snapshot parses the rate and rejects an empty feed', () => {
  const fx = parseFx(fixtureText('tencent-fx.txt'), 'HKDCNY');
  assert.equal(fx.pair, 'HKDCNY');
  assert.equal(fx.rate, 0.8467);
  assert.equal(fx.time, '20261102151806');
  assert.equal(parseFx('v_pv_none_match="1";', 'HKDCNY'), undefined);
  // The pair is part of the record name, so a different pair must not match.
  assert.equal(parseFx(fixtureText('tencent-fx.txt'), 'EURCNY'), undefined);
});

test('fx requests validate their pair before touching a provider', async () => {
  await assert.rejects(() => get({ kind: 'fx', pair: 'HKD' }), /six-letter pair/);
});

test('getMany batches uncached instruments in one call and preserves order', async () => {
  clearCache();
  let batchCalls = 0;
  let singleCalls = 0;
  registerProvider({
    name: 'batcher',
    capabilities: { kinds: ['quote'], markets: ['cn'] },
    async fetch(request) {
      singleCalls += 1;
      return { data: { instrument: request.instrument.key, price: 1 } };
    },
    async fetchMany(request) {
      batchCalls += 1;
      const byInstrument = {};
      for (const instrument of request.instruments) {
        byInstrument[instrument.key] = { instrument: instrument.key, price: 2 };
      }
      return { data: { byInstrument } };
    },
  });

  const result = await getMany({
    kind: 'quote',
    instruments: ['cn:601318', 'cn:600519', '601318'],
    policy: { quote: ['batcher'] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2, 'duplicates collapse to one instrument');
  assert.deepEqual(
    result.items.map((item) => item.instrument),
    ['cn:sh601318', 'cn:sh600519'],
  );
  assert.equal(batchCalls, 1, 'one upstream call for the whole watchlist');
  assert.equal(singleCalls, 0, 'cached batch results are not refetched one by one');
  assert.equal(result.items[0].data.price, 2);
  assert.equal(result.meta.stale, false);
  assert.equal(result.meta.fetchedAt, result.items[0].meta.fetchedAt);
});

test('getMany reports invalid instruments without failing the batch', async () => {
  clearCache();
  registerProvider({
    name: 'single',
    capabilities: { kinds: ['quote'], markets: ['cn'] },
    async fetch(request) {
      return { data: { instrument: request.instrument.key, price: 3 } };
    },
  });
  const result = await getMany({
    kind: 'quote',
    instruments: ['cn:601318', 'not-a-code'],
    policy: { quote: ['single'] },
  });
  assert.deepEqual(result.invalid, ['not-a-code']);
  assert.equal(result.items.length, 1);
  assert.equal(result.ok, true);
});

test('a Hong Kong cash-dividend announcement parses into structured fields', () => {
  const body = fixtureJson('eastmoney-ann-hk-content.json');
  const parsed = parseHkDividend(body.data.notice_content);
  assert.equal(parsed.type, '中期（半年期）');
  assert.equal(parsed.periodEnd, '2026-06-30');
  assert.equal(parsed.perShare, 0.98);
  assert.equal(parsed.currency, 'RMB');
  assert.equal(parsed.exDate, '2026-09-02');
  assert.equal(parsed.payDate, '2026-10-16');
});

test('prose announcements are rejected instead of parsed as dividends', () => {
  const noise = ['沒收未領取的2018年度末期股息', '股息貨幣選擇表格', '本公司謹此通知，股息派發安排如下，詳情請參閱公告。'].join(
    '\n',
  );
  const parsed = parseHkDividend(noise);
  assert.equal(parsed.perShare, null);
  assert.equal(parsed.exDate, null);
});

test('dividend rows dedupe updated announcements and drop incomplete ones', () => {
  const rows = toHkDividendRows([
    {
      announcement: { artCode: 'A1', date: '2026-08-20', url: 'https://example/1' },
      parsed: { type: '中期（半年期）', periodEnd: '2026-06-30', perShare: 0.98, currency: 'RMB', exDate: '2026-09-02', payDate: '2026-10-16' },
    },
    {
      announcement: { artCode: 'A2', date: '2026-09-10', url: 'https://example/2' },
      parsed: { type: '中期（半年期）', periodEnd: '2026-06-30', perShare: 0.98, currency: 'RMB', exDate: '2026-09-02', payDate: '2026-10-16' },
    },
    {
      announcement: { artCode: 'A3', date: '2026-06-01', url: 'https://example/3' },
      parsed: { type: '末期', periodEnd: '2025-12-31', perShare: 1.75, currency: 'RMB', exDate: null, payDate: null },
    },
  ]);
  assert.equal(rows.length, 1, 'one period, one row; the pending 末期 has no ex-date');
  assert.equal(rows[0].artCode, 'A2', 'the later announcement wins');
  assert.equal(rows[0].cashPer10, 9.8);
  assert.equal(rows[0].fiscalYear, 2026);
  assert.equal(rows[0].currency, 'RMB');
});

test('ifind table rows map onto the shared quote shape', () => {
  const payload = fixtureJson('ifind-quote-cn.json');
  const rows = tableRows(payload);
  assert.equal(rows.length, 2);

  const quote = toIfindQuote(rows[0]);
  assert.equal(quote.instrument, 'cn:sh601318');
  assert.equal(quote.name, '中国平安');
  assert.equal(quote.currency, 'CNY');
  assert.equal(quote.price, 53.12);
  // The service reports market value in yuan; the layer speaks 亿元.
  assert.equal(quote.totalCapYi, 9618.78);
  assert.equal(quote.peTtm, 9.75862046);
  assert.equal(quote.pb, 0.921103);
  // Previous close is derived from the percentage change.
  assert.equal(quote.prevClose, 52.8);
});

test('ifind rows without a price are dropped instead of guessed', () => {
  const payload = { data: { tables: [['证券代码', '证券简称', '最新价'], ['601318.SH', '中国平安', '']] } };
  const quote = toIfindQuote(tableRows(payload)[0]);
  assert.equal(quote, null);
});

test('ifind skill location honours the env override and the install roots', () => {
  const previous = process.env.IFIND_SKILL_DIR;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ifind-skill-'));
  try {
    fs.writeFileSync(path.join(temp, 'call-node.js'), 'module.exports = {};\n');
    process.env.IFIND_SKILL_DIR = temp;
    assert.equal(resolveSkillDir(), temp);
    assert.equal(isConfigured(temp), false, 'a config without a key is not configured');
    assert.equal(isConfigured(null), false, 'no directory means no key');
  } finally {
    if (previous === undefined) delete process.env.IFIND_SKILL_DIR;
    else process.env.IFIND_SKILL_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the default registry exposes capability declarations', () => {
  const providers = listProviders();
  const names = providers.map((provider) => provider.name);
  for (const name of ['tencent', 'eastmoney', 'private']) {
    assert.ok(names.includes(name), `missing provider ${name}`);
  }
  const tencent = providers.find((provider) => provider.name === 'tencent');
  assert.deepEqual(tencent.markets.sort(), ['cn', 'hk']);
  const eastmoney = providers.find((provider) => provider.name === 'eastmoney');
  assert.deepEqual(eastmoney.markets.sort(), ['cn', 'hk'], 'Hong Kong statements are mapped now');
  const announcements = providers.find((provider) => provider.name === 'eastmoney-ann');
  assert.ok(announcements.kinds.includes('dividends'), 'Hong Kong dividends come from announcements');
  assert.ok(announcements.kinds.includes('announcements'));
  const ifind = providers.find((provider) => provider.name === 'ifind');
  assert.deepEqual(ifind.kinds, ['quote'], 'only the structured iFinD tool is wired');
  assert.deepEqual(ifind.markets, ['cn']);
  const privateProvider = providers.find((provider) => provider.name === 'private');
  assert.deepEqual(privateProvider.kinds, [], 'the private provider must claim nothing until configured');
});
