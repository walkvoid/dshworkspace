/**
 * 龟龟选股：把「史诗级韭菜」的收息框架落成一套可复算的港股筛选。
 *
 * 只做四件事：
 *   1. 固定一个「非周期、有真实现金流」的港股观察池（公用 / 电信 / 公路 / 收租 / 消费 / 银行 / 医药 / 综合）；
 *   2. 拉实时快照与最近一期财报指标（股息率、PE、PB、派息率、负债率）；
 *   3. 按他的硬门槛过滤：股息率、估值、派息可持续、负债；
 *   4. 打分排序，取前 10，按行业限流，避免一整屏都是公路或银行。
 *
 * 这是一个「收息层」的粗筛，不替代 `framework.md` 的三因子逐项分析；
 * 结果每天落盘一份，历史不可变，便于回看当时的口径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from '../../data/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 每日结果落盘位置（运行期数据，git 忽略）。 */
export const STORE_FILE = path.join(HERE, '.data', 'picks.json');

/** 观察池：只放他框架里认的生意。银行/融资租赁整类排除——他明确说过「银行的表我看不清楚，
 *  负债看不清的一律不买」（BV16fH76GEoD @ 01:30:12）。地产、保险、博彩、周期股同样不进。 */
export const UNIVERSE = [
  { code: 'hk:00002', sector: '公用事业' },
  { code: 'hk:00003', sector: '公用事业' },
  { code: 'hk:00006', sector: '公用事业' },
  { code: 'hk:00836', sector: '公用事业' },
  { code: 'hk:02638', sector: '公用事业' },
  { code: 'hk:01038', sector: '公用事业' },
  { code: 'hk:00066', sector: '公用事业' },
  { code: 'hk:00270', sector: '公用事业' },
  { code: 'hk:00392', sector: '公用事业' },
  { code: 'hk:00941', sector: '电信' },
  { code: 'hk:00762', sector: '电信' },
  { code: 'hk:00728', sector: '电信' },
  { code: 'hk:00788', sector: '电信' },
  { code: 'hk:00107', sector: '收费公路' },
  { code: 'hk:00576', sector: '收费公路' },
  { code: 'hk:01052', sector: '收费公路' },
  { code: 'hk:00737', sector: '收费公路' },
  { code: 'hk:87001', sector: '收租/REIT' },
  { code: 'hk:00405', sector: '收租/REIT' },
  { code: 'hk:00778', sector: '收租/REIT' },
  { code: 'hk:00435', sector: '收租/REIT' },
  { code: 'hk:00291', sector: '消费' },
  { code: 'hk:00220', sector: '消费' },
  { code: 'hk:00322', sector: '消费' },
  { code: 'hk:01044', sector: '消费' },
  { code: 'hk:02319', sector: '消费' },
  { code: 'hk:00168', sector: '消费' },
  { code: 'hk:01929', sector: '消费' },
  { code: 'hk:01193', sector: '消费' },
  { code: 'hk:01099', sector: '医药' },
  { code: 'hk:00874', sector: '医药' },
  { code: 'hk:01066', sector: '医药' },
  { code: 'hk:00001', sector: '综合' },
  { code: 'hk:00019', sector: '综合' },
  { code: 'hk:00087', sector: '综合' },
];

/** 他的硬门槛；港股收息层比 A 股更苛刻一点。 */
export const THRESHOLDS = {
  minDividendYieldPct: 4.5,
  maxPe: 12,
  maxPayoutRatio: 0.95,
  maxDebtRatio: 75,
  picks: 10,
  maxPerSector: 3,
};

/** 港股收市、且当日财报已落地的时点之后才算「今天」。 */
const SHANGHAI = 'Asia/Shanghai';

/** 以香港日期为准的 YYYY-MM-DD。 */
export function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** 限幅。 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 数字或 null。 */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** 四舍五入到指定小数位；空值原样返回。 */
const round = (value, digits = 2) => (num(value) === null ? null : Number(value.toFixed(digits)));

/**
 * 给一只股票打分（0~100）。四项权重对应他的关注顺序：
 * 股息（40%）> 估值便宜（25%）> 资产折价（20%）> 派息留有余地（15%）。
 */
export function scoreCandidate(row) {
  const yieldScore = clamp(row.dividendYieldPct / 8, 0, 1);
  const peScore = clamp((THRESHOLDS.maxPe - row.pe) / (THRESHOLDS.maxPe - 3), 0, 1);
  const pbScore = clamp((1.5 - (row.pb ?? 1.5)) / 1.5, 0, 1);
  const payoutScore = clamp((THRESHOLDS.maxPayoutRatio - row.payoutRatio) / 0.65, 0, 1);
  return round((yieldScore * 0.4 + peScore * 0.25 + pbScore * 0.2 + payoutScore * 0.15) * 100, 1);
}

/**
 * 硬门槛。返回 null 表示通过，否则返回没过的原因。
 */
export function rejectionReason(row) {
  const t = THRESHOLDS;
  if (row.dividendYieldPct === null || row.dividendYieldPct < t.minDividendYieldPct) {
    return `股息率 ${row.dividendYieldPct ?? '缺'}% < ${t.minDividendYieldPct}%`;
  }
  if (row.pe === null || row.pe <= 0 || row.pe > t.maxPe) return `PE ${row.pe ?? '缺'} 不在 (0, ${t.maxPe}]`;
  if (row.payoutRatio === null || row.payoutRatio > t.maxPayoutRatio) {
    return `派息率 ${row.payoutRatio === null ? '缺' : Math.round(row.payoutRatio * 100) + '%'} > ${Math.round(t.maxPayoutRatio * 100)}%`;
  }
  if (row.debtRatio !== null && row.debtRatio > t.maxDebtRatio) {
    return `负债率 ${row.debtRatio}% > ${t.maxDebtRatio}%`;
  }
  return null;
}

/** 并发受限的 map。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 把一只股票的快照 + 最近一期财报拉成一行候选。 */
async function loadCandidate(item) {
  const [quote, fundamentals] = await Promise.all([
    get({ kind: 'quote', instrument: item.code }),
    get({ kind: 'fundamentals', instrument: item.code, options: { periods: 1 } }),
  ]);
  if (quote.ok !== true || quote.data === null) return { code: item.code, sector: item.sector, failed: '行情不可用' };
  const row = fundamentals.ok === true ? fundamentals.data?.rows?.[0] : undefined;
  if (row === undefined) return { code: item.code, sector: item.sector, failed: '没有财报指标' };

  const price = num(quote.data.price);
  const bps = num(row.bps);
  const pb = price !== null && bps !== null && bps > 0 ? price / bps : null;
  return {
    code: item.code,
    name: quote.data.name ?? item.code,
    sector: item.sector,
    price: round(price, 3),
    pe: round(num(quote.data.peTtm), 2),
    pb: round(pb, 2),
    totalCapYi: round(num(quote.data.totalCapYi), 1),
    dividendYieldPct: round(num(row.dividendYieldPct), 2),
    payoutRatio: round(num(row.payoutRatioSnapshot), 4),
    debtRatio: round(num(row.debtRatio), 1),
    roe: round(num(row.roe), 2),
    netProfitYi: round(num(row.netProfitYi), 2),
    netProfitYoY: round(num(row.netProfitYoY), 2),
    reportDate: row.reportDate ?? null,
  };
}

/**
 * 跑一次选股。
 * @returns `{ date, generatedAt, universe, quoted, passed, picks, rejected, failed }`
 */
export async function runSelection(now = new Date()) {
  const date = dateKey(now);
  const rows = await mapLimit(UNIVERSE, 6, loadCandidate);
  const failed = rows.filter((row) => row.failed !== undefined).map((row) => ({ code: row.code, reason: row.failed }));
  const candidates = rows.filter((row) => row.failed === undefined);

  const passed = [];
  const rejected = [];
  for (const row of candidates) {
    const reason = rejectionReason(row);
    if (reason === null) passed.push({ ...row, score: scoreCandidate(row) });
    else rejected.push({ code: row.code, name: row.name, reason });
  }

  passed.sort((a, b) => b.score - a.score || (b.dividendYieldPct ?? 0) - (a.dividendYieldPct ?? 0));
  const perSector = new Map();
  const picks = [];
  for (const row of passed) {
    if (picks.length >= THRESHOLDS.picks) break;
    const used = perSector.get(row.sector) ?? 0;
    if (used >= THRESHOLDS.maxPerSector) continue;
    perSector.set(row.sector, used + 1);
    picks.push({
      rank: picks.length + 1,
      ...row,
      score: row.score,
      reason: `股息 ${row.dividendYieldPct}% · PE ${row.pe} · PB ${row.pb ?? '—'} · 派息 ${row.payoutRatio === null ? '—' : Math.round(row.payoutRatio * 100) + '%'} · ${row.sector}`,
    });
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    universe: UNIVERSE.length,
    quoted: candidates.length,
    passed: passed.length,
    picks,
    rejected: rejected.slice(0, 20),
    failed,
  };
}

/* ------------------------------------------------------------------ */
/*                              存储层                                 */
/* ------------------------------------------------------------------ */

/** 读整份历史；坏文件按空处理，不让看板白屏。 */
export function readStore(file = STORE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.runs === 'object') return parsed;
  } catch {
    /* 首次运行或文件损坏 */
  }
  return { version: 1, runs: {} };
}

/** 原子写回。 */
export function writeStore(store, file = STORE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** 历史摘要：最近 N 天，最新在前。 */
export function listDays(store, limit = 60) {
  return Object.values(store.runs ?? {})
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit)
    .map((run) => ({
      date: run.date,
      generatedAt: run.generatedAt,
      count: Array.isArray(run.picks) ? run.picks.length : 0,
      top: Array.isArray(run.picks) ? run.picks.slice(0, 3).map((pick) => pick.name) : [],
      avgYield:
        Array.isArray(run.picks) && run.picks.length > 0
          ? round(
              run.picks.reduce((sum, pick) => sum + (num(pick.dividendYieldPct) ?? 0), 0) / run.picks.length,
              2,
            )
          : null,
    }));
}
