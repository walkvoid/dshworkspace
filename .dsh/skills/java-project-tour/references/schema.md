# 产物格式（.knowledge/）

所有文件都由 `scripts/tour.mjs` 生成或维护，UTF-8、2 空格缩进、键名固定。
**下游技能只依赖这些字段，不要自己改结构**。

## 通用约定

- 路径一律**相对项目根**，用 `/` 分隔（Windows 也转成 `/`）；
- 位置一律写成 `path:line`，`line` 是 1 起的行号；
- `confidence` 三档：`verified`（注解 / XML 实证）、`inferred`（类型或命名推断）、`unresolved`（解析不到）；
- 时间一律 ISO 8601（UTC），字段名 `generatedAt` / `at` / `scannedAt`。

## manifest.json

```json
{
  "version": 1,
  "generatedAt": "2026-11-03T03:38:50.211Z",
  "mode": "full",
  "elapsedMs": 27005,
  "repos": {
    "service-a": { "head": "a1b2c3d4e5f6", "javaFiles": 812, "scannedAt": "..." }
  }
}
```

`status` 用 `head` 判断过期：仓库当前 HEAD ≠ 记录值即 `stale`；仓库不在 `repos` 里即 `missing`。

## inventory.json

```json
{
  "generatedAt": "...",
  "version": 1,
  "repos": [{
    "name": "service-a",
    "path": "service-a",
    "artifactId": "service-a",
    "packaging": "pom",
    "displayName": "",
    "modules": ["service-a-api", "service-a-web"],
    "tech": { "springBoot": "2.3.12.RELEASE", "dubbo": true, "mybatis": true, "mq": false },
    "deps": 42,
    "crossDeps": [{ "to": "lib-b", "scope": "compile" }],
    "javaFiles": 812,
    "layers": { "web": 120, "service": 180, "provider": 90, "api": 200, "entity": 120, "mapper": 100 },
    "head": "a1b2c3d4e5f6"
  }],
  "crossRepoDeps": [{ "from": "service-a", "to": "lib-b", "scope": "compile" }]
}
```

`layers` 由目录名推断（`-web`/`-service`/`-provider`/`-api`/`entity`/`mapper`/`job`），只用于排序与分组，
不是权威分层。

## entries.json

```json
{
  "generatedAt": "...",
  "version": 1,
  "items": [{
    "id": "http:POST /asset/issue",
    "kind": "http",
    "repo": "service-a",
    "path": "service-a-web/src/main/java/.../AssetIssueController.java",
    "line": 87,
    "symbol": "AssetIssueController#issue",
    "route": "POST /asset/issue",
    "layer": "web",
    "confidence": "verified",
    "evidence": ["@PostMapping"]
  }],
  "classes": [{ "fqn": "com.example.asset.web.controller.AcfowAssetController", "path": "...", "line": 45 }]
}
```

`kind` 取值：`http` | `dubbo` | `job` | `mq` | `feign`。

- `http`：`route` 是 `方法 + 完整路径`（类级 `@RequestMapping` 已拼上）；`@RequestMapping` 不分方法记为 `ANY`；
- `dubbo`：`route` 是实现的服务接口全名；
- `job`：`route` 是 `@XxlJob` 名字；
- `mq`：`route` 是队列 / topic；
- `feign`：`route` 是 `服务名 + path`。

`classes` 是**类名 → 文件**的全量索引，供流程处理类解析和 `context` 反查用。

## data.json

```json
{
  "generatedAt": "...",
  "version": 1,
  "mappers": [{
    "path": ".../mappers/AssetIssueMapper.xml",
    "repo": "service-a",
    "namespace": "com.example.asset.mapper.AssetIssueMapper",
    "tables": ["asset_issue"],
    "statements": [{ "kind": "select", "id": "selectById", "line": 12 }]
  }],
  "tables": [{
    "name": "asset_issue",
    "reads": [{ "path": ".../AssetIssueMapper.xml", "line": 12, "repo": "service-a" }],
    "writes": [{ "path": ".../AssetIssueMapper.xml", "line": 40, "repo": "service-a" }],
    "entity": { "path": ".../AssetIssue.java", "line": 9 }
  }]
}
```

- 表名只收 `^[a-z_][a-z0-9_]*$i`，避免把子查询别名当表；
- 一条 SQL 里出现 `insert|update|delete` 记 `writes`，其余记 `reads`；
- 实体来自 `@TableName`，一个表只保留第一个命中的实体。

## flows/index.json

```json
{
  "generatedAt": "...",
  "flows": [{
    "id": "资产签发-主流程-V16",
    "name": "资产签发-主流程",
    "version": "V16",
    "typeName": "资产签发流程",
    "category": "",
    "nodes": 76,
    "links": 87,
    "handlers": [{
      "fqn": "com.example.workflow.provider.exthandler.listener.tasklistenerhandler.issue.IssueSignAuditTaskListenerHandler",
      "className": "IssueSignAuditTaskListenerHandler",
      "extName": "凭证签发(开立)-->资产签收抢签节点",
      "nodeName": "签收审核",
      "nodeType": "RushSignTask",
      "path": "service-c/.../IssueSignAuditTaskListenerHandler.java",
      "line": 62,
      "confidence": "verified"
    }],
    "subFlows": ["签收审核子流程"],
    "file": "repo-a/procdefs/资产签发-主流程-V16.json",
    "repo": "repo-a"
  }]
}
```

- `id` 用文件名（含版本），`name` 取 `attr.name`；
- `handlers[].path` 为空说明处理类不在本项目仓库里，`confidence: unresolved`——**不要猜路径**；
- `subFlows` 来自节点 `defaultSubProcess[].process.procdefName`，是名字不是文件名。

## features.json

项目没有工作流引擎时，功能点由入口聚合而来；有流程时每个流程一项。

```json
{
  "generatedAt": "...",
  "version": 1,
  "source": "entries+flows",
  "note": "每个流程一个功能点（origin=workflow），其余按入口聚合（origin=entries）。",
  "features": [{
    "id": "asset",
    "name": "asset",
    "origin": "entries",
    "weight": 178,
    "counts": { "http": 120, "dubbo": 29, "job": 0, "mq": 0, "feign": 0, "flow": 0 },
    "repos": ["repo-a", "repo-b"],
    "flows": [],
    "samples": [{ "kind": "http", "id": "http:POST /asset/issue", "path": "service-a-web/.../AssetController.java", "line": 87 }]
  }]
}
```

规则：

- `origin: workflow` 表示来自流程定义（`id` 就是流程 ID，`counts.flow = 1`）；
  `origin: entries` 表示从入口聚合（`id` 是业务域键，如 `asset` / `cust` / `cashbidding`）；
  `origin: data-volume` 表示来自库里的表行数（有 `rows` 字段，`counts` 全为 0，见 `db.json`）；
- 聚合键：HTTP 取路径首段（跳过 `api` / `v1` 这类前缀），Dubbo 取包里的业务包
  （`.../scf/asset/provider/...` → `asset`），任务 / MQ / Feign 取名字前缀；
- **通用 CRUD 端点被排除**（`getById` / `allList` / `allListMaps` / `count` / `page` / `save` / `update` / `delete` 等），
  否则 MyBatis-Plus 生成的控制器会淹没真实业务；
- `weight` = `http×1 + dubbo×2 + job×2 + mq×2 + feign×1`；流程项从 8 起（另加处理类数量，最多 +4）；
  数据量项的 `weight = 100 + round(db 侧权重 × 5)`，保证它排在前面——但**数据量不等于重要性**，仍要人工/模型确认；
- `features` 只是候选：确认后的功能点用 `core mark --feature <id>` 固定。

## db.json

`db ingest` 生成，记录本次采用的环境、表行数，以及按行数聚合出的功能点。

```json
{
  "generatedAt": "...",
  "version": 1,
  "source": "mcp",
  "totals": { "tables": 230, "rows": 4530012, "filtered": 42 },
  "features": [
    { "id": "asset", "name": "asset", "rows": 2400000, "weight": 28.4,
      "tables": [{ "table": "ast_asset", "rows": 900000 }] }
  ],
  "tables": [
    { "table": "ast_asset", "rows": 900000, "bytes": 180000000, "feature": "asset", "filtered": "" }
  ]
}
```

规则：

- `rows` 来自 `information_schema.TABLES.TABLE_ROWS`（InnoDB 估算，非精确）；
- `filtered` 取值：`"log"`（日志 / 历史 / 引擎表，已排除）、`"small"`（低于 `--min-rows`）、`""`（参与统计）；
- 日志过滤包含 `act_hi_*` / `act_ru_*` / `qrtz_*` / `sys_oper_log` / `*_log` / `*_his` / `*_trace` /
  `*_audit` / `*_bak` / `*_tmp` / `*_stat` 等；业务表被误判时调 `--min-rows` 或改脚本里的正则；
- 表 → 功能域的顺序：实体所在包（`.../scf/asset/...`）→ Mapper 所在仓库名 → 表名首段；
- **不含任何库地址、账号、密码**：`db.json` 只留环境名与业务结论，避免把凭据写进索引。

## core.json

```json
{
  "version": 1,
  "project": "project-x",
  "updatedAt": "...",
  "items": [
    { "kind": "feature", "id": "asset", "reason": "资产域是主要业务面", "markedBy": "java-project-tour", "at": "...", "hits": 2 },
    { "kind": "flow",  "id": "资产签发-主流程-V16", "reason": "端到端主流程", "markedBy": "java-project-tour", "at": "...", "hits": 3 },
    { "kind": "class", "id": "service-c/.../IssueSignAuditTaskListenerHandler.java", "layer": "provider", "reason": "抢签入口", "markedBy": "code-writer", "at": "...", "hits": 1 },
    { "kind": "table", "id": "asset_issue", "reason": "主表", "markedBy": "java-project-tour", "at": "...", "hits": 2 }
  ]
}
```

规则：

- `class.id` 是**相对项目根的路径**（不是类名），这样文件改名后能一眼看出来；
- 同一个对象重复 mark 不新增记录，只 `hits += 1` 并刷新 `at` / `markedBy`；
- `core.md` 由 `core brief` 或任何 mark / unmark 自动刷新，内容与 `core.json` 同源；
- `hits` 的含义是“被下游技能复用了几次”，用来判断核心清单该不该收缩。

## 查询返回约定（find / where / context）

`find` / `where` 的每条命中至少包含：

```json
{ "kind": "http", "id": "http:POST /asset/issue", "title": "POST /asset/issue", "path": "...", "line": 87, "symbol": "AssetIssueController#issue", "repo": "...", "layer": "web", "score": 12, "core": false }
```

`where` 额外返回：`groups`（按 `web/service/provider/dao/entity/table/flow` 分组）、`risks`（表被多处读写等）。

`context <path>` 返回：`path` / `layer` / `core` / `entry`（该文件的入口记录）/ `mapper` / `table` /
`flows`（该文件作为处理类的流程节点）/ `siblings`（同仓库同层的其他入口）。

所有位置都是**相对项目根**，下游用 `path.join(项目根, path)` 拼回绝对路径即可。
