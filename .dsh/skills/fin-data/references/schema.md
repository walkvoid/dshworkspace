# 数据格式（schema）

## 目录

```
data/
├── manifest.json                 # 覆盖率 / 行数 / 最新交易日 / 来源统计
├── calendar/trade-dates.json     # 交易日历（含未来已公布日期）
├── instruments.json              # symbol → code/exchange/kind/name
├── universes/<name>.json         # 种子集成员快照（含 asOf）
├── daily/cn/<ex|index>/<code>.csv
├── quality/report-latest.json
└── local/                        # 非种子标的缓存（gitignore）
```

## 日线 CSV

```csv
date,symbol,open,high,low,close,volume,amount,turnover,src
2026-11-06,600519.SH,1450.00,1457.72,1436.00,1453.00,4284800,6199528289.00,0.34,ak
```

| 列 | 类型 | 单位/格式 | 说明 |
| --- | --- | --- | --- |
| date | string | `YYYY-MM-DD` | 交易日（Asia/Shanghai） |
| symbol | string | `代码.交易所` | `600519.SH`、`000001.SZ`、`920992.BJ`、指数 `000016.SH` |
| open/high/low/close | decimal | 元，2 位小数 | **不复权原始价** |
| volume | integer | 股 | 源给「手」×100 |
| amount | decimal | 元 | 成交额，缺失为空串 |
| turnover | decimal | % | 换手率，缺失为空串 |
| src | string | `ak`/`ad`/`web` | 来源短码；`if` 预留（iFinD 不入库） |

约定：

- 一标的一文件；文件内 `date` 严格递增，只追加。
- 缺值写空串，不写 0/NaN。
- 价格 2 位小数、成交额 2 位小数、成交量整数。
- 指数文件在 `daily/cn/index/`，避免 `000001.SH`（上证综指）与 `000001.SZ`（平安银行）冲突。

## manifest 关键字段

| 字段 | 含义 |
| --- | --- |
| coverage | 全库最早/最晚交易日 |
| lastTradeDate | 已入库的最新交易日（`update` 据此判断增量） |
| symbolCount / rowCount | 文件数 / 总行数 |
| byExchange | sh/sz/bj/index 分组的文件数与行数 |
| sources | 按 `src` 统计的行数 |

## 复权（M2）

主表只存不复权价。复权因子表计划为 `data/adj/cn/<ex>/<code>.csv`：

```csv
date,symbol,factor
2026-06-20,600519.SH,1.2381
```

`factor` = 累计后复权因子（首条 1.0，除权除息日跳变）。查询时：

- 后复权 `hfq = raw × factor`
- 前复权 `qfq = raw × factor / factor_latest`

在因子表落地前，`get --adjust` 只接受 `raw`，避免把两种口径混在一起。
