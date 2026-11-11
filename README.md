# dshworkspace

DeepSeek Harness（DSH）的插件与技能集合：一块能用的**金融看板**、几个对话里直接触发的**技能**、
一条统一的行情/财务取数管线，以及一个可离线查询、随仓库分发的 **A 股日线数据仓库**。
生成的浏览器包随仓库提交，clone 后无需构建。

| 内容 | 是什么 | 入口 |
| --- | --- | --- |
| 金融看板 | DSH 插件 bundle（`.dsh/plugins/financial-dashboard/`） | 左侧栏 / 右侧栏 |
| 史诗级韭菜 | 技能（`.dsh/skills/9c/`） | `/9c`、`/史诗级韭菜` |
| A 股日线数据 | 技能 + 数据（`.dsh/skills/fin-data/`） | `/fin-data` |
| Java 环境准备 | 技能（`.dsh/skills/java-env-prep/`） | `/java-env-prep`、`/环境准备` |
| 项目导览 | 技能（`.dsh/skills/java-project-tour/`） | `/java-project-tour`、`/代码地图` |
| 数据层 | `fin-data` 技能的统一查询入口（`.dsh/skills/fin-data/api/`）+ 内部适配器 `.dsh/skills/fin-data/adapter/` | 以上内容共用 |

---

## 1. 安装

### 1.1 交给 Agent 装（推荐）

把这句话发给目标机器上的 Agent，它会自己 clone 仓库、装技能、装看板、按需接 iFinD：

```text
阅读 https://raw.githubusercontent.com/walkvoid/dshworkspace/main/SKILL_INSTALL_GUIDE.md，完成安装
```

可以点名只装其中一块，Agent 按名字解析，不会顺手多装：

| 你说 | 装什么 |
| --- | --- |
| …，安装史诗级韭菜 | 只装 `9c` |
| …，只安装金融看板 | 只装看板 + 它依赖的 `fin-data`（数据入口），不装其他技能 |
| …，安装史诗级韭菜和环境准备 | `9c` + `java-env-prep` |
| …，安装项目导览 | 只装 `java-project-tour` |
| …（不点名） | 技能 + 看板 + 询问是否接 iFinD |

安装过程中的提问——装到用户级还是项目级、要不要接 iFinD 并贴密钥、写书签要不要关浏览器——都会照常问。
完整规则见 [`SKILL_INSTALL_GUIDE.md`](./SKILL_INSTALL_GUIDE.md)。

### 1.2 手动装

先把仓库克隆到一个固定位置（路径随意，技能靠它定位数据脚本）：

```powershell
git clone https://github.com/walkvoid/dshworkspace.git "$env:USERPROFILE\.dsh\repos\dshworkspace"
```

**技能**：用仓库自带的脚本装，不要手工复制目录：

```powershell
$repo = "$env:USERPROFILE\.dsh\repos\dshworkspace"
node "$repo\.dsh\skills\install-skills.mjs" --root "$env:USERPROFILE\.dsh\skills" --mode copy --force --skills 9c
```

| 参数 | 作用 |
| --- | --- |
| `--root` | 技能根目录：用户级 `~/.dsh/skills`，项目级 `<项目根>/.dsh/skills`；也可以直接给 `~/.dsh`，自动落到其 `skills/` |
| `--mode copy` | 复制目录并写 `repo.txt`（仓库绝对路径），换机器、换目录都能跑 |
| `--mode link` | 建目录联接指向仓库，改仓库即时生效（本机自用更省事） |
| `--skills` | 只装指定技能，逗号分隔；不带则装默认列表（当前 `9c`、`fin-data`） |
| `--force` | 目标已存在时删除重装（更新/重复安装时带上，装到最新） |

每个技能都是**自包含**的：脚本在技能自己的 `scripts/` 里（`9c/scripts/stock-data.mjs` 等），
数据在 `fin-data/data/` 里，安装器只复制/链接技能目录本身，装完不依赖仓库留在盘上。

**看板**（仅 DSH）：让 Agent 调 `plugin_manager` 的 `install_bundle`，`target` 指到
`<仓库路径>/.dsh/plugins/financial-dashboard`（含 `package.json` 的那层），返回 `application: applied` 后刷新 Web GUI。
看板的取数走 `fin-data` 的统一入口，所以 **`fin-data` 技能必须已在位**
（`--skills fin-data`；安装脚本不会替插件装技能）。

**验证**：

```powershell
node "$repo\.dsh\skills\9c\scripts\stock-data.mjs" all 中国平安   # 返回 "ok": true 且 quote.price 是数字
node --test "$repo\.dsh\skills\fin-data\api\test\query.test.mjs"  # 入口离线契约（10 项）
node --test "$repo\.dsh\skills\fin-data\adapter\test\contract.test.mjs"   # 适配器离线契约（24 项）
```

**更新**：仓库根 `git pull` → 用 `--force` 重跑上面的安装命令 → 重启 DSH → 刷新页面。

---

## 2. 怎么用

### 2.1 金融看板（DSH 插件）

装好后左侧栏出现「金融看板」入口，右侧栏开始页出现「金融看板」卡片（副标题「行情」）：

- **左侧栏整页**：点「金融看板」→ 中间列打开整页看板；页内子标签「行情」下是指标卡、自选股列表与近 120 个交易日 K 线；
- **龟龟选股子标签**：按史诗级韭菜的收息口径，每天从**港股通**池里筛出 10 只（股息率 ≥ 4.5%、PE ≤ 12、派息率 ≤ 95%、负债可控、每行业最多 3 只；银行与融资租赁整类回避），列表带市值 / 净现金 / 穿透回报率，「历史选股」可按日期回看；
- **右侧栏标签页**：展开右侧栏 →「金融看板」卡片（副标题「行情」）→ 紧凑版看板；
- **每天 16:05 更新一次**（行情与选股都按这个节奏，页面保留手动刷新按钮）；顶部按钮切换「红涨绿跌 / 绿涨红跌」，选择写入 `localStorage`，亮暗主题跟随宿主；
- 数据走 **fin-data 的统一查询入口**（腾讯行情为主、iFinD 兜底，财报走 `financials` 接口）：上游失败先给缓存并标 `stale`，冷缓存失败给降级态，不白屏；财报若回落到模拟数据，榜单会标 `financialsSource`。

路由、缓存 TTL、构建方式见 [`.dsh/plugins/financial-dashboard/README.md`](./.dsh/plugins/financial-dashboard/README.md)。

### 2.2 史诗级韭菜（`/9c`、`/史诗级韭菜`）

```text
/9c 中国平安这个股票如何
/史诗级韭菜 长江电力
用龟龟法看看 601318
```

输出固定七段：一句话结论 → 先泼冷水 → 商业模式（5 条判据）→ 穿透回报率（算式 + 结果）→
真实可支配现金（正 / 负 / 不可判定）→ 仓位上限 → 数据时点与免责声明。

硬约束：数字只来自本次脚本输出、缺数据就写"缺数据"、不预测短期涨跌、一票否决不因"公司优秀"翻转、
A/H 分开算。人格资产（`persona.md` / `framework.md` / `style.md` / `eval.md`）与 `SKILL.md` 同级，
都在 [`.dsh/skills/9c/`](./.dsh/skills/9c/SKILL.md)。

判例库在 `knowledge/`：视频转写先抽成原子 claim（带 bvid + 秒级时间戳），人工审核后编译成
`knowledge/compiled/active-claims.md`，runtime 只读这一份；原始转写与 prompt 不提交。流程见
[`knowledge/README.md`](./.dsh/skills/9c/knowledge/README.md)。

视频 → 文档 → COS 的流水线：

```bash
node .dsh/skills/9c/scripts/bili-sync.mjs update            # 从上次同步日期增量更新
node .dsh/skills/9c/scripts/bili-sync.mjs list --days 365   # 或首次全量
node .dsh/skills/9c/scripts/bili-sync.mjs subtitles --limit 20
node .dsh/skills/9c/scripts/bili-sync.mjs docs --api-base https://api.deepseek.com/v1 --api-key "$LLM_API_KEY"
node .dsh/skills/9c/scripts/bili-sync.mjs upload --prefix 9c/docs
```

`/9c update` 就是 `update` 那条维护流程；**COS 不是必需的**，没配置 COS 时文档只落本地
`knowledge/docs/`，安装技能时也不会要求 COS 密钥。B 站接口不可达时用 `--list-file` 导入列表，
或设置 `BILI_COOKIE`；没有 LLM key 时只生成 prompt。

> 只维护一个技能名：`/9c` 是真正的斜杠命令，`/史诗级韭菜` 是触发词。拼音别名 `/shichijijiucai` 已取消——
> DSH 的 `/name` 调用按技能名精确匹配，一个技能只能有一个名字，与其维护转发层，不如让正文只有一处。

数据脚本可以单独跑：

```powershell
node .dsh/skills/9c/scripts/stock-data.mjs all 中国平安
node .dsh/skills/9c/scripts/stock-data.mjs resolve 贵州茅台
node .dsh/skills/9c/scripts/stock-data.mjs all hk:02318      # 港股：行情 + 派息公告解析
```

### 2.3 Java 环境准备（`/java-env-prep`、`/环境准备`）

把一份写着数据库连接、各环境 URL、nacos / nexus、git 仓库的资料（Word / Excel / 截图 / 聊天记录都行），
变成能直接开工的机器：生成数据库 MCP 配置、拉 nacos 配置、写浏览器书签、克隆仓库、生成取日志脚本。

```text
/java-env-prep
/环境准备
（也可以直接把资料丢过来，说一句"帮我准备开发环境"）
```

- 默认 dry-run：先 `validate` / `plan`，确认后才 `apply`；
- 克隆的代码落 `<工作目录>/project/<项目名>/`，仓库 `.gitignore` 只忽略这一条；
- **克隆后切到「默认分支之外、最新提交」的远端分支**（`active` 策略，按 committerdate；Git 不记录分支创建时间）；
  想取全部分支里最新的用 `--branch-strategy latest`，想固定在 profile 的 `branch` 用 `--keep-branch`；
- **只克隆最近 30 天有提交的仓库**（`--max-age` 可调，`--max-age 0` 关闭），长期不动的仓库会被跳过并列出最后提交时间；
- **环境准备的产物都在 `<项目>/.env-prep/`**（profile、nacos、书签备份、平台清单、站点脚本与会话）；
  数据库 MCP 条目不在产物里——`apply` 只告诉你 profile 的 `cordis.patch.yml` 在哪，由你手写进去（见 2.7）；
- **没写日志/发布/缺陷平台时自动探测**：先读项目站点脚本（`.env-prep/tools/<站点>/`）与平台登记表
  （`.env-prep/.platforms.json`），
  再看同域平台名（BeeCloud/Jenkins/Grafana/AIO…）并只读浏览器书签；结果写 `<out>/platforms.json` 并合并回
  profile 的 `platforms`/`release`/`bug`。实测 jasolar：BeeCloud 同时是日志与发布，AIO 是缺陷；
  探测有上限（默认 24 次请求），`--no-probe` / `--no-scan` / `--no-bookmarks` 可逐项关闭；
- 需要登录的平台（如 AIO 缺陷页、BeeCloud 日志）会生成**自动登录脚本**：探明登录 → 缓存会话 → **懒加载**（用前先验会话，过期自动重登），不需要先手动登录；
  凭据放 `<项目>/.env-prep/`（已忽略），打法见 [`.dsh/skills/java-env-prep/references/web-login.md`](./.dsh/skills/java-env-prep/references/web-login.md)；
- 写书签要求浏览器退出：会先问「关闭浏览器并写入」还是「导出 HTML 手动导入」，没回答按"不关"处理；
- 细节见 [`.dsh/skills/java-env-prep/SKILL.md`](./.dsh/skills/java-env-prep/SKILL.md)。

### 2.4 项目导览（`/java-project-tour`、`/代码地图`）

在几十个仓库、上万个 Java 文件里，先扫出一份索引，再回答“这个功能在哪、改哪里”：

```text
/java-project-tour
/代码地图
这个项目是干什么的 / 改资产签发要动哪些文件
```

```bash
node .dsh/skills/java-project-tour/scripts/tour.mjs scan --project project/<项目>
```

- 产物在 `<项目根>/.knowledge/`：仓库与依赖（`inventory.json`）、入口（`entries.json`：HTTP / Dubbo / 定时任务 / MQ / Feign）、
  表读写（`data.json`）、功能点（`features.json`）、业务流程到处理类（`flows/`）；
- **没有工作流引擎的项目也能用**：`features` 把入口按「HTTP 首段 / 包里的业务包 / 任务名前缀」聚合成功能点，
  并过滤掉 `getById`、`allList`、`count` 这类通用 CRUD 端点；有流程定义时则一流程一项；
- **可选：用数据量校验核心功能**：`db queries` 生成只读 SQL（默认走 qa/test 测试库，不碰研发库），把行数存成 JSON 后
  `db ingest` 推断 5–10 个核心功能，日志/历史/引擎表会被过滤；
- 实测 30 个仓库、11,555 个 Java 文件，扫描约 30 秒；
- **核心机制**：`core.json` 标记核心功能点 / 核心流程 / 核心类 / 核心表，后续技能先读 `core.md` 再查全量索引，
  `find` 命中的核心项带 `★` 并优先排序；
- 查询：`find <关键词>`、`where "<改动意图>"`、`context <path>`、`status`；
- 只读：不执行构建、不写业务代码；连库只用于「取表行数」的只读查询（走数据库 MCP，`SELECT` /
  `information_schema`，优先 qa/test），不改数据、不改配置；细节见 [`.dsh/skills/java-project-tour/SKILL.md`](./.dsh/skills/java-project-tour/SKILL.md)。

### 2.5 需求分析（`java-requirement-analysis`）

把一份需求文档拆成能排期、能开发、能验收的清单：

```text
/java-requirement-analysis
（贴需求文档，或说“分析 docs/PRD.docx 这个需求”）
```

```bash
node .dsh/skills/java-requirement-analysis/scripts/req.mjs init --project project/<项目> \
  --version 3.0.0 --slug jasolar-saas --title "本地化转SaaS对接" --source "docs/PRD.docx"
node .dsh/skills/java-requirement-analysis/scripts/req.mjs estimate .requirements/req-v3.0.0-jasolar-saas/requirement.json
node .dsh/skills/java-requirement-analysis/scripts/req.mjs validate .requirements/req-v3.0.0-jasolar-saas/requirement.json
```

- **先归业务域**（客户与建档 / 产品与开通 / 额度 / 资产与开立 / 流转融资 / 作废 / 兑付 / 查询 /
  报送 / 通知 / 渠道 / 平台），**再标技术大类**（api / model / schema / flow / ui / auth / job / mq / integration /
  config / query / nfr），报告先给域分布（业务视角）再给类分布（技术视角），最后拆「可独立验收」的子需求；
- **需求文档 = 正文 + 内嵌图片 + 附件**：Word 里的流程图/原型图、接口文档表格（Excel/Word/Markdown/Swagger 导出）、
  DDL 与报文样例都登记成 `sources` 并纳入分析，接口字段与错误码以附件为准；
- 改动点对照 `.knowledge/` 给 `path:line` 与置信度；新功能给到 `layer / className / methods / package / 参照类`；
- 每个子需求按改动点估 P50 / P90 人天（`estimate` 重算，不手填），需求级汇总含 10% 评审统筹；
- 文档没说清、代码里找不到的，全部进澄清问题（P0 阻塞 / P1 影响估时 / P2 可后置）；P0 未清零时状态只能是 `draft`；
- **需求 id 按版本命名**（`req-v3.0.0-<短名>`），先剔除画线删除与下版本章节，再对流程图/原型图做图片识别、落成节点与分支；
- 产物在 `<项目根>/.requirements/<需求 id>/`：`requirement.json`（事实来源）+ `analysis.md`（人读报告），默认不入库。

### 2.6 iFinD 数据源（可选）

同花顺 MCP，给行情做兜底与交叉校验；不接也能正常用（行情走腾讯）。接入后 `.dsh/skills/fin-data/adapter/providers/ifind.mjs`
把官方技能包的 `call-node.js` 包成 provider，只吃结构化快照（`stock_highfreq_quotes` 的 `real_time`）。
技能目录按 `IFIND_SKILL_DIR` → 仓库 → `~/.dsh/skills` → `~/.agents/skills` → … 的顺序查找。
装法、密钥与自检见安装引导第 4 步。

### 2.7 MCP 配置（手写在 profile patch 里）

自研技能与插件用到的 MCP server（MySQL dev/qa/uat、腾讯云 COS）**没有单独的配置文件**：
条目直接写在 DSH profile 的 `cordis.patch.yml` 里，值（含账号密码）就是最终传给 MCP server 子进程的 `env`。

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-mysql-jasolar-dev
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mysql_jasolar_dev        # 工具前缀 mcp__mysql_jasolar_dev__*
        transport: stdio
        command: npx
        args: ['-y', '@benborla29/mcp-server-mysql']
        failOnStartupError: false
        env:
          MYSQL_HOST: "10.0.0.11"
          MYSQL_PORT: "3306"
          MYSQL_USER: "readonly"
          MYSQL_PASS: "****"
          MYSQL_DB: "order_db"
```

- **位置**：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（默认 `~/.dsh/profiles/desktop/cordis.patch.yml`）；
  `java-env-prep apply` 会在输出的 `mcpPatch` / `mcpHint` 里直接给出这个路径；
- **格式**：顶层是 entry 数组，用 `- insert:` 包一批条目；`config.serverName` 决定
  `mcp__<serverName>__*` 前缀，不能重名；
- **生效**：DSH 的 HMR 监听 profile patch（`@deepseek-ai/dsh-hmr`），保存后一般几秒内重组；
  没生效再重启 DSH；
- **安全**：这里是明文凭据。profile 目录是本地状态，不要提交、不要整目录分享或截图；
- 第三方技能（iFinD）不在这里，它有自己的 `mcp_config.json`，见 2.6；
- 不想要某个 server：删掉对应 `- insert:` 里的条目即可（没有托管块，不需要同步工具）。

---

## 3. 仓库结构

```text
.dsh/                              仓库里只有这一个 .dsh，插件 / 技能都在它下面
.dsh/plugins/financial-dashboard/  看板插件（bundle 根，含 package.json / cordis.patch.yml）
.dsh/skills/install-skills.mjs     安装器（装技能，不再需要共享目录）
.dsh/skills/9c/                    人格技能：SKILL.md + persona / framework / style / eval
.dsh/skills/9c/scripts/            stock-data / bili-sync / cos-upload / cos-mcp-smoke / knowledge
.dsh/skills/java-env-prep/         环境准备技能：SKILL.md + scripts/env-prep.mjs + references/
.dsh/skills/java-project-tour/     项目导览技能：SKILL.md + scripts/tour.mjs + references/schema.md
.dsh/skills/java-requirement-analysis/ 需求分析技能：SKILL.md + scripts/req.mjs + references/change-taxonomy.md
.dsh/skills/fin-data/              A 股日线技能 + 统一取数入口：findata/ + data/（上证50 种子集）+ api/ + adapter/
SKILL_INSTALL_GUIDE.md             写给 Agent 的安装引导（支持点名只装某一块）
```

**关键约定**：每个技能自包含——脚本在 `<skill>/scripts/` 下，数据在 `<skill>/data/` 下，
技能之间不共享目录。`fin-data` 的内部适配器在 `.dsh/skills/fin-data/adapter/`，只被 fin-data 的 `api/` 引用。

---

## 4. 数据层（统一取数入口）

**唯一取数入口在 fin-data 技能里**：`.dsh/skills/fin-data/api/index.mjs`（JS 门面）与
`api/cli.mjs`（命令行外壳），契约 `fin-data.query/v1`，字段说明见
[`.dsh/skills/fin-data/api/README.md`](./.dsh/skills/fin-data/api/README.md)。

9c 与金融看板都只从这一个入口取数；`.dsh/skills/fin-data/adapter/` 退为入口的内部适配器，不再被消费方直接引用。

```js
import { query, queryMany } from './.dsh/skills/fin-data/api/index.mjs';

const r = await query({ kind: 'quote', instrument: 'hk:02318' });
// r.data  → 归一化行情（A 股与港股同构，只有 currency 不同）
// r.meta  → { source, asOf, fetchedAt, cached, stale, mock, degraded }
```

```powershell
node .dsh/skills/fin-data/api/cli.mjs status
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --periods 4
node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --source mock
node .dsh/skills/fin-data/api/cli.mjs query --kind bars --code 600519 --source local --limit 120
```

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 统一入口 | `.dsh/skills/fin-data/api/index.mjs` | `query()` / `queryMany()` / `describe()`，信封、as-of、mock 标记 |
| 财报接口 | `fin-data/api/financials.mjs` | 三大表 + 指标；真实指标优先，取不到回落 `mock-financials.mjs` |
| 本地日线 | `fin-data/api/bars-local.mjs` | 读 `data/daily/` 的 CSV（不复权），`source=local` 时使用 |
| 适配器路由 | `.dsh/skills/fin-data/adapter/index.mjs` | `get()`、provider 注册表、失败回退、缓存与 stale 兜底 |
| 策略 | `.dsh/skills/fin-data/adapter/policy.mjs` | 支持哪些 kind、各类 TTL、每个 kind 的 provider 优先顺序 |
| 身份 | `.dsh/skills/fin-data/adapter/instruments.mjs` | `cn:601318` / `hk:02318` 解析（由 fin-data 入口再导出） |
| 缓存 | `.dsh/skills/fin-data/adapter/cache.mjs` | TTL + LRU 上限；过期条目保留给 stale 读取 |
| 上游 | `.dsh/skills/fin-data/adapter/providers/*.mjs` | tencent（A/H 行情、日线、名称搜索、汇率）、eastmoney（A/H 财务与年报、A 股分红）、eastmoney-ann（公告列表 + 港股分红公告解析）、ifind（iFinD MCP 实时快照）、private（私有库 stub） |

入口支持的数据种类：`status` `quote` `bars` `financials` `dividends` `annual` `universe` `fx` `search` `announcements`。
单只标的用 `query()`，一组标的（自选股）用 `queryMany()`——后者会先向支持批量的 provider 要一次，
避免 N 次往返。`fx` 用于跨币种换算，例如 `query({ kind: 'fx', pair: 'HKDCNY' })`；
`universe` 取标的集合，例如 `query({ kind: 'universe', options: { id: 'hk-connect' } })`
（看板的港股通过滤也走这里，不再自己打东财板块接口）。

**财报（`financials`）** 是本次收束出来的新接口：金额单位统一为元，按报告期返回
`income` / `balance` / `cashflow` / `ratios` / `shares`。真实指标优先（东财 F10），
真实源不可用时回落**模拟数据**（`meta.mock: true`，每个报告期带 `source: 'mock'`），
真实完整三表的接入属于后续工作，届时只替换 provider，不动 9c 与看板。
港股净现金（现金类 − 有息负债）也在这个接口里，看板不再自己拼资产负债表。

**港股分红**没有结构化报表，走港交所派息公告解析（`.dsh/skills/fin-data/adapter/dividend-parse.mjs`）：公告正文是固定标签表，
正则确定性抽取「每股派息 / 宣派币种 / 除净日 / 派息日」，噪声公告按"是否含宣派金额"过滤，
"(更新)"版按「报告期末 + 股息类型」去重取最新。

---

## 5. 开发与验证

**契约测试**（离线，用 `.dsh/skills/fin-data/adapter/test/fixtures/` 里固化的上游响应）：

```powershell
node --test .dsh/skills/fin-data/api/test/query.test.mjs   # 入口契约（离线，8 项）
node --test .dsh/skills/fin-data/adapter/test/contract.test.mjs               # 适配器 fixtures
node .dsh/skills/9c/scripts/stock-data.mjs all 中国平安                # 9c 取数（需要网络）
```

上游改字段时测试会变红——这是唯一低成本的防线。

**跨源核对**（同时向腾讯与 iFinD 各取一次，逐字段比价格、市盈率、市净率、总市值）：

```powershell
node .dsh/skills/fin-data/api/verify-quotes.mjs              # 默认核对 601318 / 600519
node .dsh/skills/fin-data/api/verify-quotes.mjs 601318 000001 --threshold 1
```

偏差超阈值即退出码 1——"换数据源改坏了"最快的报警方式。

**接入私有数据库**：实现 `.dsh/skills/fin-data/adapter/providers/private.mjs` 的 `fetch()`，在 `capabilities` 里声明它能答哪些
kind / market 即可。`.dsh/skills/fin-data/adapter/policy.mjs` 已把 `private` 排在财务类第一位，声明后自动生效，公开源退为兜底与交叉校验。

**看板插件**：在 `.dsh/plugins/financial-dashboard/` 下 `npm run build`（下载并内联 ECharts 5.6.0）、`npm test`
（真实上游 + mock ctx 跑路由自测）。生成产物 `client.js` 随仓库提交，不要手改其中内联的 ECharts 段落。

**加一个新技能**：复制 `.dsh/skills/9c/` 为 `.dsh/skills/<新名字>/`，改 `SKILL.md` 的 frontmatter 与
`persona.md`，在 [`SKILL_INSTALL_GUIDE.md`](./SKILL_INSTALL_GUIDE.md) 的技能清单里补一行——之后就能用
`--skills <新名字>` 单独装。

---

## 6. 约定与边界

- 每个插件目录是一个独立 npm 包，自带 `package.json`、`cordis.patch.yml`，按需声明 `dsh.client`；
- 生成产物（如 `client.js`）随仓库提交，源码与构建脚本一并保留，便于改完重建；
- 根目录 `.gitattributes` 统一行尾为 LF，并把 `client.js` 标记为 `-text`，保证跨机器逐字节一致；
- `.dsh/skills/` 是项目级技能目录，DSH 按最近的 `.git` 祖先定位项目根后自动发现，改动即时生效；
- 每个技能自包含（脚本、数据都在自己的目录里），`install-skills.mjs --mode copy` 只复制技能目录本身，
  所以技能装完不依赖仓库在盘上；**9c 依赖 fin-data**：装 9c 时安装器会把 `fin-data` 一起装上，
  单独装看板时也要保证 `fin-data` 在位；
- MCP 条目手写在 profile 的 `cordis.patch.yml`（见 2.7），仓库里不放凭据；`java-env-prep apply`
  会输出该文件的路径（`mcpPatch`），方便直接去补条目；
- `project/` 是环境准备克隆代码的隔离层（已忽略），凭据与 profile 不要提交。

**边界**：本仓库代码为 MIT；iFinD 技能包属第三方，不随仓库分发；行情来自公开接口，仅限个人自用；
人格分析输出为方法论模拟，不构成投资建议。
