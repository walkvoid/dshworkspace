/**
 * 龟龟选股：把「史诗级韭菜」的收息框架落成一套可复算的港股筛选。
 *
 * 只做四件事：
 *   1. 固定一个「非周期、看得懂负债」的港股观察池（公用 / 电信 / 公路 / 收租 / 消费 / 医药 / 综合），
 *      只保留港股通标的；银行、融资租赁、地产、保险、博彩一律不进；
 *   2. 拉实时快照与最近一期财报（股息率、PE、PB、派息率、负债率、市值、净现金）；
 *   3. 按他的硬门槛过滤：股息率、估值、派息可持续、负债；算穿透回报率做展示；
 *   4. 打分排序，取前 10，按行业限流，避免一整屏都是公路。
 *
 * 取数**只经过 fin-data 的统一入口**（`../../skills/fin-data/api/index.mjs`）：
 * 行情（`quote`）、财报（`financials`）、汇率（`fx`）、港股通名单（`universe`）都在那里归一；
 * 本文件只做选股口径与打分，不再直接访问任何上游接口。
 * 财报如果回落到模拟数据，行上带 `mock: true`，榜单据此标注，不冒充实数。
 *
 * 这是一个「收息层」的粗筛，不替代 `framework.md` 的三因子逐项分析；
 * 结果每天落盘一份，历史不可变，便于回看当时的口径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, toMetricRow } from '../../skills/fin-data/api/index.mjs';

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

/**
 * 港股通名单：走 fin-data 的 `universe` 接口（东财板块，入口内按自然日缓存）。
 * @returns 代码集合；拿不到时返回 null，调用方选择不过滤而不是把榜单清空。
 */
export async function loadConnectCodes() {
  const result = await query({ kind: 'universe', options: { id: 'hk-connect' } });
  if (result.ok !== true) return null;
  const codes = new Set((result.data?.members ?? []).map((member) => member.code));
  return codes.size > 0 ? codes : null;
}

/** 把一只股票的快照 + 最近一期财报拉成一行候选。 */
async function loadCandidate(item, fxRate) {
  const [quote, financials] = await Promise.all([
    query({ kind: 'quote', instrument: item.code }),
    query({ kind: 'financials', instrument: item.code, options: { periods: 1 } }),
  ]);
  if (quote.ok !== true || quote.data === null) return { code: item.code, sector: item.sector, failed: '行情不可用' };
  const period = financials.ok === true ? financials.data?.periods?.[0] : undefined;
  if (period === undefined) return { code: item.code, sector: item.sector, failed: '没有财报指标' };

  // fin-data 的财报是三大表形状；选股口径继续用亿元指标行，换算只在 fin-data 里做一次。
  const row = toMetricRow(period);
  const price = num(quote.data.price);
  const bps = num(row.bps);
  const pb = price !== null && bps !== null && bps > 0 ? price / bps : null;
  const totalCapYi = num(quote.data.totalCapYi);
  const netProfitYi = num(row.netProfitYi);
  const payoutRatio = num(row.payoutRatioSnapshot);
  const netCashYi = num(row.netCashYi);
  // 港股报表多为人民币、市值按港币计：有汇率才给穿透回报率，币种不明宁缺勿错。
  const penetrationReturn =
    fxRate !== null && totalCapYi !== null && totalCapYi > 0 && netProfitYi !== null && payoutRatio !== null
      ? round((netProfitYi * payoutRatio) / (totalCapYi * fxRate), 4)
      : null;
  return {
    code: item.code,
    name: quote.data.name ?? item.code,
    sector: item.sector,
    price: round(price, 3),
    pe: round(num(quote.data.peTtm), 2),
    pb: round(pb, 2),
    totalCapYi: round(totalCapYi, 1),
    netCashYi: round(netCashYi, 1),
    penetrationReturn,
    dividendYieldPct: round(num(row.dividendYieldPct), 2),
    payoutRatio: round(payoutRatio, 4),
    debtRatio: round(num(row.debtRatio), 1),
    roe: round(num(row.roe), 2),
    netProfitYi: round(netProfitYi, 2),
    netProfitYoY: round(num(row.netProfitYoY), 2),
    reportDate: row.reportDate ?? null,
    // 财报来源要跟着行走：模拟数据不能在榜单里冒充实数。
    financialsSource: period.source ?? null,
    mock: period.mock === true,
  };
}

/**
 * 跑一次选股。
 * @returns `{ date, generatedAt, universe, quoted, passed, picks, rejected, failed }`
 */
export async function runSelection(now = new Date()) {
  const date = dateKey(now);
  const [connect, fx] = await Promise.all([loadConnectCodes(), query({ kind: 'fx', pair: 'HKDCNY' })]);
  const fxRate = fx.ok === true ? num(fx.data?.rate) : null;
  const universe =
    connect === null ? UNIVERSE : UNIVERSE.filter((item) => connect.has(item.code.replace(/^hk:/, '')));
  const rows = await mapLimit(universe, 6, (item) => loadCandidate(item, fxRate));
  const failed = rows.filter((row) => row.failed !== undefined).map((row) => ({ code: row.code, reason: row.failed }));
  const candidates = rows.filter((row) => row.failed === undefined);
  const mockFinancials = candidates.filter((row) => row.mock === true).length;

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
    universe: universe.length,
    connectListed: connect === null ? null : connect.size,
    connectFiltered: UNIVERSE.length - universe.length,
    fxRate,
    quoted: candidates.length,
    passed: passed.length,
    // 财报来源：全是真实值时是 eastmoney；有回落就标出来，前端与历史记录都能看出这一天是不是模拟数据。
    financialsSource:
      mockFinancials === 0 ? 'eastmoney' : mockFinancials === candidates.length ? 'mock' : 'mixed',
    mockFinancials,
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
