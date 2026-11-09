# fin-data

A 股日线数据仓库 + 取数 skill：一个标的（股票/指数）一个 CSV，只追加，随 `dshworkspace` 仓库分发。

- 数据：不复权日线（`date,symbol,open,high,low,close,volume,amount,turnover,src`），`data/daily/cn/<exchange|index>/<code>.csv`
- 取数链：`akshare → adata → iFinD(仅校验) → 网页直连`，逐标的失败降级
- 增量：`update` 只追加缺失交易日；`get` 单票读取一个文件

安装与使用见下方；字段与目录约定见 `references/schema.md`。

## 安装

```powershell
# 在本仓库中（推荐 link 模式，修改即时生效）
node .dsh/scripts/install-skills.mjs --root "$env:USERPROFILE\.dsh\skills" --mode link --skills fin-data

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
