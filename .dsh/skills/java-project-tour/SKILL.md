---
name: java-project-tour
description: 项目导览：把多仓库 Java 项目扫成 .knowledge 索引（仓库职责、HTTP/Dubbo/定时任务/消息入口、表读写、业务流程到处理类），并用“核心”标记加速后续定位。当用户说“这个项目是干什么的”“这个功能在哪个类里”“改 XX 要动哪些文件”，或输入 /java-project-tour、/导览、/代码地图 时使用。
---

# 项目导览（java-project-tour）

陌生仓库里最贵的不是读代码，是**找错文件**。这个技能先用脚本把几万个文件压成 `.knowledge/` 索引，
再由模型补上“这个仓库干什么、这条流程怎么走”，并维护一份**核心标记**，让后面的需求分析、写代码、
修 bug 三个技能不必每次从头找。

**它不是文档生成器**：`.md` 是给人看的副产物，`*.json` 才是给技能查的主产物。

## 一、产物目录

一切都在 `<项目根>/.knowledge/`（不加子目录层）：

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `inventory.json` | 脚本 | 30+ 个仓库的模块、依赖、技术栈、分层、Java 文件数、git HEAD |
| `entries.json` | 脚本 | 入口索引：HTTP 路由、Dubbo 服务、`@XxlJob`、MQ 监听、Feign 客户端，每条带 `path:line` |
| `data.json` | 脚本 | 表 ↔ Mapper ↔ 实体：谁读、谁写、在哪个文件第几行 |
| `flows/index.json` | 脚本 | 流程定义（procdef）→ 节点 → `extHandler` → 处理类路径 |
| `flows/*.md` | 脚本 | 每条流程的处理类清单（表格：节点 / 阶段 / 类 / `path:line`） |
| `features.json` | 脚本 | 功能点候选：有流程就一流程一项，没有就按入口聚合 |
| `features.md` | 脚本 | 功能点一览，模型据此确认后写进 `core.json` |
| `db.json` | 脚本 | 可选：库里的表行数 → 数据量推断出的核心功能（已过滤日志表） |
| `core.json` | **技能** | 核心功能点 / 核心流程 / 核心类 / 核心表，带标记人与原因 |
| `core.md` | 脚本 | 核心索引速览，**查询前先读它** |
| `manifest.json` | 脚本 | 各仓库 HEAD 与扫描时间，用于过期判定 |
| `README.md` | 脚本 | 索引说明 + 常用命令 |

`repos/<仓库>.md` 与 `overview.md` 由模型写（脚本不管），用来回答“这个仓库/项目是干什么的”。

## 二、第 0 步：确定项目根

按顺序取：用户明确说了 `<项目根>` → `--project`；否则 `TOUR_PROJECT`；否则 `project/` 下唯一的子目录。

有 `env-profile.json` 时**只读 `git[].repos` 和 `git[].dir`**——它是仓库清单的来源，**不要读、不要打印
`databases` / `nacos` / `nexus` 里的账号密码**。

**成功判定**：能列出仓库名（默认要求有 `pom.xml` 或 `.git`），并知道索引目录是 `<项目根>/.knowledge/`。

## 三、第 1 步：扫描（脚本，1 分钟内）

```bash
node <技能目录>/scripts/tour.mjs scan --project "<项目根>"
```

实测参考：30 个仓库 / 11,555 个 Java 文件 → **约 27 秒**，产出 4,974 条入口、390 张表、32 条流程。

只重扫一部分：

```bash
node <技能目录>/scripts/tour.mjs entries --repos service-a,service-b
node <技能目录>/scripts/tour.mjs flows      # 流程定义改了重跑这个
```

**成功判定**：`entries` 与 `tables` 大于 0；`unresolved` 只包含确实解析不了的项。
`flows` 为 0 **不一定失败**——有些项目根本没有工作流引擎，见下。

**没有工作流定义的项目**：`flows` 会是 0，这时功能点由入口推断：

```bash
node <技能目录>/scripts/tour.mjs features --project "<项目根>"
node <技能目录>/scripts/tour.mjs flows --no-procdefs   # 明确没有工作流，跳过流程扫描
```

- 有流程定义：**每个流程就是一个功能点**（`origin: workflow`），这是最可靠的业务清单；
- 没有流程定义：按 **HTTP 首段 / 包里的业务包 / 任务名前缀**聚合入口（`origin: entries`），
  并过滤掉 `getById` / `allList` / `count` 这类通用 CRUD 端点，避免脚手架淹没业务；
- 两种情况都会写 `features.json` + `features.md`，后者是一张带锚点的候选清单。

**它只是候选**：功能名对不对、哪些算核心，由模型读 `features.md` 后判断；
确认后用 `core mark --feature <id>` 固定，别把聚合结果当结论。

流程定义放在别处时用 `--procdefs <目录>` 显式指定，不要靠猜。

### 用数据量校验核心功能（可选，需要能连库）

入口和流程说明“有哪些功能”，行数说明“哪些功能真的在跑”。能连测试库（qa / test）时，这一步最划算：

```bash
# 1) 生成只读 SQL（默认走 qa/test 测试库，输出里没有密码）
node <技能目录>/scripts/tour.mjs db queries --project "<项目根>" --env qa

# 2) 用数据库 MCP 工具（env-prep 装好后的 mcp__mysql_*）或 mysql 客户端执行这条 SQL，
#    把结果存成 rows.json（数组，或 { "rows": [...] }；字段 table_name / rows_est / data_bytes 都认）

# 3) 汇入并推断 5-10 个核心功能
node <技能目录>/scripts/tour.mjs db ingest rows.json --project "<项目根>" --limit 10

# 4) 合并进功能点清单
node <技能目录>/scripts/tour.mjs features --project "<项目根>"
```

规则（写进脚本，也写进 `db.json`）：

- **只读**：只执行 `SELECT` 与 `information_schema` 查询，不碰任何写操作；
- **优先测试环境**：qa → test → uat；`dev` 是研发库（常年造数据、行数不反映业务规模），
  只有显式 `--env dev` 才用，落到 dev 时结果里会带 `fallback: true`；
- `TABLE_ROWS` 是 InnoDB 的**估算值**，排序够用，不要当精确数；
- **过滤日志类数据**：`act_hi_*` / `act_ru_*`（工作流引擎）、`qrtz_*`（Quartz 调度）、`sys_oper_log`、
  `*_log` / `*_his` / `*_history` / `*_trace` / `*_audit` / `*_bak` / `*_tmp` / `*_stat` 等都不计入；
- 单表低于 `--min-rows`（默认 1000）视为字典表，不计入；
- 按 `log10(行数)` 加权汇总到功能域（表 → 实体包 / Mapper 仓库 / 表前缀），取前 5–10 个；
- 密码只从 `env-profile.json` 读，**不回显、不落盘、不写进结果**。

**数据量不是重要性**：一张日志表可能几十亿行但业务无关（已被过滤），一张配置表可能只有几十行却关键。
行数只说明“业务在用”，最终结论仍要模型结合入口、流程与业务常识判断。

## 四、第 2 步：补人读文档（模型）

脚本给不出“这个仓库是干什么的”，这一步由模型写，规矩是**每个结论都要能回到索引里的锚点**：

1. `repos/<仓库>.md`：一句话职责 → 对外提供什么（HTTP/Dubbo/Job）→ 分层与关键类（≤5 个，带 `path:line`）
   → 它依赖谁、谁依赖它（来自 `inventory.crossRepoDeps`）。单页 ≤ 60 行。
2. `overview.md`：分层图（接入层 / 业务服务 / 公共组件 / 批处理）+ 跨仓库依赖 + 核心流程清单。
3. 写之前先 `find` / `flows/*.md` 取证据；**没有锚点的判断写进“待确认”，不要写成事实**。

## 五、第 3 步：核心机制（这个技能的长期价值）

`.knowledge/core.json` 记录四类核心对象，可以理解为“项目的骨架 + 高频改动面”：

```json
{ "kind": "feature", "id": "asset", "reason": "资产域是主要业务面", "markedBy": "java-project-tour", "hits": 2 }
{ "kind": "flow",  "id": "资产签发-主流程-V16", "reason": "端到端主流程", "markedBy": "java-project-tour", "hits": 3 }
{ "kind": "class", "id": "service-c/.../IssueSignAuditTaskListenerHandler.java", "layer": "provider", "reason": "...", "hits": 1 }
{ "kind": "table", "id": "asset_issue", "reason": "主表", "hits": 2 }
```

**什么时候标**（每次实质回答后顺手做，不要攒）：

- 用户认下来的功能域 → `--feature`（没有工作流定义的项目，这是最主要的一类）；
- 用户认下来的端到端主流程 → `--flow`；
- 回答里点名的“改这里”的类 → `--class`；
- 被 3 处以上读写的表 → `--table`；
- 后续技能（需求分析 / 写代码 / 修 bug）每复用一次，就 `core mark` 一次——`hits` 会累加，用来判断哪些是真正的热点。

```bash
node <技能目录>/scripts/tour.mjs core mark --project "<项目根>" \
  --flow 资产签发-主流程-V16 \
  --class service-c/.../IssueSignAuditTaskListenerHandler.java \
  --table asset_issue \
  --reason "资产签发主流程 + 抢签入口 + 主表" --by java-project-tour
```

**查询时先读核心**：

```bash
node <技能目录>/scripts/tour.mjs core brief    # 同时刷新 .knowledge/core.md
```

`core brief` 输出核心功能点（带入口样例）、核心流程（带 3 个处理类锚点）、核心类、核心表。下游技能的正确顺序是
**`core brief` → `find` / `where` → `context`**，core 命中的结果会在检索里带 `★` 并优先排序。

标记要诚实：拿不准的不标；标错了用 `core unmark --feature/--flow/--class/--table` 撤掉，别让核心索引变成垃圾桶。

## 六、第 4 步：查询（下游技能调用的入口）

```bash
tour.mjs find 资产签发 --limit 10        # 关键词：路由 / 类名 / 表名 / 流程名
tour.mjs find issue --kind http          # 只要 HTTP 入口
tour.mjs where "资产签发 增加 字段"        # 改动触点，按 web/service/provider/table/flow 分组
tour.mjs context <path>                  # 某个类的上下游（入口、Mapper、表、所属流程、同层兄弟）
```

输出约定：

- 每条命中给 `kind`（http / dubbo / job / mq / feign / flow / handler / table）、`path:line`、符号名；
- `core: true` 的带 `★`，排在最前；
- `where` 额外给 `risks`（例如“这张表在 3 处被读写，改结构要全核对”）。

**无命中时**：先 `core brief` 看是不是已经标过；再换英文类名 / 路由片段 / 表名；都没有就说明**没扫到**，
跑 `status` 确认索引是否过期、`scan` 补扫，**不要凭记忆编类名**。

## 七、第 5 步：维护

```bash
tour.mjs status        # 各仓库 HEAD 与 manifest 对比，列出 stale / missing
tour.mjs inventory     # 新增仓库、依赖变动后刷新
```

- `git pull` 后：`status` 有 stale → 重扫对应仓库；
- 新增仓库：`inventory` + `entries` 重跑（或用 `--repos` 只扫新的）；
- `.knowledge/` 默认**不入库**（它描述的是本地这份代码），要入库先问用户，并在 `.gitignore` 里显式决定。

## 八、质量闸门（不满足就不要往下写）

| 闸门 | 要求 |
| --- | --- |
| 锚点 | 所有结论带 `path:line`；写完后随机抽 3 条回读，符号必须真的在该行附近 |
| 置信度 | 注解/XML 实证 = `verified`；推断 = `inferred`；解析失败进 `unresolved.json`，**不许猜** |
| 覆盖率 | `entries` 覆盖到的 Controller 比例、Mapper 解析率写进报告；明显偏低先查扫描参数 |
| 不越界 | 只读代码与配置键名；不跑构建、不写业务代码；连库仅限 §三 的只读行数查询 |

## 九、失败处理

| 现象 | 处理 |
| --- | --- |
| `entries` 为 0 | 项目根不对（`--project` 指到仓库而非项目目录）；或源码在 `src/main/java` 之外 |
| `flows` 为 0 | 先确认项目是否真有工作流：有则用 `--procdefs <目录>` 指路径；没有就是正常情况，看 `features` 是否 > 0 |
| `features` 为空 | `entries` 也为空，说明源码没扫到；或所有入口都是通用 CRUD（被过滤），确认项目是否有业务接口 |
| `db queries` 报找不到 profile | 先跑 env-prep 生成 `<项目根>/.env-prep/env-profile.json`，或用 `--profile` 指路径 |
| `db ingest` 后功能点很少 | 行数低于 `--min-rows` 被过滤，或表名与实体/Mapper 都对不上；用 `--min-rows 0` 看全量再判断 |
| 连不上库 | 本机没有 mysql 客户端时用数据库 MCP 工具跑 SQL；网络不通就跳过这一步，**不要为连库改配置或绕鉴权** |
| 大量 `unresolved` 处理类 | 处理类不在本项目的仓库里（在别的服务），保留 `unresolved` 并在文档里注明 |
| `status` 全 stale | 扫描时用了旧 HEAD；重扫即可 |
| 中文路径报错 | 确认用 Node ≥ 18，且路径用引号包住 |

## 十、边界

- 本技能**只读**：不执行构建、不写业务代码；数据库只在「用数据量校验核心功能」时，由数据库 MCP 工具
  （`mcp__mysql_*`，来自 env-prep）执行**只读** SQL（`SELECT` / `information_schema`，优先 qa/test）；
  脚本本身不建连接，也不改数据、不建表、不改配置、不绕鉴权；
- 输入只有**源码**和**流程定义**（`procdefs/*.json`）。项目里已有的其他说明文档、旧索引、旧地图
  一概不读、不迁移、不合并，产物只写 `.knowledge/`；
- 索引描述的是**当前工作区**，跨机器需要各自扫一遍；
- 业务语义（流程为什么这样设计）不在本技能范围——它给的是“在哪”，不是“为什么”。
