# env-profile.json 字段说明

`env-profile.json` 是「环境准备」的唯一输入，也是后续模块（项目导览、bug 修复）的共同底稿。
**字段宁可空着标 `<待确认>`，也不要编。**

## 顶层

```json
{
  "project": "order-service",
  "databases": [],
  "nacos": [],
  "nexus": [],
  "environments": [],
  "git": [],
  "logs": [],
  "release": [],
  "bug": [],
  "platforms": {}
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `project` | ✅ | 项目名，用于书签文件夹与输出目录。缺失时自动推断：**仓库名公共前缀**（按 `-` 取首段，覆盖 ≥60% 才采用）优先，其次是 **git 组名**（URL 最后一段）。可用 `--project` 覆盖 |
| `outDir` | — | 输出目录（nacos 配置、MCP 片段、书签备份、`platforms.json`、`tools/<站点>/`、凭据）。缺省为 `./.env-prep`；建议设成 `<git.dir>/.env-prep`，让代码与资料放在一起（<br>`<当前工作空间>/.env-prep`） |
| `platforms` | — | 日志/发布/缺陷平台主入口，自动探测写入，也可以手写；详见下文 |
| `release` / `bug` | — | 发布、缺陷平台条目，供书签与后续技能直接消费；通常由 `platforms` 合并而来 |
| 其余 | — | 都是数组，没有就留空数组 |

## databases

```json
{
  "id": "mysql-dev",
  "kind": "mysql",
  "env": "dev",
  "host": "10.0.0.11",
  "port": 3306,
  "database": "order_db",
  "username": "readonly",
  "password": "<填入>"
}
```

- `id` 约定 `<kind>-<env>`；`kind` 目前支持 `mysql`（其余数据库先记下，动作暂只生成 mysql 片段）；
- `port` 缺失时按 3306 推断，并在交付说明里标注"推断值"；
- 一个环境的库一条记录；同库不同账号也拆开。

## nacos

```json
{
  "id": "nacos-dev",
  "url": "http://10.0.0.20:8848/nacos",
  "namespace": "dev",
  "username": "nacos",
  "password": "<填入>",
  "groups": ["DEFAULT_GROUP"],
  "dataIds": ["order-service-dev.yml"]
}
```

- `url` 写**控制台地址**（带不带 `/nacos` 都行，脚本会拼 `/v1/cs/configs`）；
- `namespace` 是 nacos 的租户 ID，不是名字——**能登录时优先自动枚举**（见下）；
- `dataIds` 不给全时，先拉 `groups` 下已知的几个，其余让用户补；
- `configs: [{ dataId, group }]`：`infer` 或自动枚举写入的精确清单。配置分散在多个 group 时
  （常见：`DEFAULT_GROUP` / `rule` / `asset` / `cust`），必须按成对拉取，否则会 404。

## nexus

```json
{ "id": "nexus", "url": "https://nexus.example.com", "repository": "maven-releases", "username": "deploy", "password": "<填入>" }
```

只用于打开页面与记录；v1 不做制品上传。

## environments

```json
{ "id": "dev", "name": "开发环境", "url": "https://dev.example.com" }
```

`name` 要能区分用途（前端 / 后端 / 网关 / 运营后台），别都叫"开发环境"。

## git

```json
{ "id": "backend", "url": "git@gitlab.example.com:team/order-service.git", "dir": "<当前工作空间>", "branch": "main" }
```

- `dir` 是仓库落盘目录（多个仓库时是它们的公共父目录，各仓库平铺其下）；默认取当前工作空间；支持 `~`，相对路径按执行时的当前目录解析；
- `branch` 可省，默认为远端默认分支；**它只是克隆起点**——默认策略（`active`）会在克隆后切到
  「默认分支之外、最新提交」的远端分支；想固定在这个分支上加 `--keep-branch`（写入的 `results[].branch`
  会记录 `strategy` / `defaultBranch` / `from → to` 与候选）；
- SSH 地址要求本机已配好 key，失败时提示用户换成 HTTPS 或配 key，**不要让他输密码到命令行**。

## logs

```json
{ "id": "log-platform", "url": "https://logs.example.com", "note": "内部日志平台" }
```

`note` 写清平台类型（Kibana / Grafana Loki / 自研），影响探测脚本的生成方式。
自动探测写入的条目还会带 `site`、`tools`、`command`、`detected`：`tools` 存在时
`apply --only logs` 生成的是转发脚本，不再生成空骨架。

## platforms（自动探测写入，也可以手写）

一个类型一个主入口：

```json
{
  "log": {
    "site": "beecloud",
    "name": "BeeCloud",
    "url": "http://beecloud.example.com:1040",
    "confidence": "script",
    "detected": true,
    "api": "/u5/api/v1/auth/me",
    "tools": "~/.dsh/env-prep/tools/beecloud/beecloud.mjs",
    "command": "node ~/.dsh/env-prep/tools/beecloud/beecloud.mjs search --query '<关键字>' --hours 1",
    "auth": "script-managed"
  },
  "release": { "site": "beecloud", "url": "http://beecloud.example.com:1040", "tools": "~/.dsh/env-prep/tools/beecloud/beecloud.mjs" },
  "bug": { "site": "aio", "url": "https://aio.example.com", "tools": "~/.dsh/env-prep/tools/aio/aio.mjs", "command": "node ~/.dsh/env-prep/tools/aio/aio.mjs bugs", "params": { "projectId": "1902260200386785282" } }
}
```

- `url` 是站点入口（origin）；`api` 只写**真正探到**的接口（401/403/405 也算存在），不猜 UI 子路径；
- `tools` / `command` 指向**共享工具库** `~/.dsh/env-prep/tools/<站点>/<站点>.mjs`（登录脚本/凭据/会话跨项目复用）；
- `params`：**每项目个性化**的业务参数（如缺陷平台的 `projectId`、日志平台的 tenant 等），站点脚本的业务命令用它查数据——多个项目共享同一份登录脚本，但各存各的 `params`；
- `confidence`：`script` > `saved` > `provided` > `suite` > `signature` > `registry` > `bookmark` > `hostname`；
- `detected: true` 表示自动探测写入；**用户手写的条目不会被自动结果覆盖**；
- profile 只存主入口；完整结果（`alternates`、`sites`、`attempts`、`missing`、`registry`）在
  `<out>/platforms.json`，后续技能直接读这个文件。

## release / bug

```json
{ "id": "beecloud", "site": "beecloud", "name": "BeeCloud", "url": "http://beecloud.example.com:1040", "tools": "~/.dsh/env-prep/tools/beecloud/beecloud.mjs", "detected": true }
```

与 `logs` 同构：`id`/`site` 一致，`name` 用于书签，`tools`/`command` 指向取数脚本。
自动探测会把主入口同时写进这两个数组，书签才会出现在 `发布/`、`缺陷/` 分类下。

## 从不同资料抽取的要点

| 资料形态 | 抽取要点 |
| --- | --- |
| Word / Markdown | 按"环境 → 地址/账号"的段落拆；表格优先于正文 |
| Excel | 一行一个环境或一个库；注意合并单元格导致的空值 |
| 图片 / 截图 | 逐字段读出后**回读给用户核对**；数字 0/O、1/l 容易认错 |
| 聊天记录粘贴 | 常见"账号: xxx / 密码: xxx"成对出现，按上下文归类 |

抽取完成后，先输出一张"我读到了什么"的表格，用户确认再执行。
