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

**并入方式**：把片段追加到 `~/.dsh/profiles/desktop/cordis.patch.yml`，重启 DSH。
之后模型能看到 `mcp__mysql_mysql_dev__*` 工具。

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
```

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
