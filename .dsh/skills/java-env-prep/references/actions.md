# 五类动作的落点与细节

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
└── 日志/       内部日志平台
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
git clone [--branch <branch>] <url> <dir>
```

- 目标目录已存在 → 跳过（不删、不覆盖）；
- SSH 失败常见原因：没配 key、host key 未信任。提示用户处理，**不要把密码塞进 URL**；
- 大仓库超时（默认 5 分钟）时，让用户手动 clone 到同一目录，脚本会跳过。

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
