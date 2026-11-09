# 金融数据 Skill `fin-data` 设计文档（v0.4）

- 日期：2026-11-09
- 状态：**M0/M1 已落地**（上证50：51 个文件 / 120,638 行，2016-01-04 起）；M2 待做
- 变更：v0.2 → v0.3 存储改为「一标的一 CSV」；v0.3 → v0.4 按此实现并跑通上证50 种子集
- 目标读者：你（评审）与后续实现者
- 相关现状：仓库已有 `.dsh/data/`（Node 版统一数据层，负责实时行情/财务，内存 TTL 缓存，不落盘）与 `.dsh/plugins/financial-dashboard`（看板）。本 skill 补的是**持久化、可分发、可增量更新的历史日线数据**，两者互补，不替换。

---

## 1. 目标与非目标

### 1.1 目标

1. **按顺序取数**：`akshare → adata → iFinD(同花顺) → 网络爬取`，前一个失败/无数据才降级到下一个；每次落盘都记录来源。
2. **本地结构化存储**：设计一套可直接 `git clone` 后使用的数据目录，日线数据可增量更新、可追溯、可校验。
3. **随仓库分发**：把数据文件一起推到 GitHub；别人安装 skill 后**开箱即有数据**；缺失的标的/日期按第 1 条的链路补齐。
4. **先做日 K 线**：本期只做 A 股（含指数）日线，其余数据（分钟线、财务、分红、资金流等）后续按同一套框架扩展。

### 1.2 非目标（本期不做）

- 分钟线、tick、Level-2、实时盘口（实时行情继续走现有 `.dsh/data/` + 腾讯/iFinD 通道）。
- 财务、分红、股东、公告、宏观等数据（框架预留 `dataset` 概念，本期不实现）。
- 历史时点的指数成分回溯（v1 只存**当前**成分快照）。
- 在 skill 内部自动执行 `git commit/push`（默认只落盘 + 打印提交命令；`autoCommit` 可选开启，push 始终手动）。

### 1.3 实现进展（2026-11-09）

| 项 | 状态 |
| --- | --- |
| 环境 | Python 3.11 + uv + akshare 1.20.36 + pandas 2.3.3 |
| 数据 | 上证50（50 只成分 + `000016.SH` 指数）= **51 文件 / 120,638 行 / 8.66MB**，覆盖 2016-01-04 ~ 2026-11-06 |
| 校验 | `verify` **0 违规、38 条除权（EX_RIGHTS）提示**；`update` 幂等（重复执行 no-op） |
| 已实现 | config / calendar / instruments / store / quality / sync / query / cli / universe；akshare 与东方财富直连两个适配器；13 项单测 |
| 待办 | adata 适配器、iFinD 抽样校验、复权因子 + `--adjust`、csi300/csi500 universe、定时任务 / CI、copy 安装验证 |

与本文档的两处有意偏差：
1. 包放在 skill 根的 `findata/`（而非 `scripts/findata/`），`uv run fin-data` 与 `python -m findata` 都可用。
2. 非种子标的写入 `data/local/`（gitignore），只有种子集进 `data/daily/`，避免一次查询把仓库撑大。

---

## 2. 结论先行：推荐方案一览

| 维度 | 推荐方案 | 一句话理由 |
| --- | --- | --- |
| 语言/运行时 | Python 3.11 + `uv` 管理虚拟环境 | akshare/adata 是 Python 生态；3.14 兼容性风险高，锁 3.11 |
| 存储格式 | **一个标的（股票/指数）一个 CSV**：`data/daily/cn/<ex>/<code>.csv`，仅追加，UTF-8 无 BOM | 单票只读一个小文件；可单独拷走；新增标的=新增文件；可 diff |
| 复权 | 存**不复权原始价**；复权因子单独成表（M2），查询时算前/后复权 | 前复权会改写历史，和「只追加」天然冲突；原始价永不改写 |
| 分发范围（入库） | **种子集 = 沪深300 + 中证500 + 7 个主要指数，近 10 年**（807 个文件，约 135–150MB） | 覆盖绝大多数查询；其余标的按需拉取到 `data/local/` |
| 全市场数据 | 不入普通 git：按需拉取到本地 `data/local/`（gitignore） | 全市场 10 年约 1.0–1.1GB，普通 git 不适合 |
| 数据源链 | 逐标的失败降级，链上顺序可配置 | 单源故障只影响个别标的，不阻塞整批 |
| iFinD | **仅本地抽样校验，不进公开数据** | 供应商许可通常禁止再分发；NL 查询也不适合批量 |
| 仓库形态 | **并入当前 `dshworkspace`**，落在 `.dsh/skills/fin-data/` | 与现有 skill 同一套安装/分发方式，一条 `git push` 同时发布代码与数据 |

**已拍板**：种子集 = 沪深300 + 中证500 + 7 个主要指数，近 10 年；仓库 = 并入 `dshworkspace`；复权 = 不复权原始价 + 因子表；iFinD = 仅本地校验，不进公开数据；**存储 = 一标的一个 CSV（默认纯文本，可切 gzip）**。

---

## 3. 关键设计决策与理由

**D1. 数据文件只追加，不原地修改。**
日线一旦写入不再改（错误修正走显式 `--repair` 并重建该标的文件）。带来的好处：git 每次提交的 diff 只有新增的几行；`git log -p` 可以当数据变更审计；多人/多机增量不会互相覆盖。

**D2. 一个标的一个 CSV 文件，而不是年分区 / Parquet / SQLite。**
- **一标的一文件**（本方案）：单票查询只读一个 ~185KB 文件（10 年）；新增标的=新增文件、不影响别人；修一只票只重写它自己；文件可以单独拷走或发给别人；git 里每个标的的历史是一条条独立的 diff。
- 年分区（一年一个大文件）：单票查询要扫 20MB 文件并过滤；补一只票或修一天数据会重写整个年文件；新增/裁剪标的会动到共享文件。唯一的优势是横截面扫描快、可归档 gzip 压到 ~60MB。
- Parquet：压缩率高（约为 CSV 的 1/3–1/2），但二进制不可 diff；每天重写当年文件会让 git 历史每天多存数 MB，一年几个 GB。
- SQLite/DuckDB 单文件：每次写入整库膨胀，git 无法增量，最差。
- 一标的一文件的代价：**工作区约 135–150MB**（807 票；`compress=gzip` 可降到 ~50MB），横截面全量扫描要读 807 个文件（pandas glob 约 1–3 秒，或本地 DuckDB 缓存）。种子规模下可接受；全市场 5927 个文件只进本地 `data/local/`。

**D3. 不复权原始价 + 复权因子分离。**
前复权价会随每次分红除权改写全部历史，与 D1 冲突，且会让同一份数据在不同时间"看起来不同"。因此：主表存原始 OHLCV；`adj-factor` 表存累计后复权因子（除权除息日更新），查询时 `qfq = raw × factor / factor_latest`、`hfq = raw × factor`。M1 先落原始价，M2 接因子（同一数据源第二次调用 `adjust="hfq"` 即可算出，成本很低）。

**D4. 逐标的降级，不逐批次降级。**
akshare 整体挂了才降 adata 很浪费；按"标的 + 缺失日期区间"决定用哪个源，失败才换下一个源。数据行里记录 `src` 短码，便于事后审计。

**D5. 种子集入库 + 按需扩展。**
需求第 3 条要求"别人 clone 就有数据"，但全市场 10 年约 1.0–1.1GB 不适合放普通 git。折中：仓库内放高价值种子集（沪深300+中证500+指数），其余标的由 skill 在首次查询时自动拉取到 `data/local/`（gitignore，未来可选 Release 分发）。**"没有就按链路更新"这条要求因此天然成立。**

**D6. manifest 是唯一可信的状态来源。**
skill 判断"要不要更新"只看 `data/manifest.json` 的 `lastTradeDate` 与交易日历，不看文件 mtime（git checkout 会改 mtime）。

**D7. 不自动 push。**
skill 默认只写数据 + 打印提交建议；配置 `git.autoCommit=true` 才自动 commit（push 仍需凭证与用户授权）。避免 agent 误推。

**D8. 符号统一为 `代码.交易所`。**
`600519.SH`、`000001.SZ`、`920992.BJ`、指数 `000300.SH`。输入兼容 `sh600519` / `cn:sh600519` / 裸 6 位（按首位推断交易所）。文件内一律用规范形式。

---

## 4. 目录结构

落在现有仓库 `dshworkspace` 内，自包含（代码 + 数据同目录）：

```
dshworkspace/
└── .dsh/
    ├── data/                    # 既有 Node 数据层（实时行情/财务），互不影响
    ├── plugins/financial-dashboard/
    └── skills/
        └── fin-data/            # 本 skill（新增）
            ├── SKILL.md         # 给 agent 的触发条件与操作约定
            ├── README.md        # 人读：安装、更新、数据格式、许可声明
            ├── LICENSE          # 代码 MIT；数据另见 NOTICE
            ├── NOTICE           # 数据来源与再分发声明
            ├── pyproject.toml   # 依赖与入口（uv sync）
            ├── uv.lock          # 锁定版本（akshare 等接口漂移风险高）
            ├── config.json      # universe / 源顺序 / 限速 / git 策略
            ├── findata/
            │   ├── __init__.py   # 对外 API：load_bars / status
            │   ├── cli.py        # 命令行入口
            │   ├── config.py
            │   ├── calendar.py   # 交易日历
            │   ├── instruments.py# 标的元数据 + 符号解析
            │   ├── store.py      # 逐标的读写、清单、哈希、压缩
            │   ├── quality.py    # 校验规则与报告
            │   ├── sync.py       # 编排：计划 → 取数 → 校验 → 落盘
            │   ├── query.py      # 查询/复权/序列化
            │   ├── universe.py   # 指数成分 → universe / instruments
            │   └── sources/
            │       ├── base.py   # 适配器契约 + 限速 + 重试
            │       ├── akshare_source.py
            │       ├── adata_source.py   # M2
            │       ├── ifind_source.py   # M2（仅校验）
            │       └── web_source.py     # 东方财富直连
            ├── data/
            │   ├── manifest.json          # 数据集清单（见 5.5）
            │   ├── calendar/trade-dates.json
            │   ├── instruments.json
            │   ├── universes/{sse50,csi300,csi500,indices}.json
            │   ├── daily/cn/{sh,sz,bj,index}/<code>.csv   # 一标的一文件
            │   ├── adj/cn/{sh,sz,bj,index}/<code>.csv     # 复权因子（M2）
            │   ├── quality/report-latest.json
            │   └── local/                 # 非种子标的缓存（gitignore）
            ├── tests/
            │   ├── fixtures/              # 各源响应样本（含 iFinD/东财原始表）
            │   └── test_*.py
            └── references/
                ├── schema.md              # 字段、单位、精度、符号规则
                ├── sources.md             # 各源能力/限速/已知坑
                └── operations.md          # 运维手册（补洞、修复、发版）
```

选型说明：数据放 skill 目录内，而不是 `.dsh/data/`。后者是 Node 数据层；且 `install-skills.mjs` 的 copy 模式会为依赖共享目录的技能（当前是 9c）整份复制 `.dsh/data/`，把 ~150MB 行情数据重复一份。自包含后，copy/link 两种安装模式都只影响 `fin-data` 自己。

---

## 5. 数据模型

### 5.1 标识符

| 市场 | 规范形式 | 示例 | 说明 |
| --- | --- | --- | --- |
| 沪市 | `NNNNNN.SH` | `600519.SH` | 6 位代码 |
| 深市 | `NNNNNN.SZ` | `000001.SZ` | 6 位代码 |
| 北交所 | `NNNNNN.BJ` | `920992.BJ` | 6 位（历史 8 开头） |
| 指数 | `NNNNNN.SH/SZ` | `000300.SH`、`399006.SZ` | 由源显式标注，不靠推断 |

输入兼容（`instruments.parse`）：`600519`、`sh600519`、`cn:sh600519`、`600519.SH` → 统一为 `600519.SH`。

### 5.2 日线主表 `daily`（不复权）

CSV 列顺序固定，首行表头，后续只追加：

```csv
date,symbol,open,high,low,close,volume,amount,turnover,src
2026-11-07,600519.SH,1421.00,1435.50,1418.00,1430.20,2831100,4048567734.00,0.23,ak
```

| 字段 | 类型 | 单位/精度 | 说明 |
| --- | --- | --- | --- |
| `date` | string | `YYYY-MM-DD` | 交易日（Asia/Shanghai），不含时间 |
| `symbol` | string | `代码.交易所` | 见 5.1 |
| `open/high/low/close` | decimal | 元，最多 3 位小数 | **原始成交价**，不做复权 |
| `volume` | integer | **股** | 源给「手」的 ×100 归一 |
| `amount` | decimal | 元 | 成交额；缺失留空（不是 0） |
| `turnover` | decimal | % | 换手率；指数/缺失留空 |
| `src` | string(≤4) | — | `ak` / `ad` / `web`（`if` 预留：仅本地校验，不写入公开数据） |

约定：
- **一个文件只放一个标的**；`symbol` 列保留，文件被单独拷走或 glob 合并时仍能自描述。
- 缺值写空串，不写 `0`/`null`/`NaN`（保持可被 pandas 解析为 NaN，且不进 git diff 噪音）。
- 文件内只按 `date` 升序追加；新交易日永远写在文件尾。
- 唯一键：`date`；重复写入默认跳过，`--force` 才覆盖（触发该文件重建）。
- 表头只在首行写一次；追加时不重复写表头。

### 5.3 复权因子表 `adj-factor`（M2）

```csv
date,symbol,factor,src
2026-06-20,600519.SH,1.2381,ak
```
`factor` = 累计后复权因子（首条为 1，除权除息日跳变）。只在因子变化日写一行（稀疏表）。查询时按 `date` 向后填充。同样一标的一文件：`data/adj/cn/<ex>/<code>.csv`。

### 5.4 文件命名与分区

```
data/daily/cn/sh/600519.csv
data/daily/cn/sz/000001.csv
data/daily/cn/bj/920992.csv
data/daily/cn/index/000300.csv      # 指数单独目录
```

- 分区键：`dataset/market/exchange/code`；`market ∈ {cn}`（预留 `hk`、`us`），`exchange ∈ {sh,sz,bj,index}`。
- 指数单独放 `index/`：避免 `000001.SH`（上证综指）与 `000001.SZ`（平安银行）同码冲突，也避免与个股文件混淆。
- 新增标的：新建文件；移出种子集：删文件 + 更新 manifest（历史仍能从 git 取回）。
- **可选压缩**：`config.json → storage.compress = "gzip"` 时写 `.csv.gz`（每票约 60KB，全库约 50MB）。gzip 允许多 member 追加，pandas / `zcat` 都能直读；代价是文件不可读、不可 diff。
- 不做按年归档：10 年一个文件约 185KB（601318 实测 2434 行 / 185KB），体积完全可控；跨年只是继续往同一个文件尾追加。

### 5.5 清单 `data/manifest.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-09T18:02:11+08:00",
  "timezone": "Asia/Shanghai",
  "datasets": {
    "daily.cn": {
      "kind": "daily-bar",
      "adjust": "none",
      "format": "csv",
      "fields": ["date","symbol","open","high","low","close","volume","amount","turnover","src"],
      "universe": ["csi300","csi500","indices"],
      "coverage": {"from": "2016-01-04", "to": "2026-11-07"},
      "lastTradeDate": "2026-11-07",
      "symbolCount": 807,
      "rowCount": 1948213,
      "byExchange": {
        "sh": {"symbols": 402, "rows": 980000},
        "sz": {"symbols": 388, "rows": 940000},
        "bj": {"symbols": 10, "rows": 12000},
        "index": {"symbols": 7, "rows": 16213}
      },
      "sources": {"ak": 1930110, "ad": 12003, "web": 6100},
      "quality": {"missingSymbols": 0, "flaggedRows": 3, "lastReport": "quality/report-latest.json"}
    }
  }
}
```

`manifest` 由 `store.rebuildManifest()` 扫描目录生成，不手写。不逐文件列 `sha256`：807 个文件每天都会变，清单会变成噪音；完整性由 `verify --hash` 按需计算。逐标的的首末日期从文件首/尾行读取，`status --detail` 可列出。

### 5.6 标的与指数成分

- `instruments.json`：`{symbol, name, market, board, listingDate, delistingDate, status}`，全市场一份（体积 < 1MB）。
- `universes/csi300.json`：`{asOf, source, members:[...]}`，只有当前快照；指数调整时更新并保留旧文件（`csi300-2026-06.json`）以便复现历史查询范围。

---

## 6. 体积与耗时测算（实测）

2026-11-09 实测（东方财富 K 线接口，不复权，2016-11 起 10 年窗口）：

| 项目 | 实测/估算 |
| --- | --- |
| A 股标的数（含北交所） | **5927** |
| 单只 10 年行数 | 601318：**2434 行**（185,429 B）；全历史 4720 行（2007-03 起） |
| CSV 行体积 | **76.2 B/行**（10 列，含 `symbol`/`src`） |
| 单票文件（10 年） | **185 KB** CSV；gzip **61 KB**（3.04×） |

据此推算：

| 方案 | 文件数 / 行数 | 未压缩 | gzip | 说明 |
| --- | --- | --- | --- | --- |
| 种子 807 只 × 10 年（纯文本，推荐） | 807 / ~180 万 | **~135–150 MB** | — | 入库；clone 一次，之后每天增量 |
| 同上 + `compress=gzip` | 807 / ~180 万 | — | **~48–55 MB** | 体积减半，但文件不可读、不可 diff |
| 全市场 5927 只 × 10 年 | 5927 / ~1350 万 | ~1.0–1.1 GB | ~350–400 MB | 只进 `data/local/`（gitignore），不入库 |

git 增长：日常更新每天约 807 行、60KB 正文（packfile 后约 30–60KB/天，约 10–20MB/年）；首次全量提交约 140MB。
耗时（单源、3 请求/秒）：种子 807 只全量约 **5 分钟**；全市场 5927 只约 **35 分钟**；日常增量 1 个交易日 × 807 只 < 20 秒（按批拉取可更快）。
横截面扫描：pandas 读 807 个文件约 1–3 秒；单票查询只读一个 185KB 文件（约 10ms）。

结论：**一标的一文件在种子规模下完全可行（150MB 或 gzip 后 50MB）；全市场仍不适合入库**（这是 D5 的依据）。

**上证50 实测**：51 个文件、120,638 行、8.66MB（纯文本），验证了 76 B/行 的估算；按此比例 807 只约 130–140MB。

---

## 7. 数据源链

### 7.1 顺序与职责

```
akshare ──失败/无数据──▶ adata ──失败──▶ iFinD(仅校验，不写主数据) ──失败──▶ web 直连 ──失败──▶ 保留旧数据并告警
```

- 顺序可配置：`config.json → sources.order`。
- **不是每批都从头试**：对"标的多、日期区间新"的日常增量，直接用上次成功的源；只有它失败才走链（避免每天白白触发限速）。
- 首次全量 / 新标的：严格按配置顺序。
- iFinD 仍在链路位置上（满足"按顺序尝试"），但按合规口径**只做抽样校验**：它失败或未授权时直接落到 web 源补数（见 7.5）。

### 7.2 各源能力（本期）

| 源 | 日线 | 复权因子 | 限速建议 | 备注 |
| --- | --- | --- | --- | --- |
| akshare | ✅ `stock_zh_a_hist`、指数 `index_zh_a_hist`/`stock_zh_index_daily` | ✅ `adjust="hfq"` 反推 | 3–5 req/s，随机 100–300ms 抖动 | 底层多为东财/新浪；字段中文名，单位「手」，需归一 |
| adata | ✅ `stock.market.get_market`（含 adjust_type） | ✅ 直接支持 | 3–5 req/s | 多后端，批量接口可减少请求 |
| iFinD | ⚠️ 仅 `get_stock_performance`（NL query） | ❌ | 按配额，**不做批量** | 仅抽样校验；不写主数据（补洞走 web） |
| web（东财直连） | ✅ `push2his.eastmoney.com/api/qt/stock/kline/get` | ✅ 同接口 `fqt=1` | 1–3 req/s，退避重试 | 已实测可用；`secid`：`1.`沪 `0.`深/北 |
| web（腾讯） | ✅ `web.ifzq.gtimg.cn`（现有 provider 已实现） | ✅ | 3–5 req/s | 返回 `qfqday`，取原始需去掉 `qfq` 参数；长历史要按日期分段请求 |

**每源必须返回"不复权"口径**；若某源只能给前复权，适配器应拒绝并抛 `Unsupported`，而不是把复权价当原始价写进去。

### 7.3 适配器契约（`sources/base.py`）

```python
@dataclass
class Bar:
    date: str        # YYYY-MM-DD
    open: float; high: float; low: float; close: float
    volume: int      # 股
    amount: float | None
    turnover: float | None

class Source(Protocol):
    name: str                      # ak / ad / if / web
    kinds: set[str]                # {"daily", "adj_factor", "index"}
    markets: set[str]              # {"cn"}
    def fetch_daily(self, symbol, start, end) -> list[Bar]: ...
```

- 统一抛 `ProviderError(code, symbol, message)`，`code ∈ {NOT_FOUND, EMPTY, HTTP, BAD_SHAPE, UNSUPPORTED, RATE_LIMITED, AUTH}`。
- 所有适配器输出先过 `normalize()`（单位、精度、排序、去重），再进 `quality.check()`。
- 每个适配器必须有 fixtures 级单测：源字段改版时测试先红，而不是数据悄悄错。

### 7.4 限速、重试、断点

- 每源一个 `Bucket`（令牌桶）+ 全局限并发（默认 4），失败指数退避 `1s → 2s → 4s`，最多 3 次；`429/403` 直接退避 30s 并降级。
- 进度写入 `data/local/state.json`（当前批次、已完成标的、失败清单），中断后 `update --resume` 从断点继续。
- 失败清单进 `quality/report-latest.json`，不静默丢。

### 7.5 iFinD 的边界（重要）

- MCP 服务的行情工具只到**日内高频/实时快照**，日频历史走 `get_stock_performance` 的**自然语言查询**，列名随问法变化、按次计配额 → **不适合批量回填**。
- 用途限定：① 每周随机抽样 N 只（默认 20）做交叉校验；② akshare/adata 都失败时，只作为告警依据提示人工复核，**不写入主数据**（补洞走 web 源）。
- **合规**：iFinD 数据不进入公开仓库。主数据不产生 `src=if` 行；`if` 仅保留在质量报告与本地校验日志中（见第 13 节）。

---

## 8. 同步流程

### 8.1 首次全量（`sync --universe seed --since 2016-01-01`）

1. `calendar.ensure()`：拉/更新交易日历（akshare `tool_trade_date_hist_sina` → adata → 东财指数日线反推），落 `data/calendar/`。
2. `instruments.refresh()`：拉全市场代码/名称/上市日（东财列表接口），更新 `instruments.json`；`universes/*.json` 同步当前成分。
3. 展开任务：`(symbol, start, end)`，按"标的"分组；已存在数据从 `max(date)+1` 开始（断点续跑）。
4. 逐标的调用源链，取回 → 归一 → 校验 → 追加到该标的文件（新标的则新建文件并写表头）。
5. 重建 `manifest.json`；输出摘要（成功/失败/跳过/新增行数/体积）。
6. 生成 `quality/report-latest.json`；可选按配置 commit。

### 8.2 日常增量（`update`）

```
latest = calendar.latest_closed_trade_date()
if manifest.lastTradeDate >= latest: 直接退出（打印 no-op，耗时 < 1s）
for each symbol in universe:
    need = (manifest.lastTradeDate, latest]   # 单日或多日（停机补偿）
    rows = first_success_source(symbol, need)
    validate(rows); append(rows)              # 只追加，必须满足 date 单调
manifest.rebuild(); report()
```

- 只有当天 15:00 之后、且源已出当日数据才更新（东财约 16:00–17:00 稳定；可用"当日最后一根是否收盘"判断，见 8.4）。
- 节假日/周末：`latest_closed_trade_date()` 自动回退到上一交易日，`update` 为 no-op。
- 停机多日后：`need` 区间跨多日，一次补齐；期间若有停牌，源缺行属于正常，记为覆盖缺口而非错误。

### 8.3 补洞与修复

- `repair --symbol X --from A --to B`：重拉区间 → 与现存行合并去重 → 排序 → **重建该标的文件**（唯一允许改写文件的路径，只影响这一个 ~185KB 文件）。
- 触发条件：源修正历史、`verify` 发现 OHLC 违例、涨跌幅越界、量价长期为 0。
- 每次 repair 在 `quality/` 留一条记录（谁、为什么、影响行数），并在 commit message 中说明。

### 8.4 失败语义

| 情况 | 行为 |
| --- | --- |
| 当日数据源尚未更新（最后一根是今日盘中/缺失） | 不写当日行，`update` 保持 no-op，1 小时后可重试 |
| 标的已退市/长期停牌 | 记录 `status`，不再请求；查询返回最后一根 |
| 全部源失败 | 不写、不动旧数据；退出码非 0；告警列出标的与错误码 |
| 部分标的失败 | 其余正常写入；manifest 记录 `failedSymbols`，下次自动重试 |

---

## 9. 数据校验与质量

写入前逐行校验（`quality.py`）：

1. **类型/空值**：价格 > 0；`high ≥ max(open, close)`、`low ≤ min(open, close)`；`volume ≥ 0`。
2. **排序/重复**：文件内 `date` 严格递增且不重复。
3. **涨跌幅越界**：相对前收 `|Δ|` 超过板块限制（主板 10%、双创 20%、北交所 30%、ST 5%）→ **标记不删除**（新股首日、复牌例外），进报告。
4. **量价异常**：连续 ≥ 5 日 `volume=0` 且 `close` 不变 → 疑似停牌未标记，标记。
5. **覆盖缺口**：对每个标的，比对"上市日→最新交易日"与已存日期，缺口天数 > 20 个交易日 → 提示可能漏抓（停牌正常的除外）。
6. **跨源抽样**：每批随机 20 只，取 iFinD/另一源对照，`close` 差 ≤ 0.01 且 `volume` 相对差 ≤ 1%；不符 → 报告并标记该标的待人工复核。

质量门槛（发布前）：`violations=0`（被标记行允许存在，但需在报告中可见）、`failedSymbols=0`、`coverage.to == lastTradeDate`。

---

## 10. 查询接口

### 10.1 CLI（agent 与人都用）

```bash
uv run fin-data status                 # 数据是否最新？覆盖范围？体积？
uv run fin-data get --symbol 600519.SH --start 2026-01-01 --adjust raw --format json
uv run fin-data get --symbol 000300.SH --start 2016-01-01 --format csv > out.csv
uv run fin-data update                 # 增量
uv run fin-data sync --universe seed --full
uv run fin-data verify --sample 20
uv run fin-data repair --symbol 600519.SH --from 2026-10-01 --to 2026-10-31
uv run fin-data list-universe csi300
```

- `get` 输出 JSON 数组（每行一个对象）或 CSV；`--adjust qfq|hfq` 在 M2 后可用。
- 成功退出码 0；"数据缺失且补齐失败"退出码 2 并给结构化错误；参数错误退出码 1。

### 10.2 Python API

```python
from findata import load_bars, status
rows = load_bars("600519.SH", start="2026-01-01", end=None, adjust="raw")
```

### 10.3 agent 约定（写进 SKILL.md）

1. 用户问历史行情时：先 `status`；`stale=true` 先 `update`（失败则明确告知数据截止日，**不得编造**）。
2. 回答必须带 `source` 与 `as-of`（如"数据截至 2026-11-07，来源 akshare"）。
3. 查询不在种子集的标的：先 `get`，miss 时触发按需拉取（写 `data/local/`），再重试，最多一次。
4. 复权口径必须显式说明；默认 `raw`，画图/回测建议 `qfq`。

---

## 11. 分发与安装（并入 `dshworkspace`）

### 11.1 位置与发布

代码与种子数据都在 `.dsh/skills/fin-data/`，随现有 `origin git@github.com:walkvoid/dshworkspace.git` 一次 push 同时发布代码与数据。skill 自包含，不依赖 `.dsh/data`、`.dsh/scripts`。

### 11.2 安装到本机 skill 根

```powershell
node .dsh/scripts/install-skills.mjs --root "C:\Users\jiangjunqing\.dsh\skills" --mode link --skills fin-data
```

- `link`：junction 指向仓库目录，仓库里 `update` 立即生效（日常自用）。
- `copy`：整目录复制（含 `data/`）并写入 `repo.txt`，适合给他人/别的机器；之后 `update` 只改副本，需要自己提交。
- 首次在 skill 目录执行 `uv sync`（或 `python scripts/bootstrap.py`）安装依赖。

### 11.3 数据更新与提交

```powershell
cd .dsh/skills/fin-data
uv run fin-data update
cd ../../..
git add .dsh/skills/fin-data/data
git commit -m "data(fin-data): 2026-11-10"
git push
```

- 默认**不自动 commit/push**（D7）：CLI 打印上述命令；`config.json → git.autoCommit=true` 时自动 commit（仍不 push）。
- 只提交 `data/` 下的 `manifest.json`、`calendar/`、`instruments.json`、`universes/`、`daily/`、`quality/`；`data/local/` 不入库。
- 他人 pull 后日期落后 → `update` 只追加本地缺失日期，不触碰已提交内容，`git pull --rebase` 无冲突。
- 万一冲突（两端都补了同一天）：并集去重、排序、重建该标的文件后提交。

### 11.4 `.gitignore` 追加

```gitignore
# fin-data：虚拟环境、按需缓存、锁文件
.dsh/skills/fin-data/.venv/
.dsh/skills/fin-data/__pycache__/
.dsh/skills/fin-data/.pytest_cache/
.dsh/skills/fin-data/data/local/
.dsh/skills/fin-data/**/*.lock
```

### 11.5 体积控制

- 入库只有种子集：807 个文件、约 135–150MB（`compress=gzip` 时约 50MB）；每日追加约 807 行 ≈ 60KB。
- 单票文件最大约 185KB，天然不会触碰 100MB 限制；`check-size` 只用于拦截误放进仓库的全市场包。
- 横截面查询：pandas `read_csv` glob 807 个文件（1–3 秒），或建本地 DuckDB 缓存（gitignore）。
- 全市场数据只进 `data/local/`（gitignore）；确需共享时走独立 Release 或对象存储，不写入本仓历史。
- CI（可选，M3 之后）：GitHub Actions 每日 16:30（Asia/Shanghai）跑 `update` 并 commit；iFinD 不参与 CI。

---

## 12. 运行环境

| 项 | 选择 | 理由 |
| --- | --- | --- |
| Python | **3.11**（`uv python install 3.11`） | akshare 要求 ≥3.11；3.14 下 pandas/akshare 依赖链风险高 |
| 依赖管理 | `uv sync` + `requirements.lock` | 可复现；避免 akshare 升级把字段改坏 |
| 关键依赖 | `pandas`、`akshare==1.20.*`、`adata==2.9.*`（extras: update）、`requests` | 只读查询仅需 pandas |
| iFinD | 复用 `ifind-finance-data` skill 的 `call.py`（MCP 客户端） | 无需额外授权流程；未配置 key 时自动跳过 |
| 并发 | 默认 4，可配 | 兼顾速度与封禁风险 |

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **iFinD/交易所数据再分发合规** | 公开仓库可能违反供应商/交易所条款 | 已定口径：iFinD 只做本地抽样校验，不写主数据、不进仓库；公开数据只来自 akshare/adata/web（公开接口）；README/NOTICE 注明来源与免责声明；如需进一步合规可缩小公开标的范围 |
| akshare 接口/字段随版本漂移 | 取数静默错误 | 锁版本 + fixtures 单测 + 每批抽样交叉校验；适配器隔离 |
| 东财反爬/限流/封 IP | 全量同步失败 | 限速 + 退避 + 多源降级 + 断点续跑；失败清单可见 |
| 前复权口径混淆 | 回测结果错误 | 只存原始价，复权在查询层算，口径显式返回 |
| 停牌/退市/新股导致"缺口" | 误报质量告警 | 缺口只提示不阻断；`status` 字段区分退市/停牌 |
| 仓库体积膨胀 | clone 变慢 | 一票一文件（150MB）+ 可选 gzip（50MB）+ 单文件 100MB 检查 + 全市场只进 `data/local/` |
| 时区/交易日误判 | 多抓或少抓一天 | 一律用 Asia/Shanghai + 交易日历；`latest_closed_trade_date()` 是唯一入口 |
| Windows 路径/编码 | CSV 乱码、路径失败 | UTF-8 无 BOM、`newline=''`；路径全 `pathlib` |

---

## 14. 里程碑与验收

| 里程碑 | 内容 | 预计 | 验收标准 |
| --- | --- | --- | --- |
| M0 骨架 | venv/bootstrap、calendar、instruments、store（逐标的文件+manifest）、`get/status` | 1.5 天 | ✅ 上证50 可查；`status` 正确 |
| M1 种子集 + 增量 | akshare 适配器、universe、`sync`/`update`、quality 基础规则、gzip 开关 | 2.5 天 | ✅ 51 只×10 年落盘；`update` 幂等；0 违规 |
| M2 链路与复权 | adata、web（✅ 已接）、iFinD 校验、adj-factor、`--adjust` | 2.5 天 | 断掉 akshare 仍能补数；抽检 20 只一致；qfq/hfq 与源对齐 |
| M3 分发 | 并入 `dshworkspace`：README、安装说明、`.gitignore`/体积检查、可选定时任务 | 1 天 | `install-skills.mjs --mode copy` 装到干净目录 → 5 分钟内可查询；`update` 后按 11.3 可提交 |
| M4（可选） | 全市场 + Release 包 + CI 每日更新 | 2 天 | 5927 只可拉取；Release 下载可用 |

测试要求：每源 fixtures 单测、store 的"追加/压缩/重建"单测、`update` 幂等测试、quality 规则表驱动测试。

---

## 15. 已确认口径与其余默认

| 项 | 结论 |
| --- | --- |
| 种子集范围 | **沪深300 + 中证500 + 7 个主要指数，近 10 年**（2016-01-01 起） |
| 仓库 | **并入 `dshworkspace`**，目录 `.dsh/skills/fin-data/` |
| 存储 | **一标的一个 CSV**：`data/daily/cn/<ex>/<code>.csv`；默认纯文本，`storage.compress=gzip` 可切 ~50MB |
| 复权 | **只存不复权原始价 + 独立因子表**；前/后复权在查询时计算 |
| iFinD | **仅本地抽样校验**，不写主数据、不进公开仓库、不参与补洞 |
| 全市场 | 按需拉取到 `data/local/`（gitignore），不入库 |
| 自动 push | 否；`git.autoCommit` 默认 false |
| 更新时点 | 交易日 16:30 之后；节假日/周末自动 no-op |
| 运行时 | Python 3.11 + uv；只读查询仅需 pandas，更新才需 akshare/adata |

调整方式：改 `config.json` 的 `universe` / `history_years` / `sources.order` 后执行 `sync --full`；已入库的历史不受影响（只追加）。

---

## 附录 A：样例数据行

```csv
date,symbol,open,high,low,close,volume,amount,turnover,src
2026-11-07,600519.SH,1421.00,1435.50,1418.00,1430.20,2831100,4048567734.00,0.23,ak
2026-11-07,000001.SZ,11.52,11.61,11.45,11.58,81230000,938210000.00,0.42,ak
2026-11-07,000300.SH,4580.12,4612.33,4572.90,4605.71,,,,web
```

## 附录 B：命令速查

```bash
# 以下命令在 .dsh/skills/fin-data 下执行

# 首次
uv sync && uv run fin-data sync --universe seed --since 2016-01-01

# 日常（在仓库根提交）
uv run fin-data update
git add .dsh/skills/fin-data/data && git commit -m "data(fin-data): 2026-11-10"

# 查询
uv run fin-data get --symbol 600519.SH --start 2025-01-01 --format json

# 体检
uv run fin-data verify --sample 20
```
