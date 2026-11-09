# fin-data 统一查询入口（`fin-data.query/v1`）

9c 与金融看板**只从这里取数**。这一个入口负责：路由到哪个数据源、要不要回落、缓存多久、
数据截至哪天、是真实还是模拟、来源是谁。消费方不再各自拼请求、各自记来源。

```
消费方                         入口                                 实现
──────────────────────────    ────────────────────────────────    ────────────────────────────────
9c  .dsh/skills/9c/scripts/stock-data.mjs ─┐
金融看板 index.js / picks.js  ───┼─▶ skills/fin-data/api/index.mjs ─┬─▶ financials.mjs（真实指标 + 模拟财报）
agent / shell（CLI）          ───┘   （query / queryMany / describe）├─▶ universe.mjs（sse50 / 港股通）
                                                                    ├─▶ bars-local.mjs（本仓 CSV，不复权）
                                                                    └─▶ .dsh/skills/fin-data/adapter/（腾讯/东财适配器，内部实现）
```

`.dsh/skills/fin-data/adapter/` 仍然是真实上游的适配器，但它**只允许被 fin-data 引用**；谁要行情、财报、汇率，
一律走本入口。

## 1. 怎么调

```js
import { query, queryMany } from '../../skills/fin-data/api/index.mjs';

const quote = await query({ kind: 'quote', instrument: '600519' });

const financials = await query({
  kind: 'financials',
  instrument: 'hk:00700',
  options: { periods: 4, source: 'auto' },   // auto | real | mock
});

const watchlist = await queryMany({ kind: 'quote', instruments: ['sh600519', 'sz000001', 'hk:00700'] });
```

命令行（同一个门面，给 agent / 非 JS 消费方）：

```powershell
node .dsh/skills/fin-data/api/cli.mjs describe
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --periods 4
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --source mock
node .dsh/skills/fin-data/api/cli.mjs query --kind bars --code 600519 --source local --limit 120
node .dsh/skills/fin-data/api/cli.mjs status
```

退出码：`0` = `ok: true`；`2` = 信封 `ok: false`；`1` = 请求写错或异常。

## 2. 请求与信封

请求：

| 字段 | 说明 |
| --- | --- |
| `kind` | 见下表，必填 |
| `instrument` | 标的，支持 `600519` / `sh600519` / `cn:601318` / `600519.SH` / `hk:02318` / `00700` |
| `query` | 仅 `search` 用：名称或拼音 |
| `pair` | 仅 `fx` 用：`HKDCNY` 这类六位货币对 |
| `options` | 见每个 kind 的选项 |

返回：

```json
{
  "schema": "fin-data.query/v1",
  "ok": true,
  "kind": "financials",
  "instrument": "cn:sh600519",
  "data": { },
  "meta": {
    "source": "eastmoney",
    "fetchedAt": "2026-11-09T09:33:33.456Z",
    "asOf": "2026-09-30",
    "cached": false,
    "stale": false,
    "mock": false,
    "ttlMs": 21600000,
    "degraded": []
  },
  "warnings": []
}
```

| 字段 | 含义 |
| --- | --- |
| `meta.source` | 谁给的数：`tencent` / `eastmoney` / `eastmoney:b:DLMK0144` / `fin-data/csv` / `fin-data/manifest` / `data/universes/*.json` / `mock` |
| `meta.asOf` | 数据本身的时点（行情时间戳 / 最后一根 K 线 / 最新报告期），回答里必须引用 |
| `meta.fetchedAt` | 本次取数的时刻 |
| `meta.stale` | 上游失败后退回旧缓存时为 `true` |
| `meta.mock` | 数据是模拟的（当前只有 `financials` 会出现） |
| `meta.degraded` | 逐个适配器的失败原因 |
| `warnings` | 给人看的口径说明（复权、币种、模拟数据等） |

**错误语义**（有意区分两类）：

- 请求写错（未知 `kind`、缺 `instrument`、非法标的、非法 `options.source`）→ **抛 `QueryError`**，
  带 `code`（`invalid_request` / `unknown_kind`），这是程序 bug，不要静默；
- 数据取不到（上游挂了、该市场没有这个数据）→ 返回 `ok: false`、`data: null`，
  消费方按降级处理，**永远不编数字**。

## 3. kind 一览

| kind | 数据 | 默认来源 | 选项 |
| --- | --- | --- | --- |
| `status` | 数据集覆盖率、最新交易日、适配器清单 | `data/manifest.json` + 交易日历 | — |
| `quote` | 实时快照（价格、涨跌幅、PE、市值…） | 腾讯 → iFinD | — |
| `bars` | 日线 `[date, open, close, high, low, volume]` | `source=live` 时腾讯（前复权） | `source: live\|local\|auto`、`limit`、`start`、`end` |
| `financials` | 财报（三大表关键项 + 指标） | 东财 F10 → 模拟 | `periods`（1~8，默认 4）、`source: auto\|real\|mock`、`balance` |
| `dividends` | 分红明细 | 东财 / 港交所公告解析 | `limit` |
| `annual` | 年报关键项 | 东财 F10 | `years` |
| `universe` | 标的集合（sse50 / hk-connect） | 本地 `data/universes/` / 东财板块 | `id`（必填） |
| `fx` | 汇率快照 | 腾讯 | `pair` |
| `search` | 名称 → 代码 | 腾讯 smartbox | `query` |
| `announcements` | 公告列表 | 东财 | `limit` |

`queryMany({ kind: 'quote', instruments })` 会走批量接口（一次上游请求覆盖整个自选股），
其他 kind 并发逐只查询。

`status` 的 `data.stale` 和信封里的 `meta.stale` 不是一回事：前者是「本地日线落后最新收盘
（该跑 `fin-data update`）」，后者是「这次取数用了过期缓存（上游失败兜底）」。

### `bars` 的两种口径（重要）

- `source: 'live'`（默认）：腾讯日线，**前复权**，含当日；`meta.adjust = 'qfq'`；
- `source: 'local'`：读 fin-data 落盘的 CSV，**不复权**、只到 `fin-data update` 的最后一根；
  `meta.adjust = 'none'`、`meta.source = 'fin-data/csv'`；没有本地文件时返回 `ok: false`
  （`not_found`），不会偷偷改成实时源；
- `source: 'auto'`：有本地文件用本地，没有才走实时。

用本地序列做回测/画图时，回答里必须说明「不复权」。

### `universe`：标的集合

```js
await query({ kind: 'universe', options: { id: 'sse50' } });       // data/universes/sse50.json，离线
await query({ kind: 'universe', options: { id: 'hk-connect' } });  // 东财港股通板块，入口内按自然日缓存
```

返回 `{ id, asOf, source, members: [{ symbol, code, name, kind }], count }`。
港股通拿不到时返回 `ok: false`（不编名单），消费方自己决定「不过滤」还是报错——
看板选股就是拿不到时不过滤。缺 `options.id` 或 `id` 未知属于请求错误（抛 `QueryError`）。

## 4. `financials`：财报接口

金额单位统一为**元**；比率为百分数（`roe`、`netMargin`、`debtRatio`、`revenueYoY`…）
或 0~1 小数（`payoutRatio`）。报告期按 `reportDate` 倒序。

```json
{
  "symbol": "600519.SH",
  "market": "cn",
  "currency": "CNY",
  "unit": "元",
  "mock": false,
  "disclaimer": null,
  "periods": [
    {
      "reportDate": "2026-09-30",
      "reportName": "2026三季报",
      "fiscalYear": 2026,
      "periodType": "Q3",
      "noticeDate": "2026-10-31",
      "currency": "CNY",
      "income": {
        "revenue": 133284000000,
        "operatingProfit": null,
        "netProfit": 64467000000,
        "deductNetProfit": 64325000000,
        "eps": 51.53,
        "netMargin": 50.94,
        "revenueYoY": 1.82,
        "netProfitYoY": -0.25,
        "deductNetProfitYoY": -0.31
      },
      "balance": {
        "totalAssets": 318305000000,
        "totalLiabilities": 38177000000,
        "equity": 280128000000,
        "bps": 216.95,
        "debtRatio": 11.9,
        "cash": null,
        "interestDebt": null,
        "netCash": null
      },
      "cashflow": {
        "ocf": 84059000000,
        "icf": 25825000000,
        "fcf": 109884000000,
        "investCash": 25825000000,
        "finCash": -40316000000,
        "ocfPerShare": 67.2428
      },
      "ratios": {
        "roe": 24.47,
        "netMargin": 50.94,
        "debtRatio": 11.9,
        "interestDebtRatio": 5.51,
        "dividendYieldPct": null,
        "payoutRatio": null,
        "dividendPerShare": null
      },
      "shares": { "totalShares": 1250081601 },
      "source": "eastmoney",
      "mock": false
    }
  ]
}
```

字段口径：

| 字段 | 说明 |
| --- | --- |
| `periodType` | `Q1`（一季报）/ `H1`（半年报）/ `Q3`（三季报）/ `FY`（年报） |
| `income.*` | 利润表；A 股 `operatingProfit` 东财指标表没有该列，给 `null`，不用净利润倒推 |
| `balance.totalLiabilities` | 由 `totalAssets − equity` 推得，与源口径一致 |
| `balance.cash` / `interestDebt` / `netCash` | 目前只有港股（资产负债表明细）有；A 股为 `null` |
| `cashflow.fcf` | `ocf + icf`，是代理值，不是审计口径的自由现金流 |
| `ratios.payoutRatio` / `dividendPerShare` | 港股来自 F10 快照（`DIVI_RATIO` / `DPS_HKD`） |
| `source` / `mock` | 每个报告期各自标注，混源时不会「一处模拟、全篇真实」 |

需要的旧「指标行」形状（`netProfitYi` 等）不必自己换算：

```js
import { toMetricRow } from '../../skills/fin-data/api/index.mjs';
const row = toMetricRow(period);   // revenueYi / netProfitYi / ocfYi / netCashYi ...
```

### 模拟财报（现阶段）

真实财报源（完整三表）尚未接入，接口先固定形状。规则：

- `source: 'auto'`（默认）：先取真实指标，**取不到才回落模拟**，并在 `warnings` 里写原因；
- `source: 'real'`：只认真实数据，取不到就是 `ok: false`；
- `source: 'mock'`：直接用模拟数据，便于联调与演示。

模拟数据由 `mock-financials.mjs` 生成：同一标的 + 同一报告期**永远一致**（seed 可复现），
资产负债表/利润表/现金流量表内部自洽（`fcf = ocf + icf`、`eps = 净利润 / 总股本`），
每个报告期带 `mock: true`，响应带 `disclaimer`。**模拟数据不得当作真实经营数据引用。**

## 5. 依赖与安装

- 入口依赖同目录的 `../adapter/`（底层适配器）与 fin-data 自己的 `data/`（日线 CSV），两者都在 fin-data 技能目录内部，
  不再有与 `skills/` 同级的共享目录。
- 金融看板通过 `../../skills/fin-data/api/index.mjs` 引用；9c 的 `stock-data.mjs` 位于
  `.dsh/skills/9c/scripts/`，通过 `../../fin-data/api/index.mjs` 引用。
- **装 9c 或看板时，fin-data 必须一起在位**；方向是单向的：消费方 → fin-data → `adapter/`。

## 6. 测试

```powershell
node --test .dsh/skills/fin-data/api/test/query.test.mjs    # 离线契约：10 项
node --test .dsh/skills/fin-data/adapter/test/contract.test.mjs                # 底层适配器 fixtures
node .dsh/skills/9c/scripts/stock-data.mjs all 中国平安                # 9c 取数（需要网络）
node .dsh/plugins/financial-dashboard/scripts/test-route.mjs # 看板行情路由（需要网络）
```
