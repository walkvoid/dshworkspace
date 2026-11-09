# fin-data

A 股日线数据仓库 + 统一取数 skill：一个标的（股票/指数）一个 CSV，只追加，随 `dshworkspace` 仓库分发；
同时作为 9c 与金融看板的**唯一取数入口**（行情 / 财报 / 分红 / 汇率 / 数据状态）。

- 数据：不复权日线（`date,symbol,open,high,low,close,volume,amount,turnover,src`），`data/daily/cn/<exchange|index>/<code>.csv`
- 取数链：`akshare → adata → iFinD(仅校验) → 网页直连`，逐标的失败降级
- 增量：`update` 只追加缺失交易日；`get` 单票读取一个文件
- 统一入口：`api/index.mjs`（JS 门面）+ `api/cli.mjs`（命令行），契约见 [`api/README.md`](./api/README.md)

安装与使用见下方；字段与目录约定见 `references/schema.md`。

## 统一查询入口

```js
import { query, queryMany } from '<fin-data>/api/index.mjs';

await query({ kind: 'quote', instrument: '600519' });
await query({ kind: 'financials', instrument: 'hk:00700', options: { periods: 4 } });
await queryMany({ kind: 'quote', instruments: ['sh600519', 'sz000001'] });
```

```powershell
node api/cli.mjs status
node api/cli.mjs query --kind financials --code 600519 --periods 4
node api/cli.mjs query --kind financials --code 600519 --source mock   # 强制模拟
node api/cli.mjs query --kind bars --code 600519 --source local --limit 120
```

- kind：`status` / `quote` / `bars` / `financials` / `dividends` / `annual` / `universe` / `fx` / `search` / `announcements`；
- 财报（`financials`）：真实指标优先，取不到回落**模拟数据**（`meta.mock: true`）；`source` 可取 `auto`/`real`/`mock`；
- `bars` 默认实时源（前复权）；`source: 'local'` 读本仓 CSV（不复权，`meta.adjust = 'none'`）；
- `.dsh/skills/fin-data/adapter/` 只是入口的内部适配器，消费方不要直接引用。

## 安装

```powershell
# 在本仓库中（推荐 link 模式，修改即时生效）
node .dsh/skills/install-skills.mjs --root "$env:USERPROFILE\.dsh\skills" --mode link --skills fin-data

# 依赖（Python 3.11）
cd .dsh/skills/fin-data
uv sync --extra update
```

## 常用命令

```powershell
uv run fin-data status                       # 数据是否最新
uv run fin-data update                       # 增量更新
uv run fin-data get 600519.SH --start 2026-01-01 --format json
uv run fin-data sync --universe sse50 --full # 首次/重建
uv run fin-data verify
uv run fin-data list-universe
```

## 数据更新后提交

```powershell
git add .dsh/skills/fin-data/data
git commit -m "data(fin-data): 2026-11-10"
git push
```

## 数据来源与免责声明

数据来自公开接口（akshare/adata/东方财富/腾讯），仅供个人研究学习，不构成任何投资建议；
行情数据的版权归交易所与数据提供方所有，请勿用于商业分发。iFinD 数据仅本地校验，不入库。
