# 9c 判例知识库

把「他公开视频里的判断」变成**可验证、可版本化、可评测**的资产，而不是一堆整篇转写。

运行时只读 `compiled/active-claims.md`；原始转写和候选 claim 不进模型上下文。

## 目录

```text
knowledge/
├── sources.jsonl             # 视频清单（只做索引，不存字幕）
├── claims.jsonl              # 原子判断（人工审核后 status=active）
├── cases.jsonl               # 他对具体股票的判断 + 结果标签（可选）
├── glossary.json             # ASR 纠错词表 / 股票名映射
├── contradictions.md         # 观点冲突与裁决记录
├── changelog.md              # 知识库变更日志
├── claim.schema.json         # claim JSON Schema
├── case.schema.json          # case JSON Schema
├── transcripts/              # 带时间戳转写（本地，gitignore）
├── prompts/                  # 生成的抽取 prompt（本地，gitignore）
└── compiled/                 # 由 claims.jsonl 生成，runtime 读这里
    ├── active-claims.md
    ├── active-claims.json
    └── stats.json
```

`sources.jsonl` 一行一支视频：

```json
{"bvid":"BV1xxxxxxxxx","title":"三大选股因子","publishedAt":"2025-04-12","durationSec":1421,"type":"method","url":"https://www.bilibili.com/video/BV1xxxxxxxxx","status":"transcribed","note":""}
```

`type` 建议用 `method`（方法论）/ `case`（个股复盘）/ `qa` / `macro` / `other`；优先抽 `method` 与 `case`，
跳过纯新闻和情绪输出。

## 数据流

```text
视频元数据
  → 字幕 / 音频转写（带 [HH:MM:SS] 时间戳）
  → scripts/knowledge.mjs prompt（生成抽取提示词）
  → 大模型输出 claims.candidate.jsonl（status=candidate, reviewed=false）
  → 人工核对 quote / 时间戳 / 是否把 case 写成 rule
  → 合并进 claims.jsonl，status=active + reviewed=true
  → scripts/knowledge.mjs compile
  → compiled/active-claims.md（runtime 只读这个）
```

## 常用命令

```bash
cd .dsh/skills/9c

node scripts/knowledge.mjs init
node scripts/knowledge.mjs validate
node scripts/knowledge.mjs validate --json
node scripts/knowledge.mjs compile
node scripts/knowledge.mjs stats

node scripts/knowledge.mjs prompt \
  --transcript knowledge/transcripts/BV1xxxxxxxxx.md \
  --bvid BV1xxxxxxxxx \
  --title "三大选股因子"
```

- `validate` 会检查 id 唯一、日期、枚举、证据格式、`active` 必须 `reviewed:true`、`supersedes` 引用是否存在；
- `compile` 只把 `status=active` 且 `reviewed=true` 的条目写进 `compiled/`；
- `prompt` **不联网**，只把 schema 和转写拼成提示词，粘给任何模型即可。

## 一条 claim 长什么样

```json
{
  "id": "BV1xx-003",
  "type": "rule",
  "dimension": "valuation",
  "statement": "穿透回报率低于 3% 不在体系内",
  "conditions": ["A股"],
  "as_of": "2025-04-12",
  "effective_from": "2025-04-12",
  "status": "active",
  "confidence": "high",
  "reviewed": true,
  "reviewed_at": "2026-11-04",
  "reviewed_by": "repo",
  "supersedes": null,
  "evidence": {
    "kind": "video",
    "bvid": "BV1xxxxxxxxx",
    "t": 1832,
    "quote": "三年股息率不到 3 个点，这个就不在我的体系里"
  },
  "notes": "人工核对过原话；t 是秒数"
}
```

规则：

- **`quote` 必须是原话**，不能是转述；`t` 是视频内秒数；
- 没有 `bvid + t + quote` 的 video 证据不要标 `active`；
- 现有 `framework.md` 里的规则可以用 `evidence.kind = "framework"` 入库，`notes` 注明「不是视频原话」；
- `type=case` 只描述具体案例；不要把案例总结成普遍规则；
- 观点变化用 `supersedes` / `superseded_by` 串起来，不要取平均；
- `deprecated` 的条目保留，不要删，方便回看为什么改。

## 审核标准（active 之前）

- [ ] `quote` 与视频原话一致，时间戳能对上；
- [ ] 这句话是**规则/边界**，不是一次性的市场评论；
- [ ] `conditions` 写清了适用范围（A 股/港股、行业、市场水位）；
- [ ] 与现有 claim 不重复；冲突的已写进 `contradictions.md`；
- [ ] 不是事后归因；如果视频是复盘，明确标 `case` 而不是 `rule`。

## 隐私与版权

- 原始转写、音频、prompt 都在本地，`transcripts/*.md` 与 `prompts/*.md` 已 gitignore；
- 仓库只提交**结构化 claim + 短引用**；不要把整篇转写、字幕文件、视频上传到公开仓库；
- 引用只用于方法论研究，注明 bvid 与时间点，不冒充本人。

## 结果评测

`cases.jsonl` 收录他公开说过的股票判断（stance / thesis / as_of / horizon），有行情后补 `outcome`；
评测口径见 [`../eval/README.md`](../eval/README.md) 与 [`../eval/rubric.md`](../eval/rubric.md)。

注意：评测要使用**当时可得**的价格、财报、股息率，不能用今天的数字回看历史。
