---
name: java-requirement-analysis
description: 需求分析：把需求文档（Word / Excel / PDF / 截图 / 一段话）按版本号命名需求目录，先剔除画线删除与标注下版本/取消的内容，再识别流程图并拆出节点/分支，最后按业务域（建档 / 额度 / 开立 / 作废…）与技术大类双维度拆成子需求、代码改动点与新增类/方法，对照 .knowledge 索引给出 path:line 锚点，按改动点估每个子需求的人天，并把文档里没说清的地方整理成分级澄清问题。当用户上传或粘贴需求文档，说“分析这个需求 / 需求评审 / 这个需求要改哪里 / 估个工时”时使用。
---

# 需求分析（java-requirement-analysis）

把一份需求文档变成**能排期、能开发、能验收**的清单：

```text
需求文档 → 需求条目 → 改动大类 → 子需求 → 代码改动点（path:line）→ 新增类/方法 → 人天 → 澄清问题
```

**两条硬原则：**

1. **文档里没有的，进问题清单**——不替产品补需求，不把“我觉得应该”写成需求；
2. **代码里没有的，标成新增**——不凭记忆编类名，不把猜测写成 `verified`。

## 一、产物

一切都在 `<项目根>/.requirements/<需求 id>/`（项目根 = env-prep 里 `git.dir` 指向的目录）：

```
.requirements/
└── req-v3.0.0-jasolar-saas/          # 按版本命名（推荐）
    ├── requirement.json   # 机器可读：来源、图示、业务域、子需求、改动点、估时、澄清问题
    └── analysis.md        # 人读：结论、大类分布、逐条明细、汇总、问题
```

**需求 id 按版本命名**：`req-v<版本号>-<短名>`，如 `req-v3.0.0-jasolar-saas`；
没有版本号时才退回 `req-<yyyymmdd>-<短名>`。一个需求一份文档、一个版本目录，不要用日期当主键——
同一版需求的文档会反复修订（V1.0.5→V1.0.6），按版本改名比按日期好找。

- `.requirements/` 默认**不入库**（需求文档本身常含敏感信息），要入库先问用户；
- `requirement.json` 是唯一事实来源，`analysis.md` 由它 + 模型叙述生成；改数据先改 JSON，再跑 `estimate`。

```bash
node <技能目录>/scripts/req.mjs init --project "<项目根>" --version 3.0.0 --slug jasolar-saas \
  --title "晶澳科技-本地化转SaaS对接" --source "docs/PRD.docx"
node <技能目录>/scripts/req.mjs estimate .requirements/req-v3.0.0-jasolar-saas/requirement.json
node <技能目录>/scripts/req.mjs validate .requirements/req-v3.0.0-jasolar-saas/requirement.json
node <技能目录>/scripts/req.mjs summary --project "<项目根>"
```

## 二、输入：文档 = 正文 + 内嵌对象 + 附件

**需求文档从来不是“一个 docx”**：Word 里常内嵌流程图、原型截图、字段表格；附件里还有接口文档（Excel / Word / Markdown / Swagger 导出）、DDL、报文样例。**只读正文 = 漏需求**，接口路径、字段必填、错误码往往只在附件里。

| 来源 | 怎么读 | 保留什么 |
| --- | --- | --- |
| Word 正文 | office-docx | 标题层级、章节号、正文段落 |
| Word 内嵌图片 | office 渲染成图后读图（流程图 / 状态图 / 原型 / 字段截图） | 图号 + 页码 + 从图里读到的字段、分支、状态 |
| Word 内嵌表格 | 按表格读取，保留表头 | 表号 + 页码 + 每列含义 |
| 附件：接口文档（`.xlsx` / `.docx` / `.md` / `.json` / Swagger / YApi 导出） | office-xlsx / office-docx / 文本解析 | 接口名、方法、路径、入参、出参、字段类型与必填、错误码 |
| 附件：DDL / 报文样例 / 原型 | 文本 / 读图 | 表名字段类型、样例值与长度、页面结构 |
| `.pdf` | 转文本，保留页码 | 页码 |
| 截图 / 扫描件 | 读图；无文字层就让用户补文本或逐页确认 | 页号 + 你读到的内容 |
| 粘贴文本 / 聊天记录 | 直接用 | 消息时间、发言人 |

规则：

- **每个来源都要登记**：正文、每张图、每个附件各一条 `sources[]`，带 `id` / `file` / `kind` / `locator`，子需求用 `sourceId` 指回去；
- 图片里的流程、状态、字段是**一等需求证据**：读得出的写进 `quote` 或 `acceptance`，读不准的进 P1 问题，**不许跳过**；
- **流程图必须做图片识别**（见 1.6 步）：节点、分支、金额阈值、外部调用只在图上，正文常写“见下图”；
- 接口表是“接口契约”的权威来源：路径、方法、字段、必填、错误码以附件为准；与正文冲突时以更具体的一方为准，并在问题里记一句；
- 附件与正文冲突、附件之间版本冲突（“接口文档 v2” vs “v3”）→ P0，先定版本再拆需求；
- 压缩包先列清单再逐个读，**不要只读第一个文件**；
- **删除线 / 修订删除不算需求**：Word 里被划掉的段落、表格行、标题整节排除；带【下版本】【取消】
  【本期不做】标记的也先剪掉——先裁剪再抽条目，见 [`references/scope-filter.md`](./references/scope-filter.md)；
- 需求只有一句话也可以走完全流程——只是 `questions` 会明显变多。

## 三、执行流程（按顺序，不跳步）

### 第 1 步：登记来源清单（先做，别边读边忘）

把所有输入摊开，逐条写进 `requirement.json` 的 `sources`：

```json
"sources": [
  { "id": "SRC-1", "file": "PRD-资产签发.docx", "kind": "document", "locator": "p.1-12" },
  { "id": "SRC-2", "file": "PRD-资产签发.docx#图3", "kind": "image", "locator": "p.5 签发流程图" },
  { "id": "SRC-3", "file": "附件1-接口定义.xlsx", "kind": "api", "locator": "Sheet1!A1:H24" }
]
```

`kind` 六类：`document` / `image` / `api` / `table` / `attachment` / `other`。

**闸门**：每个来源至少被一条子需求引用；没被引用的，要么补分析，要么在 `analysis.md` §8 写明为什么不用（旧版、重复、与本期无关）。

### 第 1.5 步：范围裁剪（被删的、非本期的先剔掉）

抽条目之前先剪一刀，只保留**本期要做且未被删除**的内容：

| 形态 | 处理 | `reason` |
| --- | --- | --- |
| 文字带删除线（`w:strike`）或修订删除（`w:del`） | 整段剔除，不分析 | `struck` |
| 标题含【下版本】【后续版本】 | 整节排除 | `next-version` |
| 标题/规则含【取消】【废弃】 | 排除 | `cancelled` |
| 正文写“本期不做”“不在本期范围” | 排除 | `out-of-scope` |
| 整节只有标题、无可落地规则 | 排除并说明 | `no-anchor` |

每条排除记录写进 `requirement.json` 的 `excluded[]`（label + reason + sourceId + locator），报告 §8 由它生成。
**排除项被本期依赖时开 P0 问题**（例：下版本的额度查询被本期开立依赖），不要偷偷做，也不要假装没依赖。

### 第 1.6 步：流程图 / 原型图必须做图片识别

**流程图不是插图，是需求的第二作者。** 判据：章节标题含「流程 / 时序 / 状态 / 原型 / 界面 / 架构」，
或正文出现“见下图 / 如下图 / 流程图”。这类图**每张都要识别并落成 `diagrams[]`**，不能只看标题。

按可用能力从高到低：

1. **多模态模型直接读图**：把图（长图先切片）交给视觉模型，按“泳道 / 节点 / 分支 / 阈值”输出；
2. **OCR**（当前模型无视觉时）：Windows OCR / tesseract / 云 OCR，长图必须切片再识别；
3. 都失败 → `confidence: unresolved` + 开澄清问题，**不许猜**。

落成结构（`requirement.json`）：

```json
"diagrams": [{
  "id": "DG-1", "sourceId": "SRC-4", "title": "凭证开立主流程", "kind": "flow",
  "lanes": ["本地客户端", "本地内管端", "SAAS 产融平台", "SAAS 讯易链"],
  "nodes": [{ "seq": 1, "actor": "集团采购专员", "action": "资产导入", "system": "本地客户端" }],
  "branches": [{ "from": "开单额度校验", "condition": "不通过", "to": "提示额度不足" }],
  "thresholds": [{ "field": "开单金额", "op": ">=", "value": 1500, "unit": "万元", "to": "集团资金复审" }],
  "integrations": ["资产导入", "单点登录-换码", "单点登录-取链"],
  "confidence": "inferred", "note": "OCR 识别，术语按正文校正"
}]
```

三条铁律：

- **图里有、正文没有的节点 → 开问题**（典型：图里画了额度校验，正文标“下版本”）；
- **正文有、图里没有的节点 → 也开问题**（可能是图没更新）；
- 图上的**金额阈值、状态回写、回调接口**逐条核对，这三类最容易漏。

细节与切片/OCR 代码见 [`references/diagram-analysis.md`](./references/diagram-analysis.md)。

### 第 2 步：抽需求条目

每条给：`id`（REQ-1…）、`sourceId`（指向 `sources`）、`quote`（原文 / 图号 + 页码）、`goal`（一句话目标）、`acceptance`（验收要点）、`role`（谁用）。

- 来自图片的条目，`quote` 写“图3：签发按签章方式分三条分支”，并在问题里记录读图的不确定处；
- 来自接口表的条目，`quote` 直接引字段行（“附件1 · 签发接口 · sealType · 必填”），**不要转述成模糊的一句话**；
- **抽取不是总结**：能用原文就用原文，别把“支持批量导出”改写成“优化导出体验”。

### 第 3 步：先归业务域，再标改动大类

每条子需求**两个维度都要填**：

- `domain`：业务域——这是**哪块业务**的事（建档？额度？开立？作废？）；
- `category`：技术大类——这次**改成什么**（接口？表结构？流程？集成？）。

**12 个业务域**（详见 [`references/business-domains.md`](./references/business-domains.md)）：

`cust` 客户与建档 / `product` 产品与开通 / `limit` 额度 / `asset` 资产与凭证开立 /
`trade` 凭证流转与融资 / `abolish` 凭证作废 / `repay` 兑付与结清 / `query` 查询与统计 /
`report` 监管报送 / `notify` 通知与预警 / `channel` 渠道与集成 / `platform` 平台与配置。

- 一个子需求一个**主域**，跨域放 `secondaryDomains`（最多 2 个），不要拿 `platform` / `channel` 兜底；
- 归域看**业务对象**：改的是 `cust_company_info` 就是 `cust`，哪怕动的是工作流；
- 技术大类仍按下面的 12 类标，域与类是两个正交维度，不要互相替代；
- 归类完给**两张**分布表：先域（业务视角，某域 0 条往往是漏项），再类（技术视角）。

12 类固定枚举，见 [`references/change-taxonomy.md`](./references/change-taxonomy.md)：

`api` 接口 / `model` 字段模型 / `schema` 表结构 / `flow` 流程状态 / `ui` 页面交互 /
`auth` 权限菜单 / `job` 定时任务 / `mq` 消息事件 / `integration` 外部集成 /
`config` 配置字典 / `query` 报表导出 / `nfr` 非功能。

- 跨类时写主类 + `secondary: []`；
- 归类看“改动的落点”，不看需求措辞：“支持按客户查询”可能是 `query`，也可能只是 `api` + `model`；
- 分布表本身就能看出需求是不是“伪大”。

### 第 4 步：拆子需求

一个子需求 = **一个可独立验收的行为变化**。

好的拆法：

- “新增电子签章”：拆成「签章参数落库」「调用签章服务」「签章失败补偿」；
- 按用户/系统可见行为拆，**不按 Controller/Service 层拆**；
- 每条标 `action`：`add` 新增 / `modify` 修改 / `remove` 下线。

拆完检查：每个子需求能不能单独演示？不能就继续拆；拆到 3 行代码一个子需求，说明拆过头了。

### 第 5 步：对照现有代码（最关键）

前置：项目已用 `java-project-tour` 扫过，`<项目根>/.knowledge/` 存在。查询顺序固定：

```bash
node .../tour.mjs core brief                       # 先看核心清单
node .../tour.mjs find 资产签发 --limit 10          # 关键词：路由 / 类名 / 表名 / 流程名
node .../tour.mjs where "资产签发 增加 签章字段"     # 改动触点，按层分组
node .../tour.mjs context <path>                   # 某个类的上下游
```

每个改动点写：

```json
{ "kind": "http", "file": "service-a-web/.../AssetIssueController.java", "line": 87,
  "symbol": "AssetIssueController#issue", "confidence": "verified", "note": "签发入口" }
```

规则：

- `file:line` 必须是真实存在的锚点；`verified` 只在读到注解/XML/方法体后使用；
- 只找到表、找不到代码 → 标 `inferred`，并开一条 P1 问题；
- **表结构改动先查 `data.json`**：这张表被几个 Mapper 读写、是否有 `risks`，直接影响估时；
- 流程类需求先查 `flows/index.json`：节点、`extHandler`、处理类是否在本项目仓库里；
- 无命中时：先 `core brief`，再换英文类名/路由片段/表名，再 `status` 看索引是否过期——**仍无命中就写“未找到”，不要编**。

### 第 6 步：新功能 —— 给出要加的类/方法

“新增”不能只写“加一个 Service”，要落到**能被开发直接照着建**的粒度：

```json
{ "layer": "service", "className": "AssetSealService", "methods": ["seal(AssetSealCommand cmd)"],
  "package": "com.example.asset.service", "pattern": "参照 AssetIssueService 的接口 + Impl 拆分",
  "reason": "签章调用要独立事务与重试" }
```

规则：

- **先找同层同类样例**：用 `find` 找一个已有接口/服务，`context` 看它的兄弟类，新类照抄命名与分层；
- `layer` 取值：`controller` / `service` / `provider` / `mapper` / `entity` / `dto` / `job` / `listener` / `config`；
- 新增接口要写清：路由、入参 DTO、返回体、错误码、幂等与权限；
- 新增表/字段同时进 `schema` 类，并给迁移与回滚方案（没有就开 P0 问题）；
- 能复用现有类就不要新建——新建是成本，不是产出。

### 第 7 步：估时

按**改动点**套基线，再乘因子，见 [`references/estimation.md`](./references/estimation.md)：

```json
"estimate": {
  "parts": [
    { "name": "后端接口 + 事务", "days": 1.0 },
    { "name": "联调签章服务", "days": 0.5 },
    { "name": "自测与文档", "days": 0.25 }
  ],
  "factors": [{ "name": "动核心流程", "multiplier": 1.3 }],
  "buffer": 1.5,
  "p50": 0,
  "p90": 0
}
```

- `parts` 至少包含开发与自测；跨仓库、外部联调单列；
- 因子只加**有证据**的：核心表/核心流程、无同类样例、多环境验证、历史兼容；
- `p50` / `p90` 由 `req.mjs estimate` 计算并写回，**不要手填**；
- 需求级汇总 = Σ 子需求 + 评审/统筹（默认 +10%，写进 analysis 的汇总表脚注）。

### 第 8 步：整理澄清问题

文档没写清、代码里找不到对应、两种实现都说得通——都进 `questions`：

| 级别 | 判定 | 处理 |
| --- | --- | --- |
| `P0` | 不回答就无法定接口/表结构/流程分支，阻塞开发 | 必须给“我方默认假设”，并注明按假设估时；`status` 停在 `draft` |
| `P1` | 影响估时或方案取舍 | 可先按假设推进，开发前确认 |
| `P2` | 文案、边界、体验 | 可后置 |

每条必须带：`question`（问什么）、`why`（为什么不清楚，引原文）、`assumption`（建议默认值）、`owner`（找谁）、`affects`（影响哪些子需求）。

- 问题超过 15 条，先归并成 5–8 个主题再问，别把清单甩给产品；
- 同一个不确定点不要重复问；已确认的写进 `assumption` 并标 `resolved`。

### 第 9 步：写 `analysis.md` + 校验

模板见 [`references/output-format.md`](./references/output-format.md)，固定八节：
结论 → 需求概览 → 大类分布 → 子需求明细 → 估时汇总 → 澄清问题 → 实施顺序 → 明确不做。

校验必须通过：

```bash
node <技能目录>/scripts/req.mjs validate <requirement.json>
```

### 第 10 步：回写核心标记

本次实际复用的核心类/表，顺手标记，让下一次查询更快：

```bash
node .../tour.mjs core mark --project "<项目根>" --class <相对路径> --table <表名> \
  --reason "需求分析：签章改动涉及" --by java-requirement-analysis
```

## 四、业务域与改动大类（速查）

**业务域**（先看这个，回答“哪块业务”）：

| 业务域 | 包含 | 不包含 |
| --- | --- | --- |
| `cust` 客户与建档 | 建档、建档变更、经办人/账户、实名面签、协议签署 | 产品开通、额度 |
| `product` 产品与开通 | 产品中心、开通/激活、单点登录、登录角色、报价 | 建档本身、额度 |
| `limit` 额度 | 开单/融资额度、同步、占用与释放、额度审核 | 报价、资产 |
| `asset` 资产与凭证开立 | 资产导入/维护/审核、开立、确权、签收、合同签署 | 流转/融资、作废、兑付 |
| `trade` 凭证流转与融资 | 转让、融资、放款、直保、资金方准入 | 开立、作废、兑付 |
| `abolish` 凭证作废 | 作废预申请、作废审核、结果通知 | 开立失败删除、兑付 |
| `repay` 兑付与结清 | 到期兑付、线下确认、结清、逾期 | 融资还款（归 `trade`） |
| `query` 查询与统计 | 查询中心、台账、驾驶舱、报表导出 | 监管报送 |
| `report` 监管报送 | 互金协会报送、发票报送、监管口径 | 内部报表 |
| `notify` 通知与预警 | 站内信、短信、邮件、企微告警、重试 | 业务状态机本身 |
| `channel` 渠道与集成 | 单点登录换码、银行/资方接口适配、文件交换 | 带业务规则的推送 |
| `platform` 平台与配置 | 菜单/权限、字典、参数、调度、部署 | 具体业务功能 |

**技术大类**（再看这个，回答“改成什么”）：

| 大类 | 典型信号 | 主要落点 | 基线（人天/点） |
| --- | --- | --- | --- |
| `api` | 新增/修改接口、加参数、改返回 | Controller / Dubbo / Feign | 0.25–1.0 |
| `model` | 字段透传、DTO/VO/Entity | Entity / DTO / 转换器 | 0.25–0.5 |
| `schema` | 加字段/索引/新表、刷数 | DDL / Mapper / 迁移脚本 | 0.25–2.0 |
| `flow` | 审批、状态流转、流程节点 | 工作流定义 / extHandler | 1.0–2.0 |
| `ui` | 页面、表单、列表、交互 | 前端工程 | 1.0–4.0 |
| `auth` | 菜单、按钮、角色、数据权限 | 权限表 / 拦截器 | 0.25–0.5 |
| `job` | 定时任务、批处理 | `@XxlJob` / 调度 | 0.5–1.0 |
| `mq` | 发消息、消费、补偿 | Producer / Listener | 0.5–1.0 |
| `integration` | 第三方 API、文件、支付、签章 | 适配层 + 联调 | 1.0–3.0 |
| `config` | 开关、字典、参数 | 配置表 / nacos | 0.25 |
| `query` | 报表、导出、复杂查询 | Mapper XML / 视图 | 0.5–2.0 |
| `nfr` | 性能、审计、日志、兼容 | 横切改造 | 0.5–2.0 |

## 五、质量闸门（不满足不要交付）

| 闸门 | 要求 |
| --- | --- |
| 图示识别 | 每张流程图/原型图都有 `diagrams[]` 条目，含 `nodes`（≥1）与 `branches`；识别失败标 `unresolved` 并开问题 |
| 范围裁剪 | 被删除线/修订删除的、标【下版本】【取消】的内容不得进 `subRequirements`；`excluded` 每条有 reason + 来源 |
| 双维度 | 每条子需求都有 `domain` + `category`；域分布里 0 条的业务域要说明是否漏项 |
| 来源覆盖 | `sources` 覆盖正文、每张图、每个附件；每个来源至少被一条子需求引用，未引用的在 §8 说明 |
| 可追溯 | 每个子需求都有 `sourceId` + 原文引用（页码/图号/表号）；没有引用的子需求不算需求 |
| 有锚点 | 每个改动点有 `path:line`；新增代码有 `layer/className/package/pattern` |
| 有分解 | 估时至少拆开发/自测；只有总数视为未估 |
| 问题分级 | P0 未清零 → `status: draft`，不能标 `analyzed/confirmed` |
| 不越界 | 只读代码与索引；不改业务代码、不建表、不跑构建 |

## 六、失败处理

| 现象 | 处理 |
| --- | --- |
| 文档读不出（扫描件无文字层） | 要可复制文本或清晰截图；按页让用户确认，不要靠图猜字段名 |
| 文档里有大量删除线 | 先按 `references/scope-filter.md` 用 `run.font.strike` 过滤，只分析保留文本；被删内容进 `excluded(struck)` |
| 文档里有【下版本】【取消】标记 | 整节排除并记 `excluded`；若本期功能依赖它，开 P0 问题 |
| 附件里有接口表但没读 | 典型漏需求：接口路径、字段必填、错误码只在表里；补读后重跑，估时会变 |
| Word 里的图片读不出 | 让用户补原图或文字；不要用“大概”补字段、流程分支 |
| 模型没有视觉能力 | 走 OCR：长图先切片（边长 1500、重叠 200），Windows OCR 只取 `Lines.Text`，中文去空格后按正文校正术语 |
| 流程图识别结果缺分支 | 标 `unresolved` 并开问题；分支条件（金额阈值/状态）不能靠猜 |
| 附件与正文、附件之间版本冲突 | P0：先定版本（哪份为准），再拆需求与估时 |
| 压缩包里多个文件 | 先列清单逐个登记 `sources`，不要只读第一个 |
| `.knowledge/` 不存在 | 先跑项目导览 `scan`，再回到第 5 步 |
| 索引 `stale` | 先 `tour status`，对 stale 仓库重扫；不要用旧索引估时 |
| 需求找不到任何代码锚点 | 可能是全新模块：全部标 `inferred`，开 P0 问“落在哪个系统/仓库” |
| 子需求 >20 条或 >30 人天 | 先出分期方案（本期/下期/不做），再逐期细化 |
| 涉及表结构变更但没有 DBA/迁移窗口 | P0 问题；估时里单列迁移与回滚 |
| 跨仓库契约变更（Dubbo/Feign） | `find` 出所有消费方，逐仓库列改动点，别只改提供方 |

## 七、与其他模块的衔接

- **环境准备**：`<项目根>/.env-prep/env-profile.json` 给出仓库清单与数据库；表行数可作“这功能是否真在用”的旁证；
- **项目导览**：`.knowledge/` 是锚点来源；`core.json` 是查询加速层，用完顺手 mark；
- **代码编写**：直接消费 `requirement.json` 的 `changePoints` 与 `newCode`，不需要重新找文件；
- **上下检查**：用 `analysis.md` 的“明确不做”和改动点清单做提交前核对。

## 八、边界

- 本技能**只读代码与文档**：不执行构建、不写业务代码、不改表；需要查库时只读，且优先测试库；
- 不替产品做决策：所有未确认项进 `questions`，`assumption` 只是建议默认值；
- 不承诺排期：给的是**工作量区间**（P50/P90），不是交付日期；排期要乘团队并行度与在制任务；
- 业务域用**需求方的口径**（建档、额度、开立、作废），不要自造“主数据治理”这类管理术语；
- **不做的不分析**：删除线内容、标注下版本/取消的章节，只进 `excluded` 与 §8，不产生子需求与人天；
- 需求文档本身不入库：`.requirements/` 默认进 `.gitignore`。
