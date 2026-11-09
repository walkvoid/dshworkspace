---
name: fin-data
description: A 股日线行情数据（本地 CSV，一标的一文件，不复权）+ 统一取数入口（行情/财报/分红/汇率）。当用户要查某只 A 股/指数的历史日线、区间涨跌幅、画 K 线、做回测、导出历史行情，或问“本地行情数据是否最新 / 怎么更新数据”时使用；9c 与金融看板也通过这里取数。数据由 akshare → adata → iFinD(仅校验) → 网页直连 的降级链抓取并落盘；回答必须注明数据截至日与来源，不得编造价格。
---

# fin-data：A 股日线与统一取数入口

**这不是实时行情工具。** 实时盘口/最新价请用 `api/` 入口的 `quote`（腾讯/同花顺链路）；
本技能负责两件事：

1. **历史日线**：可离线查询、可增量更新、随仓库分发；
2. **统一取数入口**：9c、金融看板等消费方只从这里拿数据（行情、财报、分红、汇率、状态）。

## 统一查询入口（消费方唯一依赖的接口）

入口：`api/index.mjs`（JS 门面）与 `api/cli.mjs`（同一个门面的命令行外壳），
契约见 [`api/README.md`](./api/README.md)，版本 `fin-data.query/v1`。

```js
import { query, queryMany } from '<fin-data>/api/index.mjs';

await query({ kind: 'quote', instrument: '600519' });
await query({ kind: 'financials', instrument: 'hk:00700', options: { periods: 4 } });
await query({ kind: 'bars', instrument: '600519', options: { source: 'local', limit: 120 } });
await queryMany({ kind: 'quote', instruments: ['sh600519', 'sz000001', 'hk:00700'] });
```

```powershell
node .dsh/skills/fin-data/api/cli.mjs status
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --periods 4
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --source mock
```

- `kind`：`status` / `quote` / `bars` / `financials` / `dividends` / `annual` / `universe` / `fx` / `search` / `announcements`；
- 每个返回都带 `meta.source` / `meta.asOf` / `meta.fetchedAt` / `meta.stale` / `meta.mock`，
  回答里引用 `asOf` 与来源，不许引用记忆中的数字；
- **财报（`financials`）**：真实指标优先，取不到回落**模拟数据**（`meta.mock: true`）；
  `options.source` 可取 `auto`（默认）/ `real` / `mock`。模拟数据只用于联调，不能当真实经营数据；
- `bars` 默认走实时源（前复权）；`source: 'local'` 读本技能落盘的 CSV（**不复权**），
  `meta.adjust` 会写明 `none`；
- `.dsh/data/` 是入口的内部适配器，**消费方不得直接引用**。

## 数据在哪

```
.dsh/skills/fin-data/data/
├── manifest.json              # 覆盖率、行数、最新交易日
├── calendar/trade-dates.json  # 交易日历
├── instruments.json           # 代码 → 名称/类型
├── universes/sse50.json       # 种子集：上证50（含指数 000016.SH）
├── daily/cn/sh/600519.csv     # 一标的一文件，只追加
└── quality/report-latest.json # 数据体检结果
```

CSV 列：`date,symbol,open,high,low,close,volume,amount,turnover,src`
（价格=元、volume=股、amount=元、turnover=%，`src` 为来源短码 `ak`/`ad`/`web`）

## 标准流程（严格按此顺序）

1. **先看状态**：`uv run fin-data status --json`
   - `stale=false` 直接用；`stale=true` 且当前已收盘 → 第 2 步更新。
2. **更新（需要时）**：`uv run fin-data update`
   - 失败或超时：不要编数据，如实告诉用户"数据截至 X，更新失败"。
3. **取数**：`uv run fin-data get 600519.SH --start 2026-01-01 --format json`
4. **回答**：必须带「截至 `asOf`、来源 `sources`、口径 = 不复权」；画图/回测时说明未做复权。

查询不在种子集里的标的：`get` 会自动按链路拉取一次（写入 `data/local/`，不入库）；失败则明确说"本地无此数据且拉取失败"。

## 命令

```powershell
uv run fin-data status                 # 人类可读；加 --json 给 agent
uv run fin-data update                 # 增量（幂等，重复跑 = no-op）
uv run fin-data get 000016.SH --start 2016-01-01 --format csv
uv run fin-data verify                 # 结构检查，写质量报告
uv run fin-data sync --universe sse50 --full   # 重建种子集
uv run fin-data build-universe sse50   # 指数成分换样本后重建
uv run fin-data list-universe sse50

# 统一查询入口（行情/财报/分红/汇率；9c 与看板走同一条）
node .dsh/skills/fin-data/api/cli.mjs status
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --periods 4
node .dsh/skills/fin-data/api/cli.mjs query --kind bars --code 600519 --source local --limit 120
```

## 数据源链

`akshare → adata → iFinD(仅抽样校验，不写主数据) → 东方财富/腾讯网页直连`。
逐标的降级：某只票在某源失败就换下一个，不影响整批。行内 `src` 可追溯。

## 硬规则

1. **不得编造价格/成交量**。数据缺失就说缺失，并给出 `status` 的截止日。
2. 每次回答都要引用 `asOf` 与来源；不要引用"记忆中的价格"。
3. 复权：当前只存**不复权**；前/后复权在 M2 之后提供，届时必须显式说明口径。
4. 停牌/退市/新股可能导致某些交易日没有行，这是正常现象；不要用相邻日填充。
5. iFinD 数据只用于本地校验，不写入公开数据文件。
6. **模拟财报必须标注**：`financials` 的 `meta.mock = true` 时，说明"财报为模拟数据，
   仅用于联调接口"，不得当作真实经营数据下结论。
7. **消费方只走 `api/`**：9c、金融看板及任何脚本都不得直接 `import` `.dsh/data/`；
   换源、加缓存、接真实财报都只改 fin-data 内部。

## 维护（改数据后）

```powershell
uv run fin-data update && uv run fin-data verify
node --test .dsh/skills/fin-data/api/test/query.test.mjs   # 入口契约（离线）
git add .dsh/skills/fin-data/data && git commit -m "data(fin-data): <日期>"
# push 手动执行
```

数据来源为公开接口，仅供个人研究；行情版权归交易所与数据商，勿作商业分发。
