# 产物格式

两个产物：`requirement.json`（唯一事实来源）与 `analysis.md`（人读报告）。

## requirement.json

```json
{
  "schema": 2,
  "id": "req-v3.0.0-asset-seal",
  "version": "3.0.0",
  "title": "资产签发支持电子签章",
  "project": "jasolar",
  "status": "draft",
  "receivedAt": "2026-11-05",
  "sources": [
    { "id": "SRC-1", "file": "PRD-资产签发.docx", "kind": "document", "locator": "p.1-12", "note": "产品：张三" },
    { "id": "SRC-2", "file": "PRD-资产签发.docx#图3", "kind": "image", "locator": "p.5 签发流程图", "note": "" },
    { "id": "SRC-3", "file": "附件1-接口定义.xlsx", "kind": "api", "locator": "Sheet1!A1:H24", "note": "签发接口字段" }
  ],
  "excluded": [
    { "id": "EX-1", "label": "补充协议状态与签署弹窗", "reason": "next-version",
      "sourceId": "SRC-1", "locator": "3.3.4 标题【下版本】补充协议", "note": "整节标注下版本" },
    { "id": "EX-2", "label": "企业账户信息同步", "reason": "cancelled",
      "sourceId": "SRC-1", "locator": "3.3.3 标题【1012取消】账户变更", "note": "标题标注取消" }
  ],
  "subRequirements": [
    {
      "id": "SR-1",
      "title": "签发接口增加签章方式参数",
      "domain": "asset",
      "secondaryDomains": ["limit"],
      "category": "api",
      "secondary": ["model"],
      "action": "modify",
      "sourceId": "SRC-3",
      "locator": "Sheet1 第 12 行",
      "quote": "签发接口需支持传入签章方式：无 / 平台签章 / 第三方签章",
      "acceptance": ["不传时保持原行为", "非法签章方式返回 400"],
      "changePoints": [
        {
          "kind": "http",
          "file": "service-a-web/src/main/java/com/example/asset/controller/AssetIssueController.java",
          "line": 87,
          "symbol": "AssetIssueController#issue",
          "confidence": "verified",
          "note": "签发入口"
        }
      ],
      "newCode": [],
      "estimate": {
        "parts": [
          { "name": "后端接口", "days": 1.0 },
          { "name": "自测", "days": 0.25 }
        ],
        "factors": [{ "name": "动核心流程", "multiplier": 1.3 }],
        "buffer": 1.5,
        "p50": 1.75,
        "p90": 2.75,
        "note": ""
      },
      "risks": [],
      "dependsOn": [],
      "openQuestions": ["Q-1"]
    }
  ],
  "questions": [
    {
      "id": "Q-1",
      "severity": "P0",
      "question": "平台签章失败时，签发单是否回滚？",
      "why": "原文只写“失败可重试”，未定义事务边界（p.5）",
      "assumption": "签章失败整单回滚，由用户重新发起",
      "owner": "产品/张三",
      "affects": ["SR-1"],
      "resolved": false
    }
  ],
  "totals": { "p50": 1.75, "p90": 2.75, "byCategory": { "api": 1.75 }, "byDomain": { "asset": 1.75 } },
  "generatedAt": "2026-11-05T08:00:00.000Z",
  "updatedAt": "2026-11-05T08:00:00.000Z"
}
```

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 目录名，`req-v<版本>-<短名>`（推荐）或 `req-<yyyymmdd>-<短名>` |
| `version` | 否 | 版本号，如 `3.0.0`，与 id 保持一致 |
| `status` | 是 | `draft` / `analyzed` / `confirmed`；P0 未清零只能 `draft` |
| `receivedAt` | 是 | 需求收到日期 |
| `excluded[]` | 是 | 排除项：`id`（`EX-<n>`）/ `label` / `reason` / `sourceId` / `locator` / `note` |
| `excluded[].reason` | 是 | `struck`（删除线/修订删除）/ `next-version` / `cancelled` / `out-of-scope` / `no-anchor` / `other` |
| `sources[]` | 是 | 至少一条；`id`（`SRC-<n>`）/ `file` / `kind` / `locator` / `note` |
| `sources[].kind` | 是 | `document` / `image` / `api` / `table` / `attachment` / `other` |
| `subRequirements[].sourceId` | 建议 | 指回 `sources[].id`；缺省给警告 |
| `subRequirements[].locator` | 否 | 页码 / 图号 / 工作表与行号 |
| `subRequirements[].category` | 是 | 12 类之一，见 `change-taxonomy.md` |
| `subRequirements[].domain` | 是 | 12 个业务域之一，见 `business-domains.md` |
| `subRequirements[].secondaryDomains` | 否 | 次域，最多 2 个，同样受枚举约束 |
| `subRequirements[].secondary` | 否 | 次类，同样受枚举约束 |
| `subRequirements[].action` | 是 | `add` / `modify` / `remove` |
| `subRequirements[].quote` | 是 | 原文引用 + 页码；没有引用不算需求 |
| `changePoints[].kind` | 是 | `http` / `dubbo` / `job` / `mq` / `feign` / `table` / `model` / `config` / `ui` / `class` |
| `changePoints[].confidence` | 是 | `verified` / `inferred` / `unresolved` |
| `newCode[].layer` | 是 | `controller` / `service` / `provider` / `mapper` / `entity` / `dto` / `job` / `listener` / `config` / `other` |
| `estimate.parts` | 是 | 至少一项，`days > 0` |
| `estimate.factors` | 否 | `multiplier > 0`，乘法叠加 |
| `estimate.buffer` | 否 | 默认 1.5，限 1.2–2.0 |
| `estimate.p50/p90` | 是 | 由 `req.mjs estimate` 写入 |
| `questions[].severity` | 是 | `P0` / `P1` / `P2` |
| `questions[].affects` | 否 | 子需求 id 列表 |
| `questions[].resolved` | 否 | 已确认的问题保留记录，置 `true` |

### 校验规则（`req.mjs validate`）

- `id` 必须匹配 `req-v3.0.0-<短名>` 或 `req-<yyyymmdd>-<短名>`；
- `diagrams[]` 每项要有 `title` / `kind` / `sourceId` / `confidence`，且 `nodes` 至少一条；图片来源必须有对应 `diagrams` 条目（否则警告）；
- 子需求 id 唯一且为 `SR-<n>`；问题 id 唯一且为 `Q-<n>`；来源 id 唯一且为 `SRC-<n>`；
- `sources` 至少一条，`file` 非空，`kind` 在六类枚举内；没有 `kind: document` → 警告；
- `excluded[]` 每条要有 `label`、`reason`（枚举内）、`sourceId`（必须存在于 `sources`）；`id` 唯一且为 `EX-<n>`；
- 子需求 `sourceId` 必须指向存在的来源；未填 → 警告；来源未被任何子需求引用 → 警告（可能漏读）；
- `category` / `secondary` / `action` / `kind` / `confidence` / `layer` / `severity` 必须在枚举内；
- `domain` 必须在 12 个业务域内；`secondaryDomains` 最多 2 个；`platform` / `channel` 兜底会告警；
- `totals.byDomain` 必须与子需求求和一致（`estimate` 自动写）；
- `quote` 非空；`changePoints` 至少一条，且 `file` 非空、`line` 为正整数；
- `newCode` 每项要有 `className` / `package` / `reason`；
- `estimate` 重算结果与文件里的 `p50/p90` 一致（差 >0.26 视为未重算）；
- `dependsOn` 指向存在的子需求，且无环；
- `status != draft` 时不允许存在未解决的 P0；
- `totals` 与各子需求求和不一致即报错；
- 非 `verified` 的改动点没有关联问题 → 警告。


## diagrams[]（流程图与原型图）

```json
"diagrams": [
  {
    "id": "DG-1",
    "sourceId": "SRC-4",
    "title": "凭证开立主流程",
    "kind": "flow",
    "lanes": ["本地客户端", "本地内管端", "SAAS 产融平台", "SAAS 讯易链"],
    "nodes": [
      { "seq": 1, "actor": "集团采购专员", "action": "资产导入", "system": "本地客户端" },
      { "seq": 2, "actor": "系统", "action": "校验开单额度", "system": "本地", "branch": "通过 / 不通过" }
    ],
    "branches": [
      { "from": "校验开单额度", "condition": "不通过", "to": "提示额度不足并终止" }
    ],
    "thresholds": [
      { "field": "开单金额", "op": ">=", "value": 100, "unit": "万元", "to": "集团资金初审" }
    ],
    "integrations": ["资产导入", "单点登录-换码", "单点登录-取链"],
    "confidence": "inferred",
    "note": "OCR 识别，术语按正文校正"
  }
]
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `DG-<n>` |
| `sourceId` | 是 | 指向 `sources[]` 里的 image 条目 |
| `kind` | 是 | `flow` / `sequence` / `state` / `ui` / `arch` / `other` |
| `nodes` | 是 | 至少一条；`actor` 谁、`action` 做什么、`system` 在哪 |
| `branches` | 建议 | `from` / `condition` / `to` |
| `thresholds` | 建议 | 金额、数量、日期阈值单独列 |
| `integrations` | 建议 | 图上出现的所有外部调用 |
| `confidence` | 是 | 视觉直读 `verified`；OCR 校正 `inferred`；失败 `unresolved` |

## analysis.md 模板

```markdown
# <需求标题> · 需求分析

> 需求来源：<正文> + <图 n 张> + <附件 m 个>｜分析日期：<date>｜状态：draft

## 1. 一句话结论

<改哪些系统、大概多少人天、有几个阻塞问题。>

## 2. 需求概览

| 项 | 值 |
| --- | --- |
| 来源 | 正文 1 + 图 2 + 附件 1 |
| 需求条目 | <n> 条 |
| 子需求 | <n> 条 |
| 业务域 | cust 5 / asset 2 / limit 1 |
| 改动大类 | api 2 / schema 1 / flow 1 |
| 工作量 | P50 <x> 人天 / P90 <y> 人天 |
| 阻塞问题 | P0 <n> 条 |

### 图示解析

| 图 | 来源 | 类型 | 节点数 | 关键分支 | 置信度 |
| --- | --- | --- | --- | --- | --- |

### 来源清单

| 编号 | 文件 / 内嵌对象 | 类型 | 位置 | 用途 |
| --- | --- | --- | --- | --- |
| SRC-1 | PRD.docx | document | p.1-12 | 正文需求 |
| SRC-2 | PRD.docx#图3 | image | p.5 | 签发流程分支 |
| SRC-3 | 附件1-接口定义.xlsx | api | Sheet1!A1:H24 | 接口字段与错误码 |

## 3. 业务域分布

| 业务域 | 子需求 | P50 | 说明 |
| --- | --- | --- | --- |

## 3.1 技术大类分布

| 大类 | 子需求 | P50 | 说明 |
| --- | --- | --- | --- |

## 4. 子需求明细

### SR-1 <标题>

- 来源：<SRC-n> · <locator>
- 原文：「<quote>」
- 验收：<acceptance>
- 改动点：

| 类型 | 位置 | 符号 | 置信度 | 说明 |
| --- | --- | --- | --- | --- |

- 新增代码（无则写“无”）：

| 层 | 类 | 方法 | 包 | 参照 |
| --- | --- | --- | --- | --- |

- 估时：<p50> / <p90> 人天（<parts 拆分 + 因子>）
- 风险 / 依赖：<...>

## 5. 估时汇总

| 子需求 | P50 | P90 |
| --- | --- | --- |
| **合计** | **<x>** | **<y>** |

> 含评审与统筹 +10%；人天不等于日历天。

## 6. 待澄清问题

### P0（阻塞）

| # | 问题 | 建议默认值 | 找谁 | 影响 |
| --- | --- | --- | --- | --- |

### P1

...

### P2

...

## 7. 建议实施顺序

1. ...
2. ...

## 8. 明确不做（本次范围外）

| # | 排除内容 | 原因 | 依据 |
| --- | --- | --- | --- |
| EX-1 | <label> | 下版本 / 取消 / 删除线 / 本期不做 / 无锚点 | <来源 + 章节> |

> 本表由 `requirement.json` 的 `excluded[]` 生成，不要手写另一份清单。
```

## 写作要求

- 数字只来自 `requirement.json`：人天、条数、锚点不要另算一套；
- 每个子需求必须能在 §4 找到至少一个 `path:line` 或一条 `newCode`；
- §8 必须写：需求文档没提、但容易被顺手带上的东西（比如“顺便加个导出”），明确排除；
- 不确定的措辞用“待确认”，不要用“应该”“大概”。
