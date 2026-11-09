# 运维手册

## 日常

```powershell
cd .dsh/skills/fin-data
uv run fin-data status --json          # stale?
uv run fin-data update                 # 只追加缺失交易日；重复执行 = no-op
uv run fin-data verify                 # 结构检查，写 quality/report-latest.json
```

提交：

```powershell
cd ../../..                            # 仓库根
git add .dsh/skills/fin-data/data
git commit -m "data(fin-data): 2026-11-10"
git push
```

只提交 `data/` 下 `manifest.json`、`calendar/`、`instruments.json`、`universes/`、
`daily/`、`quality/`；`data/local/` 与 `.venv/` 已被忽略。

## 首次 / 重建

```powershell
uv sync --extra update
uv run fin-data build-universe sse50        # 指数成分换样本后
uv run fin-data sync --universe sse50 --full --since 2016-01-01
```

## 修复

某只票某段数据错误：

```powershell
uv run fin-data sync --universe sse50 --symbols 600519.SH --full --since 2026-10-01
```

`--full` 会从指定日期重新抓取；写入端只追加更新（重复日期自动跳过），
若需覆盖旧行则手工调用 `store.rewrite_bars`（会重写该票整个文件，git diff 可见）。

## 失败语义

| 现象 | 处理 |
| --- | --- |
| 今天 15:30 前更新 | `latest_closed` 回退到上一交易日，不会写未收盘的当日行 |
| 全部源失败 | 不写、不动旧数据，退出码 2，列出标的与错误码 |
| 单只失败 | 其余照常写入；`quality/report-latest.json` 记录 `failedSymbols` |
| 数据源当日未出 | 抓不到当日行 → 本次 no-op，稍后重试 |
| 非交易日 / 节假日 | 自动 no-op |

## 扩展

- 增加标的：写进对应 universe（或 `sync --symbols`），运行 `sync --full`。
- 扩大种子集（沪深300/中证500）：新增 `build-universe csi300`（M2），
  再按需 `sync`；注意仓库体积（约 150MB/807 只）。
- 全市场：只写入 `data/local/`（gitignore），不要提交。
