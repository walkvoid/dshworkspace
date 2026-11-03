---
name: java-env-prep
description: Java 项目环境准备。用户输入 /java-env-prep、/env-prep、/环境准备，或直接给出一份包含数据库连接、各环境 URL、nacos/nexus 地址、git 仓库地址的文档/表格/图片/聊天记录时使用。把资料抽取成 env-profile.json，再配置数据库 MCP、拉取 nacos 配置、在浏览器打开各环境、克隆仓库、并探测内部日志平台生成取日志脚本。
---

# Java 环境准备

把「一份包含环境信息的资料」变成「一台能直接开工的机器」。输入可能是 Word、Excel、图片截图，
输出是一组已经执行完的动作 + 一份可复现的 `env-profile.json`。

**核心原则：资料里没有的，就问；资料里有的，不猜。**

**交互原则：所有确认都在对话里完成（`ask_user_question`），不要为了等用户输入而新开终端窗口。**

## 目录约定

```
<工作目录>/project/<项目名>/              # git.dir：各仓库平铺在这里
<工作目录>/project/<项目名>/.env-prep/    # outDir：nacos 配置、MCP 片段、书签备份
```

`project/` 这一层是**隔离层**：所有克隆下来的代码与凭据都收在它下面，`.gitignore` 只忽略
`/project/` 一条即可，不需要为每个项目单独加规则。

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


## 一、七类输入 → 五类动作

| 输入 | 动作 | 落点 |
| --- | --- | --- |
| 数据库（MySQL 等） | 生成 MCP 配置片段 | `<out>/mcp/<id>.yaml`，按提示并入 DSH `cordis.patch.yml` |
| nacos | 拉取配置 + 收进书签 | `<out>/nacos/<id>/<group>__<dataId>` |
| 各环境 URL、nexus | **写入浏览器书签**（项目名文件夹 + 分类） | Chromium 系直接改 `Bookmarks`；运行中退回可导入的 HTML |
| git 仓库 | `git clone` 到指定目录 | 目标目录 |
| 内部日志平台 | 探测接口 + 生成取日志脚本 | `<out>/logs/fetch-logs-<id>.mjs` |

书签结构固定为三层：

```
<项目名>/
├── 环境/      dev 开发环境、test 测试环境
├── 配置中心/  nacos-dev
├── 制品库/    nexus (maven-releases)
└── 日志/      内部日志平台
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

### 第 3 步：出计划，给用户看

```bash
node scripts/env-prep.mjs plan <env-profile.json>
```

计划里会列出：要收藏几个链接、克隆几个仓库、拉几个配置、生成几个 MCP 片段。
用户确认后再执行——**写书签和克隆仓库都是有副作用的动作**。

### 第 4 步：执行

```bash
node scripts/env-prep.mjs apply <env-profile.json> --only bookmark,clone,nacos,mcp,logs
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

### 第 5 步：收尾

1. **MCP 片段**：`apply` 默认会**自动并入** `~/.dsh/profiles/*/cordis.patch.yml`（按 id 去重、
   写前备份、用注释块包裹）。**重启 DSH** 后数据库工具才出现（`mcp__mysql_<id>__*`）。
   不想自动写入时加 `--no-mcp-apply`，或只跑 `--only mcp` 生成片段；
2. **日志脚本**：`<out>/logs/fetch-logs-<id>.mjs` 是骨架，按探测出的候选接口补全，
   Cookie 走环境变量 `LOG_PLATFORM_COOKIE`，不要写死在文件里；
3. **书签**：告诉用户是"已写入浏览器"还是"需要导入 HTML"，以及备份在哪；
4. **告知用户**：哪些动作成功、哪些失败、哪些需要他补信息。

## 三、推断与兜底

| 情况 | 处理 |
| --- | --- |
| 给的是日志平台首页 | 探测页面里的 API 线索，命中就生成脚本；没命中就生成"浏览器打开 + 关键字"的说明，并建议抓包 |
| nacos 有 namespace / group | 都写进 profile；拉取时按 group 逐条取 |
| 同一环境多套地址（前端/后端/网关） | 各自一条 `environments`，`name` 写清用途 |
| 资料里只有 IP 没有端口 | MySQL 默认 3306、nacos 默认 8848，但要在 profile 里标注"推断值" |
| 密码是占位符或打码 | 保留占位符并提醒用户补，**不要尝试破解或猜** |

## 四、安全红线

- **密码、令牌不进 git**：`.env-prep/` 写进仓库 `.gitignore`；profile 本身也不建议提交；
- **不回显**：任何输出只给掩码，命令里不要把密码拼进可打印字符串；
- **不试连**：没有用户授权不要拿这些凭据去连数据库或登录 nacos（拉配置除外，那是明确要求）；
- **不越权**：只打开用户给过的地址，不扫描内网。

## 五、与其他模块的衔接

本技能是「Java 程序员技能包」的第一块，后续模块见 `references/roadmap.md`：
项目导览 → 需求分析 → 代码编写 → 单元资产 → bug 修复 → 上下检查。
环境准备产出的 `env-profile.json` 是后续模块的共同输入（连库、看日志、跑构建都要用）。
