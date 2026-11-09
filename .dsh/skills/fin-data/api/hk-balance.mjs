/**
 * 港股资产负债表（净现金口径），`financials` 的港股补充项。
 *
 * 这段逻辑原本在金融看板里（`picks.js` 自己拉东财 RPT_HKF10_FN_BALANCE），
 * 现在收进 fin-data：看板只要读 `period.balance.netCash`，不再自己拼财报字段。
 *
 * 口径（与 `framework.md` 的「负债看得清」一致）：
 *   净现金 = 现金及等价物 + 短期存款 + 中长期存款
 *          − 短期贷款 − 长期贷款 − 应付票据(非流动) − 融资租赁负债
 * 报表单位是元；季报没有明细时回退到最近一份带明细的报告期。
 */

const BALANCE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';

/** 一次进程内缓存：同一标的只打一次上游。 */
const cache = new Map();

/** 报表行里用 STD_ITEM_CODE 定位；金额单位 = 元。 */
const ITEM_CODES = {
  cash: '004002010',
  shortDeposit: '004002011',
  longDeposit: '004001030',
  shortLoan: '004011010',
  longLoan: '004020001',
  notesPayable: '004020018',
  leaseShort: '004011006',
  leaseLong: '004020005',
};

/**
 * 解析东财港股资产负债表行。
 * @param {Array<object>} rows - raw response rows.
 * @returns {{reportDate: string, cash: number, interestDebt: number, netCash: number}|null}
 */
export function parseHkBalanceRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const periods = [...new Set(rows.map((row) => String(row.REPORT_DATE)))].sort().reverse();
  for (const period of periods) {
    const current = rows.filter((row) => String(row.REPORT_DATE) === period);
    const amount = (key) => {
      const hit = current.find((row) => String(row.STD_ITEM_CODE) === ITEM_CODES[key]);
      const value = Number(hit?.AMOUNT);
      return Number.isFinite(value) ? value : null;
    };
    const cash = amount('cash');
    const shortLoan = amount('shortLoan');
    const longLoan = amount('longLoan');
    const notes = amount('notesPayable');
    // 没有明细的汇总季报直接跳过，往前找第一份带现金/借款明细的报表。
    if (cash === null || (shortLoan === null && longLoan === null && notes === null)) continue;
    const lease = (amount('leaseShort') ?? 0) + (amount('leaseLong') ?? 0);
    const interestDebt = (shortLoan ?? 0) + (longLoan ?? 0) + (notes ?? 0) + lease;
    const netCash = cash + (amount('shortDeposit') ?? 0) + (amount('longDeposit') ?? 0) - interestDebt;
    return {
      reportDate: period.slice(0, 10),
      cash,
      interestDebt,
      netCash: Number(netCash.toFixed(0)),
    };
  }
  return null;
}

/**
 * 拉一只港股的资产负债表摘要。
 * @param {object} instrument - canonical instrument (`market === 'hk'`).
 * @returns {Promise<object|null>} `null` 表示上游没给可用明细——不猜。
 */
export async function fetchHkBalance(instrument) {
  if (instrument?.market !== 'hk') return null;
  const secu = `${instrument.code}.HK`;
  if (cache.has(secu)) return cache.get(secu);

  const query = new URLSearchParams({
    reportName: 'RPT_HKF10_FN_BALANCE',
    columns: 'ALL',
    filter: `(SECUCODE="${secu}")`,
    pageSize: '400',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
  });

  let result = null;
  try {
    const response = await fetch(`${BALANCE_URL}?${query.toString()}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (response.ok) {
      const body = await response.json();
      result = parseHkBalanceRows(body?.result?.data);
    }
  } catch {
    result = null;
  }
  cache.set(secu, result);
  return result;
}

/** 测试用：清掉进程内缓存。 */
export function clearHkBalanceCache() {
  cache.clear();
}
