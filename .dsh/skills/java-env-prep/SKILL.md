---
name: java-env-prep
description: Java 项目环境准备。用户输入 /java-env-prep、/env-prep、/环境准备，或直接给出一份包含数据库连接、各环境 URL、nacos/nexus 地址、git 仓库地址的文档/表格/图片/聊天记录时使用。把资料抽取成 env-profile.json，再拉取 nacos 配置、在浏览器打开各环境、克隆仓库、并探测内部日志平台生成取日志脚本；数据库连接不写 MCP 配置，apply 只提示 profile 的 cordis.patch.yml 位置，由用户按模板手写条目。用户没写日志/发布/缺陷平台时，会自动探测入口（已知套件、项目站点脚本、平台登记表、浏览器书签、同域候选）并保存到 platforms.json。也用于给需要登录的内部平台（缺陷系统、发布平台、日志平台等）写自动登录脚本：用户给一个网址 + 账号密码，或说“写个自动登录/拉一下我的缺陷/bug 列表”时使用。
---

# Java 环境准备

把「一份包含环境信息的资料」变成「一台能直接开工的机器」。输入可能是 Word、Excel、图片截图，
输出是一组已经执行完的动作 + 一份可复现的 `env-profile.json`。

**核心原则：资料里没有的，就问；资料里有的，不猜。**

**交互原则：所有确认都在对话里完成（`ask_user_question`），不要为了等用户输入而新开终端窗口。**

## 目录约定

```
<当前工作空间>/                            # git.dir：各仓库直接平铺在当前工作空间（如 D:\harnessworkspace\jasolar）
<当前工作空间>/.env-prep/                  # outDir：本技能的全部产物
├── env-profile.json                      # 唯一输入 + 探测结果
├── nacos/  bookmarks/                    # 配置、书签备份
├── platforms.json                        # 日志/发布/缺陷平台入口
├── .platforms.json                       # 平台登记表（跨次探测复用，不含凭据）
├── tools/<站点>/<站点>.mjs               # 登录 + 取数脚本、会话
└── <站点>-credentials.json               # 凭据（git 忽略）
```

`git.dir` 直接指向**当前工作空间**（通常是用户为该项目专门新建的工作空间，如 `D:\harnessworkspace\jasolar`），
各子工程作为它的子目录平铺，**不再额外套 `project/<项目名>` 一层**。本技能的产物（含凭据）一律写进 `.env-prep/`，
`.gitignore` 忽略 `.env-prep/` 即可；克隆下来的各仓库由它们自己的 `.git` 管理。

这两个路径写在 profile 的 `git.dir` 和 `outDir` 里，脚本不再依赖当前工作目录。

## 〇、怎么触发

三种都行，效果一样：

| 写法 | 说明 |
| --- | --- |
| `/java-env-prep` | 技能的本名（kebab-case），真正的斜杠命令 |
| `/env-prep` | 短别名，写在描述里，模型据此加载 |
| `/环境准备` | 中文写法，同上；不是命令名，但能被识别 |

也可以**不带斜杠**，直接把资料丢过来并说一句"帮我准备开发环境"——描述里已经写明这类输入归本技能处理。

**资料怎么给**：

- 附件 / 拖拽文件：直接读，Word 用 docx、Excel 用 xlsx、图片用图片读取；
- 粘贴文本或表格：直接贴，按 `references/profile-schema.md` 的字段抽；
- 只给一个路径：说明路径即可。

**不需要你先把资料整理成 JSON**——抽取是本技能的第一件事，你只要保证资料里有信息。


## 一、七类输入 → 六类动作

| 输入 | 动作 | 落点 |
| --- | --- | --- |
| 数据库（MySQL 等） | `apply` 输出 `mcpPatch` / `mcpHint`，提示 MCP 条目该手写到哪里 | profile 的 `cordis.patch.yml`（本机，含凭据） |
| nacos | 拉取配置 + 收进书签 | `<out>/nacos/<id>/<group>__<dataId>` |
| 各环境 URL、nexus | **写入浏览器书签**（项目名文件夹 + 分类） | Chromium 系直接改 `Bookmarks`；运行中退回可导入的 HTML |
| git 仓库 | `git clone` 到指定目录（**只克隆最近 30 天有提交的仓库**），然后切到“正在开发”的分支 | 目标目录 |
| 内部日志平台 | 探测接口 + 生成取日志脚本 | `<out>/logs/fetch-logs-<id>.mjs` |
| **日志/发布/缺陷平台（用户没写入口）** | **自动探测入口并保存**（站点脚本 / 已知套件 / 平台登记表 / 书签 / 同域候选） | `<out>/platforms.json` + profile 的 `platforms`/`logs`/`release`/`bug`；登记表 `<out>/.platforms.json` |
| 需要登录的 Web 系统（缺陷/发布/日志平台…；**资料里任何「网址+账号密码」都算**） | 后台异步探明登录方式，生成**懒加载**自动登录脚本并缓存会话 | `<项目>/.env-prep/tools/<站点>/<站点>.mjs`，凭据放 `<项目>/.env-prep/` |

**克隆完切分支（默认行为）**：`git clone` 之后执行一次
`git for-each-ref --sort=-committerdate refs/remotes/origin`，然后按策略选一条分支
（`git switch -C <branch> --track origin/<branch>`）：

| 策略 | 选谁 | 适用 |
| --- | --- | --- |
| `active`（默认） | **排除远端默认分支**（`origin/HEAD`）后，取最新提交的那条 | 默认分支是发布线，功能分支才是开发面 |
| `latest` | 全部分支里最新提交的那条 | 默认分支就是主开发线 |
| `profile` | 不切，保持 profile 的 `branch` / 远端默认分支 | 需要固定在某个发布分支 |

```bash
--branch-strategy active|latest|profile     # 默认 active
--keep-branch                               # 等价 --branch-strategy profile
```

Git 不记录分支创建时间（`%(creatordate)` 对分支就是 tip 时间，克隆后远端分支也没有 reflog），
所以只能用最新提交时间近似。结果里写明 `strategy` / `defaultBranch` / `from → branch` / `top` 候选，
**每次切换都报告出来，不要悄悄换分支**。

浅克隆也支持：`--depth` 会隐含 `--single-branch`，active / latest 策略下脚本显式加 `--no-single-branch`，
每条分支的 tip 时间仍然可用。

**只克隆活跃仓库（默认行为）**：克隆前先探一次远端最后一次提交，**最近 30 天内没有提交的仓库直接跳过**：

```bash
--max-age 30          # 默认；改天数用这个
--max-age 0           # 或 --no-age-filter：关闭过滤，全部克隆
```

- 探测用 `git fetch --depth 1 --filter=blob:none`（只取提交与树，不拉文件内容），**不落盘、不动工作区**；
  服务端不支持 filter 时自动退回 `--depth 1`；
- 跳过的仓库在结果里带 `skipped: true`、`lastCommit` 和一行原因，报告时要列出来（别只说"克隆完成"）；
- 探测失败（网络/权限）→ **照常克隆**并标 `ageUnknown: true`，不因为探不到时间就丢仓库。

**平台自动探测（默认行为）**：日志、发布、缺陷是真实 Java 项目的“必备三件套”。用户没写入口时，
按下面的证据链自动找，找到就存下来，后续动作与技能直接读，不再重复问：

| 证据 | 说明 |
| --- | --- |
| 项目站点脚本 | `.env-prep/tools/<站点>/<站点>.mjs` 里的 `const BASE = 'https://…'`；**只静态读，不执行** |
| profile 已保存 | `platforms` / `logs` / `release` / `bug` 里 `detected: true` 的条目 |
| 用户提供 | 任何 URL + 名字/备注命中平台关键词（日志/发布/缺陷/构建/Jenkins/Jira…） |
| 已知套件 | BeeCloud=日志+发布、AIO=缺陷、Jenkins=发布、Grafana=日志、Jira/禅道/TAPD=缺陷 |
| 页面特征 | 抓标题/正文里的 `BeeCloud`/`应用观测`/`qaBug`/`DevOps` 等 |
| 平台登记表 | `<out>/.platforms.json`，同一 outDir 重复探测时复用（不含凭据） |
| 浏览器书签 | 只读 Chrome/Edge/Brave 书签，按已知套件或同域筛选 |
| 同域候选 | 固定平台名 + profile 出现过的协议/端口，默认上限 24 次请求 |

安全边界：只探测 profile 里**已经出现过的域名**，不扫 IP 段、不试密码；`--no-probe` / `--no-scan` /
`--no-bookmarks` 可逐项关闭。**探不到就报 `missing`，带着候选清单问用户要 URL，不要编一个。**

书签结构固定为三层：

```
<项目名>/
├── 环境/      dev 开发环境、test 测试环境
├── 配置中心/  nacos-dev
├── 制品库/    nexus (maven-releases)
├── 日志/      内部日志平台
├── 发布/      发布/流水线平台
└── 缺陷/      缺陷/项目管理平台
```

「分类」本身就是一次推断：域名里带 `nacos` 的是配置中心，带 `nexus`/`artifactory` 的是制品库，
带 `log`/`kibana`/`graylog`/`elk` 的是日志平台，带 `dev`/`test`/`uat`/`prod` 的是环境地址。
推断不出来的，**列出来问用户**，不要硬塞进某一类。

## 二、执行流程

### 第 1 步：读资料，抽成 profile

按 `references/profile-schema.md` 的字段抽取，写成 `env-profile.json`。要点：

- 一个数据库一条记录，`id` 用 `<kind>-<env>`（如 `mysql-dev`）；
- 密码、账号照抄，**不要试连**；
- 表格里一行一个环境的，拆成多条 `environments`；
- 图片里的信息，逐项核对后再写，看不清的标 `"<待确认>"`；
- **同时扫一遍「网址 + 账号密码」的组合**：每出现一对，就起一个后台探明任务（见三 3.1），
  **不要等它跑完**，主线继续；同一系统多套账号只取一套（优先 admin）；
- 抽完把「你从资料里读到了什么」列给用户确认，再往下走。

### 第 1.5 步：确认项目名（只在对话框里问）

项目名决定书签文件夹名和输出目录。默认**从仓库名推断**，不假设工程怎么命名：
把每个仓库名按 `-` 切段、取第一段统计，某个第一段覆盖 ≥60% 的仓库时就取它。

没有公共前缀时退回 git 组名（URL 最后一段）。

**不要为了确认去开终端窗口。** 确认一律走对话：

1. `ask_user_question` 提两个选项：
   - **「用 <推断值>」（推荐）** —— 运行时换成实际推断出的项目名，别照抄占位符
   - **「我自己输入」**
2. 用户选后者 → 再发一个**不带 options** 的问题，让用户直接在输入框里填；
3. 用户没回答、或回答"随便/默认" → 直接用推断值，**不要反复追问**；
4. 对话里没有超时机制，所以"30 秒默认"的语义是：**用户没有明确给出名字时就用推断值**。

命令行侧不需要额外操作——脚本会自己推断；只有用户给了自定义名字时才加参数：

```bash
node scripts/env-prep.mjs plan <env-profile.json> --project my-project
```

### 第 2 步：校验

```bash
node scripts/env-prep.mjs validate <env-profile.json>
```

`problems` 非空先补资料，**不要带着缺失字段往下跑**。

### 第 2.5 步：缺库名时，从 nacos 配置推断

资料常常只给 `IP:端口 + 账号`，不给库名。应用自己的配置里几乎一定有
`jdbc:mysql://host:port/schema`，所以**先拉配置、再推断**：

```bash
node scripts/env-prep.mjs apply <env-profile.json> --only nacos --out .env-prep
node scripts/env-prep.mjs infer <env-profile.json> --out .env-prep
```

推断规则（固定，避免每次拍脑袋）：

1. 抽 `jdbc:mysql://…/schema`，**跳过 `${…}` 占位符**（未解析的不算证据）；
2. 某条库的 `host:port` 能对上 JDBC 里的 host → 直接用那个 schema；
3. 对不上 → 取「带项目前缀 + 引用次数最多」的 schema 作为默认；
4. 一个 MySQL 实例上通常有多个 schema，自动推断只是**候选**——能确定就显式覆盖：

```bash
node scripts/env-prep.mjs infer <env-profile.json> --database <库名>
```

`infer` 会把结果写回 profile，并打印候选清单（`topSchemas`），供你复核。

### 第 2.7 步：缺日志/发布/缺陷平台时，自动探测入口

这三类平台是 Java 项目的“必备三件套”。先看 profile 里有没有，没有就自动探测：

```bash
node scripts/env-prep.mjs discover <env-profile.json>
node scripts/env-prep.mjs platforms <env-profile.json>   # 只读已保存结果，不探测
```

- `discover` 写 `<out>/platforms.json`，并把主入口合并回 `profile.platforms` / `logs` / `release` / `bug`
  （改 profile 前备份为 `env-profile.json.bak`）；同时更新登记表 `<out>/.platforms.json`；
- **`apply` 全量执行时，缺平台会自动先跑一次探测**（`--no-discover` 关闭；`--no-probe` / `--no-scan` /
  `--no-bookmarks` 逐项收紧）；
- 每个类型给一个主入口 + 至多 3 个 `alternates`，带 `confidence`：
  `script` > `saved` > `provided` > `suite` > `signature` > `registry` > `bookmark` > `hostname`；
- 探测到 `tools` / `command` 时直接指向已有站点脚本（BeeCloud 日志、AIO 缺陷），后续不用再找接口；
- **探不到就落在 `missing`**：报告缺哪一类，带着候选清单问用户要 URL，不要编；
- 汇报时附一张矩阵：

```text
平台矩阵
  日志  BeeCloud  http://beecloud...:1040  script（.env-prep/tools/beecloud/beecloud.mjs）  alternates: grafana
  发布  BeeCloud  http://beecloud...:1040  script
  缺陷  AIO       https://aio...           script（.env-prep/tools/aio/aio.mjs）
```

### 第 3 步：出计划，给用户看

```bash
node scripts/env-prep.mjs plan <env-profile.json>
```

计划里会列出：要收藏几个链接、克隆几个仓库、拉几个配置；数据库只提示 MCP patch 位置，不写配置；
缺平台时最前面会多一个 `discover` 动作。用户确认后再执行——**写书签和克隆仓库都是有副作用的动作**。

### 第 4 步：执行

```bash
node scripts/env-prep.mjs apply <env-profile.json> --only bookmark,clone,nacos,logs
```

- 默认输出到 profile 的 `outDir`（没设就是当前目录的 `.env-prep/`），可用 `--out` 改；
- 单个动作失败不阻断其他动作，最后看 `results[].ok`；
- 密码在输出里永远是 `***`。

**书签这一步有两种结果**，看浏览器是否在运行：

| 情况 | 结果 |
| --- | --- |
| Chrome/Edge/Brave 已退出 | 直接写 `Bookmarks`，先备份到 `<out>/bookmarks/*.bak.json`，按 URL 去重，重复执行不会重复添加 |
| 浏览器正在运行 | 先问用户能否关闭（见下），允许并关闭后写文件；否则导出 `<out>/bookmarks/<项目名>-bookmarks.html` |
| 没有 Chromium 系浏览器 | 同上，导出 HTML |

**关闭浏览器的确认（也在对话里问，不开窗口）**：

1. `ask_user_question` 问，**把"关闭"作为推荐项**（放第一个、label 带「推荐」）：

   | 选项 label | 含义 | 用户选了之后 |
   | --- | --- | --- |
   | `关闭 Chrome 并写入书签（推荐）` | 直接写进浏览器书签，一次到位 | 带 `--close-browser --force-close`，脚本自己关 |
   | `不关，导出 HTML 让我手动导入` | 浏览器不动，多一步手动导入 | 只带 `--bookmark-mode html` |

2. 用户点「关闭」→ 执行时带 `--close-browser --force-close`，脚本直接关，**不需要终端**；
3. 用户点「不关」→ 只带 `--bookmark-mode html`，导出一份可导入的文件；
4. 用户没回答 → 按"不关"处理（导出 HTML），**不要擅自关掉别人的浏览器**（推荐 ≠ 默认）。

```bash
# 对话里已确认关闭
node scripts/env-prep.mjs apply <profile> --only bookmark --bookmark-mode file \
  --close-browser --force-close

# 用户选择不关
node scripts/env-prep.mjs apply <profile> --only bookmark --bookmark-mode html
```

> 脚本里还保留了一条"终端倒计时"路径（`--close-browser --confirm-timeout 30`），
> 只有在**你自己开终端敲命令**时才有意义；Agent 调用时一律用 `--force-close`，
> 不要为了倒计时而新开 cmd/powershell 窗口。

可用 `--bookmark-mode file|html` 强制指定。导入 HTML：浏览器「书签管理器 → 导入书签」。

### 第 4.5 步：给已克隆的仓库补切分支（可选）

clone 阶段会自动切分支；如果目录是**规则改动之前**克隆的（当时还是单分支），用 `branch` 补切：

```bash
node scripts/env-prep.mjs branch <env-profile.json> --dry-run   # 先看会切到哪条
node scripts/env-prep.mjs branch <env-profile.json>             # 执行
node scripts/env-prep.mjs branch <profile> --no-fetch           # 刚 fetch 过，跳过拉取
```

- 规则与 clone 一致：`active`（排除默认分支取最新提交）/ `latest` / `profile`；
- 会先 `git fetch` 把远端分支补齐（单分支克隆也能看到其它分支）；需要凭据时用 profile 的账号密码，
  **只用于那一次 fetch，不写进 `.git/config`**；
- 工作区有未提交改动 → 跳过该仓库，**不 stash、不覆盖**；
- 输出逐仓库的 `from → branch`、日期、候选数；`fetch: "failed"` 说明远端没拉全，结论按旧引用算。

### 第 5 步：收尾

1. **MCP 位置**：`apply` 不写任何 MCP 配置，只在输出里给 `mcpPatch`（profile 的 `cordis.patch.yml`）
   和 `mcpHint`。**必须把 `mcpPatch` 告诉用户**，按模板把数据库条目手写进该文件的顶层数组；
   保存后 DSH 的 HMR 一般几秒内重组，没生效再重启（工具前缀 `mcp__mysql_<项目名>_<环境>__*`）。
   不要猜密码、不要试连；`<填入>` 这类占位符要提醒用户替换；
2. **日志脚本**：`<out>/logs/fetch-logs-<id>.mjs` 是骨架，按探测出的候选接口补全，
   Cookie 走环境变量 `LOG_PLATFORM_COOKIE`，不要写死在文件里；如果平台探测已指向站点脚本
   （`log.tools`，如 `.env-prep/tools/beecloud/beecloud.mjs`），生成的是**转发脚本**，不再重复造轮子；
3. **分支**：逐仓库报告落在哪条分支（`results[].branch`：`from → branch`、`basis`、提交时间）；
   **跳过的仓库**（长期无提交 / 目录已存在 / 探不到时间）也要列出来，附 `lastCommit` 与原因；
   切换失败的仓库要单独说明原因，别只说"克隆成功"；
4. **书签**：告诉用户是"已写入浏览器"还是"需要导入 HTML"，以及备份在哪；新增的 `发布/`、`缺陷/`
   分类也要一并说明；
5. **平台入口**：`<out>/platforms.json` 是后续技能直接读的入口清单（`platforms.log/release/bug`），
   `<out>/.platforms.json` 是平台登记表（只存 URL 与类型，不含凭据）；`missing` 里的类型要明确告诉用户；
6. **告知用户**：哪些动作成功、哪些失败、哪些需要他补信息。

## 三、通用能力：给任意 Web 系统写自动登录脚本

### 3.1 硬规则：资料里出现「网址 + 账号密码」就后台异步探明

用户给的资料（文档、表格、截图、聊天记录、正文）里，**只要出现成对的网址和账号密码**，
不论它是不是本次环境准备的主线内容，都要为它走一遍自动登录流程。

**异步执行，不要卡住主线**：

1. 读资料时先扫一遍，列出所有「网址 + 账号」组合（同一个系统多套账号只取一套，优先 admin）；
2. 主线（`validate → plan → apply`：库、nacos、书签、克隆）继续跑，**不要等探明结果**；
3. 把每个站点的探明作为**后台任务/子代理**并发启动，一个站点一个任务；
4. 全部跑完（或用户追问时）再汇报，不影响主线已经完成的动作。

每个站点的交付物固定：

```text
<项目>/.env-prep/tools/<站点>/<站点>.mjs          # 登录 + 业务取数脚本（懒加载）
<项目>/.env-prep/<站点>-credentials.json          # 账号密码（git 忽略）
<项目>/.env-prep/tools/<站点>/session.json        # 会话缓存（等同半个密码）
```

> 同一技能的产物都收在 `.env-prep/`：配置、凭据、平台清单、取数脚本、会话。

**完成判定**（缺一不算探明成功）：

- [ ] 登录返回成功，且拿到会话 cookie / token；
- [ ] 用**一个真实业务接口**验证过（不是只看登录接口 200）；
- [ ] `session` 命令能打印 `login` / `reused` / `relogin` 三种状态；
- [ ] 凭据与会话都没出现在 stdout、日志、git 里。

**失败的四种收尾**（不要硬撑，也不要重试到锁号）：

| 情况 | 收尾 |
| --- | --- |
| 登录必须图形验证码 / 短信 / OTP | 降级半自动：让用户在浏览器登录一次，脚本复用 cookie；说清限制 |
| 账号密码被拒 | 立即停，报原始 message，**不重试**（多数平台有失败次数限制） |
| 站点需要 VPN / 内网 / 特定 host | 报“网络不可达”，不猜地址，不算安装失败 |
| 探明不了登录方式 | 保留已探到的接口清单，写“未完成探明”，把下一步调查方向列出来 |

**汇报格式**（主线结束时附一张矩阵，失败项单独列）：

```text
自动登录矩阵
  AIO 缺陷平台     ✅ 已探明（OAuth2，脚本 .env-prep/tools/aio/aio.mjs，会话 reused）
  BeeCloud 日志    ✅ 已探明（本地账号 JWT，脚本 .env-prep/tools/beecloud/beecloud.mjs，会话 reused）
  XX 发布平台      ⚠️ 未完成：需要短信验证码（已生成骨架，待人工过一次）
```

### 3.2 实现要点

用户给出「网址 + 账号密码」时，交付一个**能复用会话**的脚本：用之前先看有没有登录过，没有才登录，
过期了才重登——**默认懒加载，不建定时任务**。
完整打法见 [`references/web-login.md`](./references/web-login.md)，骨架见
[`templates/auto-login.mjs`](./templates/auto-login.mjs)。要点：

1. **先探明，再写码**：`curl -D -` 看 302 / `Set-Cookie`；返回 JSON 业务码（如 `01100 会话已过期`）说明那是 API 不是页面；
   抓 HTML 引用的 JS，在 bundle 里搜 `/api/`、`/sso/api`、`login`、`access-token`、`Authorization`、`publicKey`；
2. **判定认证类型**：表单/JSON 登录 → Cookie；返回 token → `Authorization: Bearer`；
   302 到 `auth.<domain>/sso/api/v1/authorize` → OAuth2 授权码（`/login?req=…` → `POST /sso/api/v1/login` → `callback` → 应用侧换 Cookie）；
   有验证码/短信/OTP → **不能全自动**，先跟用户说清楚；
3. **四件套**：CookieJar + 登录后校验 + 过期（401/`01100`）自动重登一次 + 登录被拒**立刻停**（有锁号风险，禁止重试）；
4. **凭据**：环境变量优先，其次 `<项目>/.env-prep/<site>-credentials.json`（已 git 忽略）；
   不打印、不进日志、不提交；会话 `session.json` 等同于半个密码，也别外发；
5. **懒加载**：每次用之前 `ensureSession()` —— 无会话→登录、有会话→探活、过期→重登；
   探活接口要“必须登录才能访问且便宜”（如 `/auth/me`），且探活请求体要合法，否则会被误判成过期；
   不要让用户先手动登录，也不要默认排定时任务（需要定时再单独加）。
6. **沉淀差异**：同一套引擎，只把站点差异（URL、字段名、成功判定、过期码）写进配置。
7. **给平台探测留钩子**：站点脚本放在 `<项目>/.env-prep/tools/<站点>/<站点>.mjs`，顶部用
   `const BASE = 'https://…'` 写站点根地址；`env-prep discover` 会**静态读取**它来判断平台类型，
   **不执行脚本**。一个站点承载多个子平台时（BeeCloud 同时是日志与发布），可以额外提供
   `<script> platforms` 子命令供人工/后续技能查询子平台清单，探测阶段不会自动调用它。

## 四、推断与兜底

| 情况 | 处理 |
| --- | --- |
| 用户没写日志/发布/缺陷平台 | 先按证据链自动探测；探不到就落在 `missing`，带候选清单问用户要 URL，**不要编** |
| 给的是日志平台首页 | 探测页面里的 API 线索，命中就生成脚本；没命中就生成"浏览器打开 + 关键字"的说明，并建议抓包 |
| nacos 有 namespace / group | 都写进 profile；拉取时按 group 逐条取 |
| 同一环境多套地址（前端/后端/网关） | 各自一条 `environments`，`name` 写清用途 |
| 资料里只有 IP 没有端口 | MySQL 默认 3306、nacos 默认 8848，但要在 profile 里标注"推断值" |
| 密码是占位符或打码 | 保留占位符并提醒用户补，**不要尝试破解或猜** |

## 五、安全红线

- **密码、令牌不进 git**：`.env-prep/` 写进仓库 `.gitignore`；profile 本身也不建议提交；
- **不回显**：任何输出只给掩码，命令里不要把密码拼进可打印字符串；
- **不试连**：没有用户授权不要拿这些凭据去连数据库或登录 nacos（拉配置除外，那是明确要求）；
- **不越权**：只打开用户给过的地址。平台探测是唯一例外，但必须同时满足：只探 profile 里**已出现过的域名**、
  候选名来自固定表（beecloud/aio/jenkins/grafana…）、协议与端口来自 profile、默认上限 24 次请求；
  **不扫 IP 段、不试密码**。`--no-probe` / `--no-scan` 可完全关闭；
- **书签只读**：平台探测会读 Chrome/Edge/Brave 的 `Bookmarks` 找线索，只读、不上传、不打印无关条目；
  `--no-bookmarks` 关闭。

## 六、与其他模块的衔接

本技能是「Java 程序员技能包」的第一块，后续模块见 `references/roadmap.md`：
项目导览 → 需求分析 → 代码编写 → 单元测试 → bug修复 → 上线检查。
环境准备产出的 `env-profile.json` 是后续模块的共同输入（连库、看日志、跑构建都要用）；
平台入口另存一份 `<out>/platforms.json`，字段见 `references/profile-schema.md` 的 `platforms` 一节。
