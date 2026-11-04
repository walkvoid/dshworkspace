# 六类动作的落点与细节

## 1. 数据库 → MCP 配置片段

生成物：`<out>/mcp/<id>.yaml`，形如

```yaml
- id: mcp-mysql-mysql-dev
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mysql_mysql_dev
    transport: stdio
    command: npx
    args: ['-y', '@benborla29/mcp-server-mysql']
    env:
      MYSQL_HOST: 10.0.0.11
      MYSQL_PORT: '3306'
      MYSQL_USER: readonly
      MYSQL_PASS: <填入>
      MYSQL_DB: order_db
    failOnStartupError: false
```

**并入方式**：默认**自动并入** `~/.dsh/profiles/*/cordis.patch.yml`（优先 `desktop`），
重启 DSH 后模型能看到 `mcp__mysql_<id>__*` 工具。

| 行为 | 说明 |
| --- | --- |
| 定位 patch 文件 | `--patch <path>` > `DSH_PATCH_FILE` 环境变量 > `~/.dsh/profiles/*/cordis.patch.yml` |
| 去重 | 按条目 `id` 判断，已存在就跳过，重复执行不会写两遍 |
| 备份 | 每次实际写入前生成 `<patch>.<时间戳>.bak` |
| 回滚 | 删掉 `# >>> java-env-prep: MySQL MCP` 到 `# <<< java-env-prep: MySQL MCP` 之间的整段 |
| 关闭 | `--no-mcp-apply` 只生成片段不写入；`--only mcp` 同理 |

```bash
# 默认：生成片段 + 并入
node scripts/env-prep.mjs apply env-profile.json --only mcp,mcp-apply

# 只生成片段
node scripts/env-prep.mjs apply env-profile.json --only mcp

# 指定其他 patch 文件
node scripts/env-prep.mjs apply env-profile.json --only mcp-apply --patch /path/to/cordis.patch.yml
```

**注意**：

- `args` 里的 MCP server 包是示例（`@benborla29/mcp-server-mysql`），团队用别的实现就换掉；
- `serverName` 只能是 `[A-Za-z0-9_-]{1,32}`，所以 `id` 里的点、斜杠要替换成下划线；
- 密码写进 yaml 就等于写进磁盘明文，接受不了就改成读环境变量（`MYSQL_PASS: !!js process.env.MYSQL_DEV_PASS`）；
- 片段里的注释行不要删，它提醒下一个人"包名是占位"。

## 2. nacos → 拉取配置

脚本走 v1 接口：

```
POST /nacos/v1/auth/login        {username, password} -> {accessToken}
GET  /nacos/v1/cs/configs?dataId=&group=&tenant=&accessToken=
```

- `tenant` 就是 namespace ID；不带 `accessToken` 时按公开配置处理；
- 返回 `config data not exist` 或空串 = 该 dataId 不存在，记失败但继续；
- 落盘文件名 `group__dataId`，避免不同 group 同名覆盖；
- v2 接口（`/nacos/v2/cs/config`）结构不同，v1 失败时再手工确认，不盲目重试。

### 命名空间与 group 不用手填

有账号密码时，脚本能自己问出来：

```
POST /v1/auth/login                              -> accessToken
GET  /v1/console/namespaces?accessToken=…        -> [{namespace, namespaceShowName, configCount}]
GET  /v1/cs/configs?search=accurate&tenant=<id>  -> pageItems[].{dataId, group}
```

两个容易踩的点：

1. **namespace 是 UUID，不是名字**——`dev` 只是 `namespaceShowName`，真正要传的是 `8d2c6b5d-…`；
2. **配置分散在多个 group**——同一环境的几十条配置常分布在 `DEFAULT_GROUP` / `rule` / `asset` / `cust`。
   按 `dataId × groups` 的笛卡尔积去拉会命中一批 404，必须按 `(dataId, group)` 成对拉。

### 从配置反推数据库名

资料不给库名时，配置里有答案：

```bash
node scripts/env-prep.mjs infer env-profile.json --out .env-prep
```

扫描已拉取的 `nacos/**`，抽 `jdbc:mysql://host:port/schema`（跳过 `${…}` 占位符）：

| 情况 | 取值 |
| --- | --- |
| 库的 `host:port` 能对上 JDBC 的 host | 用那个 schema |
| 对不上 | 带项目前缀、引用次数最多的 schema |
| 结果不满意 | `--database <name>` 显式覆盖 |

一个 MySQL 实例上往往有几十个 schema，自动推断给的是**默认值**，不是真理。

## 3. URL → 浏览器书签（不是打开标签）

生成结构：

```
<项目名>/
├── 环境/       每个 environments 一条
├── 配置中心/   nacos 控制台
├── 制品库/     nexus
├── 日志/       内部日志平台
├── 发布/       发布/流水线平台
└── 缺陷/       缺陷/项目管理平台
```

### 写入方式

| 情况 | 行为 |
| --- | --- |
| Chromium 系浏览器已退出 | 直接改 `Bookmarks` JSON：先备份，再合并，按 `url` 去重 |
| 浏览器正在运行 | **不改文件**，导出 Netscape HTML 供导入 |
| 没有 Chromium 系浏览器 | 导出 HTML |

```bash
node scripts/env-prep.mjs apply env-profile.json --only bookmark
node scripts/env-prep.mjs apply env-profile.json --only bookmark --bookmark-mode html

# 允许为了写书签关闭浏览器：终端提示等待，30 秒无响应则 taskkill /F
node scripts/env-prep.mjs apply env-profile.json --only bookmark \
  --bookmark-mode file --close-browser --confirm-timeout 30
```

`--close-browser` 的四条边界：

| 场景 | 行为 |
| --- | --- |
| 浏览器已退出 | 直接写文件 |
| **对话里已确认 + `--force-close`** | 不要求终端，直接 `taskkill /F` 后写入（Agent 的默认路径） |
| 有 TTY + `--close-browser`（人手工跑） | 打印提示等 30 秒，回 `y` 或超时 → 强制关闭后写入 |
| 没有确认（无 TTY、无 `--force-close`） | **不杀进程**，退回导出 HTML |

最后一条是刻意的：管道/自动化环境里没有真实的用户授权，替用户杀掉浏览器风险太大。

> 确认应该在对话里完成（`ask_user_question`），**不要为了倒计时去新开 cmd/powershell 窗口**。
> 倒计时提示只服务于"人在终端里亲手敲命令"这一种场景。

### 为什么运行中不能直接改

Chrome/Edge 把书签树放在内存里，退出时整体写回文件。运行期间改磁盘上的 `Bookmarks`，
退出那一刻就被覆盖，用户会看到"加了又没了"。所以脚本先检测进程（`tasklist /FI "IMAGENAME eq chrome.exe"`），
在跑就只导出 HTML。

### 写文件时的字段格式

| 字段 | 格式 |
| --- | --- |
| `guid` | UUID v4，如 `212bb598-5485-48f0-893f-446341023aa5` |
| `id` | 字符串数字，接在现有最大 id 之后（`"289"`） |
| `date_added` | Chromium 时间戳：1601-01-01 起的**微秒**，字符串 |
| `date_last_used` | `"0"`（未使用） |
| folder | 额外需要 `children`、`date_modified` |

项目文件夹挂在 `roots.bookmark_bar` 下（书签栏，可见）；已存在同名文件夹时复用，不新建第二个。

### 备份与回滚

每次写文件前备份到 `<out>/bookmarks/<browser>-Bookmarks.<时间戳>.bak.json`。
需要回滚时：关掉浏览器，把备份覆盖回 `Bookmarks`，再启动。

### HTML 兜底

`<out>/bookmarks/<项目名>-bookmarks.html`，Netscape 格式，Chrome/Edge/Firefox/Safari 都能导入：
「书签管理器 → 导入书签 → 选择该文件」。

## 4. git → clone

```bash
# 默认（active）：克隆全部远端分支，再切到「默认分支之外、最新提交」的那条
git clone --no-single-branch <url> <dir>
git -C <dir> symbolic-ref --short refs/remotes/origin/HEAD     # 默认分支是谁
git -C <dir> for-each-ref --sort=-committerdate --format='%(refname:short)|%(committerdate:iso8601)' refs/remotes/origin
git -C <dir> switch -C <branch> --track origin/<branch>        # 旧版 git 退回 checkout -B

# latest：所有分支里取最新提交（默认分支可能在发布线上更活跃时用）
# profile：固定分支，不自动切换
git clone --single-branch --branch <branch> <url> <dir>
```

- **三种策略**：`active`（默认，排除 `origin/HEAD` 指向的默认分支）、`latest`（全部分支）、
  `profile`（保持 profile 的 `branch`）；`--keep-branch` 是 `profile` 的别名；
- **为什么用 committerdate**：Git 不存分支创建时间，只能用分支最新提交时间近似；团队功能分支通常最新，
  默认分支常是发布线（`active` 就是在这个经验上加的规则）。判断结果写进 `results[].branch`
  （`strategy` / `basis` / `basisNote` / `defaultBranch` / `branch` / `date` / `candidates` / `top`）；
- 两个已核实的点：`%(creatordate)` 对分支返回的就是最新提交时间（与 `committerdate` 相同）；
  克隆后远端跟踪分支**没有 reflog**（`git reflog show origin/x` 为空），所以「分支创建时间」拿不到；
- `active` 的代价：如果最新提交恰好在非默认分支但那条分支已经废弃，会选到它——
  拿不准时改用 `--branch-strategy latest`，或直接 `--keep-branch`；
- **只克隆活跃仓库**（默认 `--max-age 30`）：克隆前用
  `git init --bare <tmp> && git fetch --depth 1 --filter=blob:none <url> +HEAD:refs/heads/probe`
  探最后提交时间，超过 N 天就跳过，结果里带 `skipped: true` + `lastCommit` + 原因；
  `--max-age 0` / `--no-age-filter` 关闭。探测不落盘（临时 bare 仓库用完即删），
  不支持 filter 的服务端自动退回 `--depth 1`；探测失败则照常 clone 并标 `ageUnknown: true`；
- 只有一条分支、或当前分支就是目标时，不切（`changed: false` + `note`），不要为此报错；
- 切分支失败（远端没有可跟踪分支、工作区冲突）→ 保留克隆结果，把 `reason` 写进结果，**不要删仓库重来**；
- `--depth` 会隐含 `--single-branch`，active / latest 策略下脚本额外加 `--no-single-branch`，
  否则浅克隆只能看到默认分支（`candidates` 会变成 1，切不动）；
- 目标目录已存在 → 跳过（不删、不覆盖，也就不会切分支）；
- SSH 失败常见原因：没配 key、host key 未信任。提示用户处理，**不要把密码塞进 URL**；
- 大仓库超时（默认 5 分钟）时，让用户手动 clone 到同一目录，脚本会跳过。

**已有克隆补切分支**：`env-prep.mjs branch <profile> [--dry-run] [--no-fetch]`

- 遍历 profile 里所有 `git.repos`，逐仓库跑与 clone 相同的选择逻辑；
- 先 `git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'`；单分支克隆只有默认分支的引用，
  不 fetch 就永远比不出别的分支。origin 拉不动且 profile 有账号密码时，用**带凭据的 URL 只做这一次 fetch**，
  不写进 `.git/config`；都失败则标注 `fetch: "failed"`，按旧引用继续判断；
- 工作区脏（`git status --porcelain` 非空）→ 跳过，**不 stash、不覆盖**；
- 输出 `summary`（total/switched/already/skipped/failed/fetchFailed）与逐仓库明细；
- `--dry-run` 只报告 `current → branch` 与候选数，不动工作区。

## 5. 日志平台 → 探测 + 生成脚本

探测逻辑：

1. GET 首页，抓页面里形如 `/api/...`、`/log/...`、`/search/...` 的字符串；
2. 命中 → 生成 `fetch-logs-<id>.mjs`，把第一个候选填成 `endpoint`；
3. 未命中 → 说明是前端渲染，脚本退化为"打开页面 + 关键字"，并建议用浏览器抓一次真实请求再补。

生成脚本的约定：

- 查询词走 `process.argv[2]`；
- 认证走 `process.env.LOG_PLATFORM_COOKIE`，**不写死**；
- 输出原始 JSON 到 stdout，方便再喂给模型或 `jq`。

常见平台差异：

| 平台 | 典型的取数方式 |
| --- | --- |
| Kibana | `POST /internal/search/es` 或 `_search`，需要 `kbn-xsrf` 头 |
| Grafana Loki | `GET /loki/api/v1/query_range?query=&start=&end=` |
| 自研平台 | 多半是 `POST /api/log/search`，带 token |
| ELK 直连 | `GET /_search?q=` |

## 6. 日志/发布/缺陷平台 → 自动探测入口

真实 Java 项目基本都有这三类平台；用户没写 URL 时不要直接问，先自动找一遍。

```bash
node scripts/env-prep.mjs discover env-profile.json        # 探测 + 写 platforms.json + 合并回 profile
node scripts/env-prep.mjs platforms env-profile.json       # 只读已保存结果
```

`apply` 全量执行时，缺任何一类会自动先跑一次 `discover`（`--no-discover` 关闭）。探测本身**不改工作区**，
只发少量 GET；找到的结果写盘，供后续命令与技能直接读。

### 证据链

| 顺序 | 来源 | `confidence` | 说明 |
| --- | --- | --- | --- |
| 1 | 项目站点脚本 `.env-prep/tools/<站点>/<站点>.mjs`（兼容旧 `.tools/`、`.aio/`） | `script` | 静态读 `const BASE = 'https://…'`，**不执行脚本**；命中已知套件或正文关键词就归类 |
| 2 | `profile.platforms` / `logs` / `release` / `bug` 里 `detected: true` | `saved` | 上一次探测的结果，直接复用 |
| 3 | 用户显式写的 URL + 名字/备注 | `provided` | 关键词按词边界匹配，`login`/`lowcode` 不会命中 `log` |
| 4 | 已知套件（`KNOWN_SITES`） | `suite` | BeeCloud=日志+发布、AIO=缺陷、Jenkins=发布、Grafana/Kibana=日志、Jira/禅道/TAPD/Redmine=缺陷、Argo CD=发布 |
| 5 | 页面特征 | `signature` | 标题/正文命中 `应用观测`/`qaBug`/`DevOps` 等；只用于补类型，不单独定站点 |
| 6 | 跨项目登记表 | `registry` | `<工作目录>/project/.platforms.json`，同项目或同域复用；只存 URL 与类型，**不含凭据** |
| 7 | 浏览器书签 | `bookmark` | 只读 Chrome/Edge/Brave 的 `Bookmarks`，按已知套件/同域/关键词筛选，保留文件夹路径作证据 |
| 8 | 同域候选 | `hostname` | 固定平台名（beecloud/aio/jenkins/grafana/jira…）+ profile 里出现过的协议/端口 |

`environments` 里的平台入口也会被识别（jasolar 的 `beecloud` / `jenkins` 就写在环境里）；
`nacos`、`nexus`、业务环境按关键词排除，不会因为域名里带 `log` 就误判。

### 打分与产物

同一类型可能有多个候选，按 `confidence` 基础分 + 同域 +15 + 多类型套件 +8 + 探测成功 +5 排序，
主入口旁边的其他候选最多保留 3 个到 `alternates`。

`<out>/platforms.json`：

```json
{
  "schema": 2,
  "project": "jasolar",
  "domains": ["jasolar.com"],
  "platforms": {
    "log": {
      "kind": "log", "site": "beecloud", "name": "BeeCloud",
      "url": "http://beecloud.jasolar.com:1040",
      "tools": ".env-prep/tools/beecloud/beecloud.mjs",
      "command": "node .env-prep/tools/beecloud/beecloud.mjs search --query '<关键字>' --hours 1",
      "api": "/u5/api/v1/auth/me",
      "confidence": "script", "auth": "script-managed",
      "alternates": [{ "site": "grafana", "url": "http://grafana.jasolar.com:1040" }]
    },
    "release": { "kind": "release", "site": "beecloud", "url": "http://beecloud.jasolar.com:1040" },
    "bug": { "kind": "bug", "site": "aio", "url": "https://aio.llschain.com", "tools": ".env-prep/tools/aio/aio.mjs" }
  },
  "missing": [],
  "sites": [],
  "attempts": [],
  "registry": "D:\\github\\dshworkspace\\project\\.platforms.json"
}
```

- `api` 只写**真正探到**的接口：401/403/405/3xx 都算“模块在”，404 不算；**不猜 UI 子路径**；
- `tools` / `command` 指向已生成的站点脚本，`apply --only logs` 会为它生成转发脚本，不再造空骨架；
- 站点脚本统一放 `.env-prep/tools/<站点>/<站点>.mjs`，会话与查询条件也放在同一站点目录；
  旧项目的 `.tools/`、`.aio/` 仍会被扫描，但新脚本不再写那里；
- 主入口同时合并回 profile 的 `platforms` / `logs` / `release` / `bug`（写前备份 `env-profile.json.bak`），
  用户手写的条目不会被覆盖；脚本搬家后旧路径会被自动修正；
- 探测结果与站点脚本名一起进跨项目登记表，下一个项目可直接复用。

### 安全边界

| 限制 | 默认值 |
| --- | --- |
| 只探测 profile 里已出现过的域名 | 是（不扫 IP 段） |
| 候选名 | 固定表，不做字典扫描 |
| 协议/端口 | 来自 profile 里已有的 URL |
| 同域候选请求上限 | 24（`--probe-budget` 可调） |
| 单请求超时 | 6s / 同域 3.5s / 套件接口 4s |
| 关闭探测 | `--no-probe`；只关同域候选用 `--no-scan`；不读书签用 `--no-bookmarks` |

### 探不到怎么办

`missing` 里列出缺的类型与已有候选；不要编 URL、不要拿别的项目的入口硬凑。把候选矩阵给用户，
让他补一个 URL（或确认某个 `alternates`），补完重跑 `discover` 即可。

改完探测逻辑后可跑纯函数自检（不联网、不读写真实 profile）：

```bash
node scripts/selftest-platforms.mjs
```
