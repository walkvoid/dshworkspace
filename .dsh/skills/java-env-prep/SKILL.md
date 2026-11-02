---
name: java-env-prep
description: Java 项目环境准备。用户输入 /java-env-prep、/env-prep、/环境准备，或直接给出一份包含数据库连接、各环境 URL、nacos/nexus 地址、git 仓库地址的文档/表格/图片/聊天记录时使用。把资料抽取成 env-profile.json，再配置数据库 MCP、拉取 nacos 配置、在浏览器打开各环境、克隆仓库、并探测内部日志平台生成取日志脚本。
---

# Java 环境准备

把「一份包含环境信息的资料」变成「一台能直接开工的机器」。输入可能是 Word、Excel、图片截图，
输出是一组已经执行完的动作 + 一份可复现的 `env-profile.json`。

**核心原则：资料里没有的，就问；资料里有的，不猜。**

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

### 第 2 步：校验

```bash
node scripts/env-prep.mjs validate <env-profile.json>
```

`problems` 非空先补资料，**不要带着缺失字段往下跑**。

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

- 默认输出到当前目录的 `.env-prep/`，可用 `--out` 改；
- 单个动作失败不阻断其他动作，最后看 `results[].ok`；
- 密码在输出里永远是 `***`。

**书签这一步有两种结果**，看浏览器是否在运行：

| 情况 | 结果 |
| --- | --- |
| Chrome/Edge/Brave 已退出 | 直接写 `Bookmarks`，先备份到 `<out>/bookmarks/*.bak.json`，按 URL 去重，重复执行不会重复添加 |
| 浏览器正在运行 | **不碰文件**（退出时会被内存里的书签树覆盖），改导出 `<out>/bookmarks/<项目名>-bookmarks.html` |
| 没有 Chromium 系浏览器 | 同上，导出 HTML |

可用 `--bookmark-mode file|html` 强制指定。导入 HTML：浏览器「书签管理器 → 导入书签」。

### 第 5 步：收尾

1. **MCP 片段**：把 `<out>/mcp/<id>.yaml` 的内容并入
   `~/.dsh/profiles/desktop/cordis.patch.yml`，重启 DSH 后数据库工具才出现（`mcp__mysql_<id>__*`）；
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
