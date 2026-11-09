#!/usr/bin/env node
/**
 * 双源行情核对：同一只股票分别向腾讯与 iFinD 取一次快照，比较价格、市盈率、
 * 市净率、总市值。两个源都来自公开/授权数据，偏差超过阈值就说明其中一方有问题
 * （或恰逢盘中变动）。
 *
 * 用法：
 *   node .dsh/skills/fin-data/api/verify-quotes.mjs
 *   node .dsh/skills/fin-data/api/verify-quotes.mjs 601318 000001
 *   node .dsh/skills/fin-data/api/verify-quotes.mjs 601318 --threshold 1
 *
 * 退出码：0 全部在阈值内；1 存在超阈值偏差或取数失败。
 */
import { get } from '../adapter/index.mjs';
import { parseInstrument } from '../adapter/instruments.mjs';

/** 默认核对标的。 */
const DEFAULT_CODES = ['601318', '600519'];

/** 相对偏差阈值（百分比）。 */
const DEFAULT_THRESHOLD = 0.5;

/** 参与比较的字段。 */
const FIELDS = [
  { key: 'price', label: '最新价' },
  { key: 'peTtm', label: '市盈率TTM' },
  { key: 'pb', label: '市净率' },
  { key: 'totalCapYi', label: '总市值' },
];

const round = (value, digits = 3) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/** 相对偏差（百分比）；任一侧缺值返回 null。 */
function deviation(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0) return 0;
  return (Math.abs(a - b) / base) * 100;
}

/**
 * 用指定 provider 取一次行情。
 * @param instrument - 规范化标的。
 * @param provider - provider 名称。
 * @param bypass - 是否跳过缓存。
 */
async function quoteFrom(instrument, provider, bypass) {
  const result = await get({ kind: 'quote', instrument: instrument.key, policy: { quote: [provider] }, bypassCache: bypass });
  if (!result.ok) return { ok: false, error: result.error.message, source: provider };
  return { ok: true, quote: result.data, source: result.meta.source };
}

function parseArgs(argv) {
  const codes = [];
  let threshold = DEFAULT_THRESHOLD;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--threshold') {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) threshold = parsed;
      index += 1;
      continue;
    }
    codes.push(arg);
  }
  return { codes: codes.length === 0 ? DEFAULT_CODES : codes, threshold };
}

async function main() {
  const { codes, threshold } = parseArgs(process.argv.slice(2));
  let failures = 0;
  const rows = [];

  for (const code of codes) {
    const instrument = parseInstrument(code);
    if (instrument === undefined) {
      console.log(`跳过无法识别的代码：${code}`);
      failures += 1;
      continue;
    }
    const [tencent, ifind] = await Promise.all([
      quoteFrom(instrument, 'tencent', true),
      quoteFrom(instrument, 'ifind', true),
    ]);

    if (!tencent.ok || !ifind.ok) {
      rows.push({
        code: instrument.key,
        name: tencent.quote?.name ?? ifind.quote?.name ?? '-',
        status: '取数失败',
        detail: [tencent.ok ? '' : `腾讯：${tencent.error}`, ifind.ok ? '' : `iFinD：${ifind.error}`]
          .filter(Boolean)
          .join('；'),
      });
      failures += 1;
      continue;
    }

    const diffs = FIELDS.map((field) => ({
      label: field.label,
      tencent: round(tencent.quote[field.key]),
      ifind: round(ifind.quote[field.key]),
      pct: round(deviation(tencent.quote[field.key], ifind.quote[field.key]), 2),
    }));
    const worst = Math.max(...diffs.map((diff) => diff.pct ?? 0));
    if (worst > threshold) failures += 1;

    rows.push({
      code: instrument.key,
      name: tencent.quote.name ?? ifind.quote.name ?? '-',
      status: worst > threshold ? `偏差 ${worst}%` : '一致',
      detail: diffs,
      worst,
    });
  }

  for (const row of rows) {
    console.log(`\n${row.code}  ${row.name}  —— ${row.status}`);
    if (Array.isArray(row.detail)) {
      for (const diff of row.detail) {
        const pct = diff.pct === null ? '缺值' : `${diff.pct}%`;
        console.log(`  ${diff.label.padEnd(10, ' ')} 腾讯 ${String(diff.tencent ?? '-').padStart(10)}  iFinD ${String(diff.ifind ?? '-').padStart(10)}  Δ ${pct}`);
      }
    } else if (row.detail !== undefined) {
      console.log(`  ${row.detail}`);
    }
  }

  console.log(
    `\n阈值 ${threshold}%：${failures === 0 ? '全部通过' : `${failures} 项超阈值或失败`}（数据源：腾讯 vs iFinD，均跳过缓存）`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
