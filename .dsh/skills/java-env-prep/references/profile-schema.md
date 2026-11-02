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
  "logs": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `project` | ✅ | 项目名，用于书签文件夹与输出目录。缺失时自动推断：**仓库名公共前缀**（`jasolar-common` → `jasolar`）优先，其次是 **git 组名**（URL 最后一段）。可用 `--project` 覆盖 |
| `outDir` | — | 输出目录（nacos 配置、MCP 片段、书签备份）。缺省为 `./.env-prep`；建议设成 `<git.dir>/.env-prep`，让代码与资料放在一起（<br>`<工作目录>/project/<项目名>/.env-prep`） |
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
{ "id": "backend", "url": "git@gitlab.example.com:team/order-service.git", "dir": "~/code/order-service", "branch": "main" }
```

- `dir` 支持 `~`，相对路径按执行时的当前目录解析；
- `branch` 可省，默认为远端默认分支；
- SSH 地址要求本机已配好 key，失败时提示用户换成 HTTPS 或配 key，**不要让他输密码到命令行**。

## logs

```json
{ "id": "log-platform", "url": "https://logs.example.com", "note": "内部日志平台" }
```

`note` 写清平台类型（Kibana / Grafana Loki / 自研），影响探测脚本的生成方式。

## 从不同资料抽取的要点

| 资料形态 | 抽取要点 |
| --- | --- |
| Word / Markdown | 按"环境 → 地址/账号"的段落拆；表格优先于正文 |
| Excel | 一行一个环境或一个库；注意合并单元格导致的空值 |
| 图片 / 截图 | 逐字段读出后**回读给用户核对**；数字 0/O、1/l 容易认错 |
| 聊天记录粘贴 | 常见"账号: xxx / 密码: xxx"成对出现，按上下文归类 |

抽取完成后，先输出一张"我读到了什么"的表格，用户确认再执行。
