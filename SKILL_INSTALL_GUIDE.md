# 安装引导：dshworkspace（金融看板 + 史诗级韭菜人格分析）

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
| 史诗级韭菜 | 技能（2 个目录） | `/9c`、`/shichijijiucai` 人格分析技能 | 必装 |
| iFinD 数据源 | 第三方技能（可选） | 同花顺 MCP，提供行情兜底与交叉校验 | 可选，需密钥 |

两个技能都依赖仓库里的 `scripts/` 和 `data/`（两千多行），**所以仓库本身必须留在磁盘上**，不能只拷 SKILL.md。

---

## 第 0 步：探测环境

```bash
node --version      # 需要 >= 18（用到全局 fetch）
git --version       # 没有 git 就走第 1 步的 zip 方案
```

判断宿主是否支持插件：

- 有 `plugin_manager` 工具 → **DSH**，第 3 步要装看板；
- 没有 → 其他宿主（Cursor / Claude Code / Codex 等），只装技能，跳过第 3 步，并在报告里说明。

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

**先问用户装到哪里**（这是唯一需要用户决策的步骤，不要替他选）：

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
- `--force`：目标已存在时覆盖。

**成功判定**：脚本输出 `results[].status` 为 `copied` 或 `linked`，且 `<技能根目录>/9c/SKILL.md`、`<技能根目录>/shichijijiucai/SKILL.md` 存在。

**失败处理**：`status: failed` 时会带原因——目标已存在就加 `--force`；技能不存在说明仓库不完整，回到第 1 步。

---

## 第 3 步：安装金融看板（仅 DSH）

用 `plugin_manager` 的 `install_bundle`，`target` 指向**包含 `package.json` 的那一层**：

```
<仓库路径>/financial-dashboard
```

- 返回 `application: applied` 即成功；
- 然后提示用户**刷新 Web GUI**，左侧栏应出现「金融看板」。

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

**跳过本节**，直接进入第 5 步。结束时在报告里写"iFinD：未接入"，不要反复劝说。

### 4.3 用户点了「要」→ 第二问：收密钥

**紧接着**发第二个问题，这次**只给问题、不给选项**，让用户粘贴后提交：

```json
{
  "questions": [
    {
      "id": "ifind_key",
      "header": "iFinD 密钥",
      "question": "请粘贴 iFinD MCP 密钥（获取地址 https://mcp.51ifind.com/#/profile），提交后我直接安装技能包。"
    }
  ]
}
```

DSH 里用户的输入会作为自定义回答返回；若宿主支持密码型输入，优先用它。

### 4.4 收到密钥后：安装 → 写入 → 自检

严格按这个顺序（**写入必须在复制之后**，否则厂商包里的占位符会覆盖密钥）：

1. **下载并解压厂商包**：

   ```powershell
   Invoke-WebRequest "https://s.thsi.cn/cd/ifind-java-ds-bff-web-container/ifind-mcp-web/skills/ifind-finance-data-1.5.0.zip" -OutFile "$env:TEMP\ifind.zip" -UseBasicParsing
   ```

2. **复制到技能目录**：把含 `SKILL.md` 的那层目录复制为 `<技能根目录>/ifind-finance-data`（目录名不带版本号），
   确认 `mcp_config.json` 存在。

3. **写入密钥**（此时才写）：

   ```js
   const p = '<技能根目录>/ifind-finance-data/mcp_config.json';
   const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
   cfg.auth_token = token.trim();          // 先去首尾空白
   fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
   ```

   读回校验：非空、不等于占位符 `your mcp key`、无首尾空格。**全程不回显**，只输出长度或掩码。

4. **自检**：临时脚本调用 `require("<技能根目录>/ifind-finance-data/call-node.js").listTools("stock")`，
   输出含 `SELFCHECK_RESULT:` 且为合法 JSON 即通过；完成后删除临时脚本。

5. **提醒一次**：密钥会留在本次对话记录里；不想保留可改成文件配置并清空对话。不要反复强调。

**注意**：厂商包内没有 LICENSE 文件，本仓库不随仓库分发它，只在本机安装。密钥文件已在 `.gitignore` 中排除。

---

## 第 5 步：验证

```bash
# 1) 数据层能出数（A 股）
node "<仓库路径>/scripts/stock-data.mjs" all 中国平安

# 2) 港股分红（公告解析，能出除净日）
node "<仓库路径>/scripts/stock-data.mjs" all hk:02318

# 3) 契约测试（23 项，全离线）
node --test "<仓库路径>/data/test/contract.test.mjs"

# 4) 接入 iFinD 后，双源核对
node "<仓库路径>/scripts/verify-quotes.mjs"
```

- 第 1 项返回 `"ok": true` 且 `quote.price` 是数字 → 通过；
- 第 3 项 `pass` 等于 `tests` → 通过；
- 第 4 项仅在第 4 步完成时执行，`全部通过` → 通过。

**技能是否被宿主发现**：多数宿主需要重启或重新加载技能。装完提示用户"若 `/9c` 不可用，先重启一次"。

---

## 第 6 步：报告

```
=== dshworkspace 安装报告 ===
仓库位置：<仓库路径>
技能目录：<技能根目录>（模式：copy / link）
  9c            ：已安装 / 失败（原因）
  shichijijiucai：已安装 / 失败（原因）
金融看板        ：已安装（applied）/ 跳过（非 DSH）/ 失败（原因）
iFinD           ：已接入（自检通过，密钥 ***）/ 未接入 / 失败（原因）
数据层自检      ：通过（价格 xx.xx）/ 未通过（原因）
后续动作        ：刷新页面 / 重启宿主 / 无
```

报告里**只出现掩码 `***`**，任何位置都不要粘贴密钥全文、长度以外的内容或配置文件正文。

---

## 排错

| 现象 | 处理 |
| --- | --- |
| `/9c` 不出现 | 确认技能根目录是否为本宿主扫描的目录；重启宿主；检查 `SKILL.md` 的 `name` 是否仍为 kebab-case |
| 技能里说"找不到数据脚本" | `repo.txt` 内容是否指向正确仓库；或仓库被移动，重新跑一次 `install-skills.mjs` |
| 看板空白 / 无数据 | 插件 host 侧改动需重启 DSH；确认能访问 `qt.gtimg.cn` |
| iFinD 自检 401 | 密钥不完整或过期，重新获取 |
| iFinD 自检 403 | 安装成功但账号权益不足，不是安装问题 |
| 行情全失败 | 先跑第 5 步第 1 项定位是上游网络还是代码问题 |

---

## 边界说明

- 本仓库代码为 MIT，可自由使用；**iFinD 技能包属于第三方**，不随仓库分发。
- 所有数据来自公开接口或你的授权账号，仅限个人自用，不要对外转售或再分发。
- 人格分析输出为**方法论模拟**，不构成投资建议。
