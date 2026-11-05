# 安装引导：dshworkspace（金融看板 + 史诗级韭菜人格分析 + Java 环境准备）

> **给执行安装的 Agent**：按本文档步骤完成安装。每一步**先执行、再判断**，不要凭推理假设成功。
> 路径含空格或中文时一律加引号。失败时按"失败处理"走，不要自行改下载地址。

**本文档的 raw 地址**（优先用它，`github.com/.../blob/...` 是网页不是源文件）：

```
https://raw.githubusercontent.com/walkvoid/dshworkspace/main/SKILL_INSTALL_GUIDE.md
```

**仓库**：`https://github.com/walkvoid/dshworkspace`

---

## 这个仓库装什么

| 组件 | 类型 | 说明 | 是否必装 |
| --- | --- | --- | --- |
| 金融看板 | DSH 插件 bundle | 右侧栏 + 左侧栏的行情面板、K 线、自选股；依赖 DSH 的 `plugin_manager` | DSH 宿主才装 |
| 史诗级韭菜 | 技能（1 个目录） | `/9c`、`/史诗级韭菜` 人格分析技能 | 必装 |
| Java 环境准备 | 技能（1 个目录） | 「Java 程序员技能包」第 1 个模块 `/java-env-prep`：把资料里的库、各环境、nacos、仓库变成能开工的机器 | Java 项目装 |
| 项目导览 | 技能（1 个目录） | 「Java 程序员技能包」第 2 个模块 `/java-project-tour`：把项目扫成 `.knowledge/` 索引（有工作流按流程、没有就按入口推断功能点），回答“功能在哪、改哪要动哪些文件” | Java 项目装 |
| 需求分析 | 技能（1 个目录） | 「Java 程序员技能包」第 3 个模块 `/java-requirement-analysis`：按业务域与技术大类双维度把需求文档拆成子需求、代码锚点、新增类/方法与估时，并列出澄清问题 | Java 项目装 |
| iFinD 数据源 | 第三方技能（可选） | 同花顺 MCP，提供行情兜底与交叉校验 | 可选，需密钥 |

史诗级韭菜技能依赖仓库里的 `scripts/` 和 `data/`（两千多行），**所以仓库本身必须留在磁盘上**，不能只拷 SKILL.md。
`java-env-prep` 是自包含的（逻辑都在技能目录自己的 `scripts/` 里），但它同样从仓库安装、同样留在技能根目录下。

### 技能清单：用户点谁就装谁

| 用户可能怎么说 | 技能目录名 | 一句话作用 |
| --- | --- | --- |
| 史诗级韭菜、龟龟法、龟龟投资法、9c、`/9c` | `9c` | 按「史诗级韭菜」的龟龟投资法评估一只 A 股 |
| Java 环境准备、环境准备、`/环境准备`、`/java-env-prep` | `java-env-prep` | 把一份资料变成能开工的 Java 开发环境（见第 2.5 步） |
| 项目导览、代码地图、导览、`/java-project-tour`、`/代码地图` | `java-project-tour` | 把多仓库 Java 项目扫成 `.knowledge/` 索引，回答“功能在哪、改哪要动哪些文件” |
| 需求分析、需求评审、`/java-requirement-analysis`、`/需求分析` | `java-requirement-analysis` | 把需求文档拆成改动大类 / 子需求 / 代码改动点 / 新增类 / 估时 / 澄清问题 |

用户把这份文档交给 Agent 时，通常会在同一句话里点名要装什么，例如：

> 阅读 https://raw.githubusercontent.com/walkvoid/dshworkspace/main/SKILL_INSTALL_GUIDE.md，安装史诗级韭菜

这种情况下**只装史诗级韭菜（`9c`）**——不要顺带装 `java-env-prep`，也不要因为脚本默认列表里还有别的就一起装。

| 用户怎么说 | 装什么 |
| --- | --- |
| "安装史诗级韭菜"、"装 9c 那个技能" | 只装 `9c`：`--skills 9c` |
| "安装环境准备"、"配一下 Java 环境" | 只装 `java-env-prep`：`--skills java-env-prep` |
| "安装项目导览"、"扫一下这个项目" | 只装 `java-project-tour`：`--skills java-project-tour` |
| "安装需求分析"、"分析这个需求" | 只装 `java-requirement-analysis`：`--skills java-requirement-analysis` |
| 没点名 / "全部安装" / 只说"完成安装" | 把清单里的技能全列出来：`--skills 9c,java-env-prep,java-project-tour,java-requirement-analysis`（当前四项） |
| 点名的名字在表里找不到 | **停下来问一句**，不要猜、不要装错技能 |

- 多个技能用逗号连起来：`--skills 9c,java-env-prep`；
- 不带 `--skills` 时脚本只装默认列表（当前仅 `9c`），**不要用它表达"全部"**；清单加新技能后，"全部安装"要记得把新名字也写进 `--skills`；
- 用户说"只装某个 / 不要某个"时照办，不要顺手多装；
- 这里的"只装"只约束**技能范围**：第 3 步看板、第 4 步 iFinD 仍按各自的条件走，别把技能范围和组件混为一谈；
- 仓库新增技能时，这张表要同步加一行（新技能同样能单独装：`--skills <新技能>`）。

#### 安装范围：按用户点名的组件，只跑对应步骤

| 用户怎么说 | 跑哪些步骤 | 明确不做 |
| --- | --- | --- |
| "只安装金融看板" | 第 0、1、3 步 | 不装任何技能（跳过 2 / 2.5 / 4） |
| "只安装史诗级韭菜" | 第 0、1、2 步（`--skills 9c`） | 跳过 2.5 / 4；看板要不要一起装，问一句，别默认装 |
| "只安装环境准备" | 第 0、1、2.5 步（`--skills java-env-prep`） | 跳过 3 / 4 |
| 没点名 / "全部安装" | 2 +（2.5，Java 项目才跑）+（3，DSH 才跑）+（4，按需询问） | — |

**关浏览器不是安装的固定动作**：只有装了 `java-env-prep`、在 `apply` 里写书签、且浏览器正在运行时，才会问那一次。
只装看板或只装 `9c` 时，**全程不碰浏览器进程、不写书签**。

#### 安装过程中的交互：必须保留，不要省

这些提问发生在安装过程中，与最终报告无关，**一条都不能因为"少输出"而删掉**：

| 时机 | 问什么 | 怎么问 |
| --- | --- | --- |
| 第 2 步 | 装到用户级还是项目级 | 提问控件（二选一） |
| 第 2.5 步 | 执行 `apply` 前，先把 `plan` 给用户确认 | 文本 + 提问控件 |
| 写书签且浏览器在运行 | 「关闭浏览器并写入（推荐）」/「不关，导出 HTML 手动导入」 | 提问控件；**关闭作为推荐项放第一个**，用户没回答仍按"不关"处理，绝不擅自关浏览器 |
| 第 4 步 | 要不要接入 iFinD；要就直接收密钥 | 两次提问：先二选一，再让用户粘贴密钥 |

只有**最终那条总结**受第 6 步约束，中间该问的照问。

---

## 第 0 步：探测环境

```bash
node --version      # 需要 >= 18（用到全局 fetch）
git --version       # 没有 git 就走第 1 步的 zip 方案
```

判断宿主是否支持插件：

- 有 `plugin_manager` 工具 → **DSH**，第 3 步要装看板；
- 没有 → 其他宿主（Cursor / Claude Code / Codex 等），只装技能，跳过第 3 步。

**成功判定**：明确回答"宿主是/不是 DSH"、"node 与 git 是否可用"。

---

## 第 1 步：获取仓库

推荐路径（Windows 可换成任意盘）：

```
%USERPROFILE%\.dsh\repos\dshworkspace        # Windows
~/.dsh/repos/dshworkspace                    # macOS / Linux
```

```bash
git clone https://github.com/walkvoid/dshworkspace.git "<仓库路径>"
```

没有 git 时用 zip：

```powershell
Invoke-WebRequest "https://codeload.github.com/walkvoid/dshworkspace/zip/refs/heads/main" -OutFile "$env:TEMP\dshworkspace.zip" -UseBasicParsing
Expand-Archive "$env:TEMP\dshworkspace.zip" "$env:TEMP\dshworkspace" -Force
# 解压后目录名带 -main，重命名为 dshworkspace 再移走
```

**成功判定**：`<仓库路径>/scripts/stock-data.mjs` 与 `<仓库路径>/.dsh/skills/9c/SKILL.md` 都存在。

---

## 第 2 步：安装技能

**先问用户装到哪里**（不要替他选；后面还要问 iFinD、写书签要不要关浏览器，那些也照问）：

| 选项 | 路径 | 效果 |
| --- | --- | --- |
| 用户级（推荐） | `~/.dsh/skills`（其他宿主可用 `~/.agents/skills`） | 所有项目都能用 |
| 项目级 | `<项目根>/.dsh/skills` | 只在当前项目可用 |

然后运行仓库自带的安装脚本，**不要手工复制**：

```bash
node "<仓库路径>/scripts/install-skills.mjs" --root "<技能根目录>" --mode copy
```

- `--mode copy`：复制技能并写入 `repo.txt`（仓库绝对路径），换机器、换目录都能跑；
- `--mode link`：建目录联接/符号链接，指向仓库，改仓库即时生效（本机自用更省事）；
- `--skills <a,b>`：只装指定技能（逗号分隔）。**默认只装 `9c`**，装 Java 环境准备要显式指定（见第 2.5 步）；
- `--force`：目标已存在时覆盖。

**只装用户点名的技能**（比如"安装史诗级韭菜"）——在命令后面补 `--skills`：

```bash
node "<仓库路径>/scripts/install-skills.mjs" --root "<技能根目录>" --mode copy --skills 9c
```

**成功判定**：本次要求的每个技能，`results[].status` 都是 `copied` 或 `linked`，且 `<技能根目录>/<技能名>/SKILL.md` 存在
（装 `9c` 时再看 `<技能根目录>/9c/repo.txt` 指向的仓库里 `scripts/stock-data.mjs`、`data/index.mjs` 是否都在）。

**失败处理**：`status: failed` 时会带原因——目标已存在就加 `--force`；技能不存在说明仓库不完整，回到第 1 步。

---

## 第 2.5 步：安装「Java 程序员技能包 · 环境准备」（Java 项目装）

技能目录名 `java-env-prep`，是本仓库「Java 程序员技能包」的第 1 个模块。它把一份写着数据库连接、
各环境 URL、nacos / nexus 地址、git 仓库地址的资料（Word、Excel、截图、聊天记录都行），变成一串已执行的动作：
生成数据库 MCP 配置、拉取 nacos 配置、写浏览器书签、克隆仓库、生成取日志脚本。

**什么时候装**：用户是 Java 后端，或明说"帮我准备开发环境""配一下环境"。它与「史诗级韭菜」互不影响，
不装也不影响第 3 步的看板。

**不用另选目录**——复用第 2 步定下的同一个技能根目录，只是多给一个 `--skills`：

```bash
node "<仓库路径>/scripts/install-skills.mjs" --root "<技能根目录>" --skills java-env-prep --mode copy
```

> 安装脚本的默认技能列表是 `9c`，**漏掉 `--skills java-env-prep` 就装不到它**。

**成功判定**：`results[].status` 为 `copied` 或 `linked`，且这三处都存在：

```
<技能根目录>/java-env-prep/SKILL.md
<技能根目录>/java-env-prep/scripts/env-prep.mjs
<技能根目录>/java-env-prep/references/profile-schema.md
```

**失败处理**：`status: failed` 时按 `reason` 走——目标已存在就加 `--force`；
报"仓库里没有这个技能"说明仓库不完整，回到第 1 步。

装进来的是这些：

| 路径 | 作用 |
| --- | --- |
| `SKILL.md` | 执行流程（抽 profile → 校验 → 出计划 → 执行 → 收尾）与安全红线 |
| `scripts/env-prep.mjs` | 唯一的可执行体：`validate` / `plan` / `infer` / `apply`，默认 dry-run，只有 `apply` 有副作用 |
| `references/profile-schema.md` | `env-profile.json` 的字段定义；`references/actions.md` 是五类动作的细节 |
| `references/roadmap.md` | 技能包七模块路线图（当前只有本模块落地） |
| `templates/env-profile.example.json` | 手写 profile 时的骨架 |

**运行前置**：Node >= 18、`git`（克隆仓库要用）。写浏览器书签额外要求 Chromium 系浏览器
（Chrome / Edge / Brave）；浏览器正在运行时会退回"导出 HTML 手动导入"。进程检测与关闭用的是
`tasklist` / `taskkill`，**这条路径是 Windows 专用**。

**关浏览器只在用户明确点了「关闭」之后才做**，而这一项是**推荐项**（选项表里「关闭浏览器并写入书签（推荐）」放第一个）：
带 `--close-browser --force-close` 执行；用户点「不关」或没回答，一律导出 HTML，
**推荐 ≠ 默认，不要擅自 `taskkill` 别人的浏览器**。

**它会产生的副作用**（执行 `apply` 前必须先把 `plan` 给用户确认）：

- 克隆的仓库落在 `<工作目录>/project/<项目名>/`，配置与备份落在 `<工作目录>/project/<项目名>/.env-prep/`；
- 数据库 MCP 片段默认**自动并入** `~/.dsh/profiles/*/cordis.patch.yml`（按 id 去重、写前备份、注释块包裹），
  **重启 DSH** 后数据库工具（`mcp__mysql_<id>__*`）才出现；不想自动写入就加 `--no-mcp-apply`；
- 书签按"项目名 / 环境·配置中心·制品库·日志"三层写入，写前备份到 `<out>/bookmarks/*.bak.json`。

仓库的 `.gitignore` 已忽略 `/project/` 与 `.env-prep/`，克隆下来的代码和凭据不会被误提交；profile 本身也不要提交。
密码只以 `***` 出现，**不要试连、不要扫描内网**。

**自检**（无副作用）：

```bash
node "<技能根目录>/java-env-prep/scripts/env-prep.mjs"
```

打印出 `用法：env-prep.mjs <validate|plan|apply|infer> <profile.json> [选项]` 即脚本可用。
**不带参数时退出码是 1，属正常现象**，不要当失败。

---

## 第 3 步：安装金融看板（仅 DSH）

用 `plugin_manager` 的 `install_bundle`，`target` 指向**包含 `package.json` 的那一层**：

```
<仓库路径>/financial-dashboard
```

- 返回 `application: applied` 即成功；
- 然后刷新 Web GUI，验证左侧栏出现「金融看板」——这是自检动作，**不要写进最终输出**；
- 本步只做"装 bundle + 刷新验证"两件事：**不执行 env-prep 的 `apply`、不写浏览器书签、也不关浏览器**。

**失败处理**：报 `bundle` 相关错误时，确认 `<仓库路径>/financial-dashboard/package.json` 存在；非 DSH 宿主直接跳过本步，不要尝试其他安装方式。

---

## 第 4 步：可选——接入 iFinD

用**宿主的提问控件**给用户一个二选一，不要让用户自己判断该说什么。

### 4.1 第一问：要不要接入

DSH（有 `ask_user_question` 工具）直接这样问：

```json
{
  "questions": [
    {
      "id": "ifind",
      "header": "iFinD 数据源",
      "question": "要不要接入同花顺 iFinD 数据源？需要 MCP 密钥；不接也能正常用，行情走腾讯。",
      "options": [
        { "label": "不要（跳过）", "description": "行情继续走腾讯，功能不受影响" },
        { "label": "要，我提供密钥", "description": "装完厂商技能包后我会让你粘贴密钥" }
      ]
    }
  ]
}
```

其他宿主：用等价的按钮/选项能力（Claude Code 的 `AskUserQuestion`、Cursor 的选项等）；都没有时才退回纯文本二选一。

### 4.2 用户点了「不要」

**跳过本节**，直接进入第 5 步。最终输出里不提 iFinD，不要反复劝说。

### 4.3 用户点了「要」→ 第二问：收密钥

**紧接着**发第二个问题，这次**只给问题、不给选项**，让用户粘贴后提交。
密钥获取页要给成**可点击的超链接**，别让用户自己把地址复制到浏览器：

```json
{
  "questions": [
    {
      "id": "ifind_key",
      "header": "iFinD 密钥",
      "question": "请粘贴 iFinD MCP 密钥，获取页：[mcp.51ifind.com/#/profile](https://mcp.51ifind.com/#/profile)。提交后我直接安装技能包。"
    }
  ]
}
```

- 支持 markdown 的提问控件会把它渲染成可点链接；只渲染纯文本的宿主，就在提问**前**单独发一行
  [`获取 iFinD 密钥`](https://mcp.51ifind.com/#/profile) 的 markdown 链接，问题里同时保留裸地址；
- DSH 里用户的输入会作为自定义回答返回；若宿主支持密码型输入，优先用它；
- 密钥只出现在这一个问题里，不要写进选项、不要回显。

### 4.4 收到密钥后：安装 → 写入 → 自检

严格按这个顺序（**写入必须在复制之后**，否则厂商包里的占位符会覆盖密钥）：

1. **下载并解压厂商包**：

   ```powershell
   # Windows
   Invoke-WebRequest "https://s.thsi.cn/cd/ifind-java-ds-bff-web-container/ifind-mcp-web/skills/ifind-finance-data-1.5.0.zip" -OutFile "$env:TEMP\ifind.zip" -UseBasicParsing
   Expand-Archive "$env:TEMP\ifind.zip" "$env:TEMP\ifind_extract" -Force
   ```

   ```bash
   # macOS / Linux
   curl -fSL -o /tmp/ifind.zip "https://s.thsi.cn/cd/ifind-java-ds-bff-web-container/ifind-mcp-web/skills/ifind-finance-data-1.5.0.zip"
   unzip -q /tmp/ifind.zip -d /tmp/ifind_extract
   ```

   **若下载 404**：不要猜新地址，去读厂商自己的引导取当前链接：

   ```text
   https://mcp.51ifind.com/gwstatic/static/ds_web/ifind-mcp-web/skills/SKILL_INSTALL_GUIDE.md
   ```

2. **复制到技能目录**：把含 `SKILL.md` 的那层目录复制为 `<技能根目录>/ifind-finance-data`（目录名不带版本号），
   确认 `mcp_config.json` 存在。

   > 装到用户级（`~/.dsh/skills`）或仓库内（`<仓库>/.dsh/skills`）都可以——
   > `data/providers/ifind.mjs` 会依次查找 `IFIND_SKILL_DIR`、仓库、`~/.dsh/skills`、
   > `~/.agents/skills`、`~/.config/agents/skills`、`~/.claude/skills`，命中哪个用哪个。
   > 需要指定其他位置时设置环境变量 `IFIND_SKILL_DIR`。

3. **写入密钥**（此时才写）：

   ```js
   const fs = require('fs');
   const p = '<技能根目录>/ifind-finance-data/mcp_config.json';
   const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
   cfg.auth_token = token.trim();          // 先去首尾空白
   fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
   ```

   读回校验：非空、不等于占位符 `your mcp key`、无首尾空格。**全程不回显**，只输出长度或掩码。

4. **自检**：临时脚本调用 `require("<技能根目录>/ifind-finance-data/call-node.js").listTools("stock")`，
   输出含 `SELFCHECK_RESULT:` 且为合法 JSON 即通过；完成后删除临时脚本。
   自检需要能访问 `api-mcp.51ifind.com:8643`；超时通常是网络/代理问题，不是安装失败。

5. **不额外输出**：密钥只写进本地配置文件，最终回复里不提这件事（回复只保留第 6 步那两块）。

**注意**：厂商包内没有 LICENSE 文件，本仓库不随仓库分发它，只在本机安装。密钥文件已在 `.gitignore` 中排除。

---

## 第 5 步：验证

```bash
# 1) 数据层能出数（A 股）
node "<仓库路径>/scripts/stock-data.mjs" all 中国平安

# 2) 港股分红（公告解析，能出除净日）
node "<仓库路径>/scripts/stock-data.mjs" all hk:02318

# 3) 契约测试（24 项，全离线）
node --test "<仓库路径>/data/test/contract.test.mjs"

# 4) 接入 iFinD 后，双源核对
node "<仓库路径>/scripts/verify-quotes.mjs"

# 5) 装了 Java 环境准备时，脚本能跑起来（无参数打印用法，退出码 1 属正常）
node "<技能根目录>/java-env-prep/scripts/env-prep.mjs"
```

- 第 1 项返回 `"ok": true` 且 `quote.price` 是数字 → 通过；
- 第 3 项 `pass` 等于 `tests` → 通过；
- 第 4 项仅在第 4 步完成时执行，`全部通过` → 通过；
- 第 5 项仅在第 2.5 步完成时执行，打印出用法即通过。

**只验证装了的东西**：装了 `9c` 才跑 1-3 项；接了 iFinD 才跑第 4 项；装了环境准备才跑第 5 项。
只装看板时本步整体跳过——看板的验证就是第 3 步那次刷新。

**技能是否被宿主发现**：多数宿主需要重启或重新加载技能；这条重启提示放进第 6 步的"怎么用"里，别单独再写一段。

---

## 第 6 步：报告——只输出两块内容

**输出边界**：最终回复里**只允许**出现两块内容——① 装了哪些技能（✅ 醒目展示）；② 装好的技能怎么用。
仓库路径、安装模式、脚本原始 JSON、看板状态、iFinD 状态、自检过程、排错细节，**一律不写**。

> **只约束最后那条总结**。安装过程中的提问一条都不能省：装到哪个目录、iFinD 要不要接入、
> 密钥怎么给、执行 `apply` 前的 `plan` 确认、写书签要不要关浏览器——照常问，问完再收尾。

### 6.1 先醒目展示本次装了哪些技能

**第一行就是结果**：标题里带上技能名，再用清单逐条打勾（成功 ✅、失败 ❌，失败只留一行原因）。

```markdown
## ✅ 安装完成：史诗级韭菜

| 状态 | 技能 | 说明 |
| :---: | --- | --- |
| ✅ | **史诗级韭菜**（`9c`） | 按「史诗级韭菜」的龟龟投资法评估一只 A 股 |
```

有技能没装上时，标题换成 ⚠️，失败项留在同一张表里：

```markdown
## ⚠️ 安装完成（有失败项）

| 状态 | 技能 | 说明 |
| :---: | --- | --- |
| ✅ | **史诗级韭菜**（`9c`） | 按「史诗级韭菜」的龟龟投资法评估一只 A 股 |
| ❌ | **Java 环境准备**（`java-env-prep`） | 未安装：<一行原因> |
```

- 只列**本次要求的技能**，没要求的一条都不要出现；
- 全部成功时标题写"✅ 安装完成：<技能名、技能名>"，让人一眼看到结果；
- 失败原因压成一行，不要展开排错过程；
- **只装了看板、没装技能**时，展示的就是组件本身：`## ✅ 安装完成：金融看板`，
  一行 `✅ 金融看板（financial-dashboard）｜刷新后左侧栏可见`。

### 6.2 再说这些技能怎么用

只给装好的技能，一条一行，能直接复制：

```markdown
## 怎么用

- `/9c 中国平安` 或 `/史诗级韭菜 中国平安` —— 出一份三因子 + 硬规则的评估
- 也可以直接说"用龟龟法看看 601318"
- 首次装完 `/9c` 没反应，重启一次宿主即可
```

`java-env-prep` 装好时同理：`/java-env-prep`（或 `/环境准备`）后面跟一份写着数据库、环境、nacos、仓库的资料。
只装看板时，"怎么用"就一句：刷新 Web GUI，左侧栏出现「金融看板」。
不解释原理、不贴脚本参数、不复述安装步骤。

**密钥与凭据**：任何位置都不要粘贴密钥全文，只允许掩码 `***`。

---

## 排错

| 现象 | 处理 |
| --- | --- |
| `/9c` 不出现 | 确认技能根目录是否为本宿主扫描的目录；重启宿主；检查 `SKILL.md` 的 `name` 是否仍为 kebab-case |
| `/环境准备` 不出现 | 大概率是本次没要求装它：默认只装 `9c`，要补一次 `--skills java-env-prep`；装了就重启宿主 |
| 环境准备说"缺少 project / host / url" | 先 `validate`，`problems` 非空就补资料；只缺库名可用 `infer` 从 nacos 配置推断 |
| 书签没进浏览器 | 浏览器在运行：改 `--bookmark-mode html` 导出后手动导入；备份在 `<out>/bookmarks/` |
| 环境准备后数据库工具没出现 | MCP 片段写在 `~/.dsh/profiles/*/cordis.patch.yml`，**重启 DSH** 才加载；或检查是否加了 `--no-mcp-apply` |
| 技能里说"找不到数据脚本" | `repo.txt` 内容是否指向正确仓库；或仓库被移动，重新跑一次 `install-skills.mjs` |
| 看板空白 / 无数据 | 插件 host 侧改动需重启 DSH；确认能访问 `qt.gtimg.cn` |
| iFinD 自检 401 | 密钥不完整或过期，重新获取 |
| iFinD 自检 403 | 安装成功但账号权益不足，不是安装问题 |
| iFinD 装了但行情仍走腾讯 | provider 没找到技能目录：把包放到 `<仓库>/.dsh/skills/`，或设 `IFIND_SKILL_DIR` 指向它，再跑 `node "<仓库>/scripts/verify-quotes.mjs"` 确认 |
| 行情全失败 | 先跑第 5 步第 1 项定位是上游网络还是代码问题 |

---

## 边界说明

- 本仓库代码为 MIT，可自由使用；**iFinD 技能包属于第三方**，不随仓库分发。
- 环境准备的 `apply` 会**写浏览器书签、克隆仓库、改 `~/.dsh/profiles` 的 `cordis.patch.yml`**——都是有副作用的动作，
  必须先跑 `plan` 让用户确认，再执行。
- 所有数据来自公开接口或你的授权账号，仅限个人自用，不要对外转售或再分发。
- 人格分析输出为**方法论模拟**，不构成投资建议。
