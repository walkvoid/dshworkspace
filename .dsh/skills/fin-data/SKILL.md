---
name: fin-data
description: A 股日线行情数据（本地 CSV，一标的一文件，不复权）。当用户要查某只 A 股/指数的历史日线、区间涨跌幅、画 K 线、做回测、导出历史行情，或问“本地行情数据是否最新 / 怎么更新数据”时使用。数据由 akshare → adata → iFinD(仅校验) → 网页直连 的降级链抓取并落盘；回答必须注明数据截至日与来源，不得编造价格。
---

# fin-data：A 股日线本地数据

**这不是实时行情工具。** 实时盘口/最新价请用 `.dsh/data/`（腾讯/同花顺）那条链路；本技能只负责**历史日线**：可离线查询、可增量更新、随仓库分发。

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

## 维护（改数据后）

```powershell
uv run fin-data update && uv run fin-data verify
git add .dsh/skills/fin-data/data && git commit -m "data(fin-data): <日期>"
# push 手动执行
```

数据来源为公开接口，仅供个人研究；行情版权归交易所与数据商，勿作商业分发。
