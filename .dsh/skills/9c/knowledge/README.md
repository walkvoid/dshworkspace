# 9c 判例知识库

把「他公开视频里的判断」变成**可验证、可版本化、可评测**的资产，而不是一堆整篇转写。

运行时只读 `compiled/active-claims.md`；原始转写和候选 claim 不进模型上下文。

## 目录

```text
knowledge/
├── sources.jsonl             # 视频清单（只做索引，不存字幕）
├── sync-state.json           # 增量更新水位（lastVideoPublishedAt / lastSyncedAt）
├── claims.jsonl              # 原子判断（人工审核后 status=active）
├── claims.candidate.jsonl    # 大模型抽出的候选 claim（merge 前）
├── cases.jsonl               # 他对具体股票的判断 + 结果标签（可选）
├── glossary.json             # ASR 纠错词表 / 股票名映射
├── contradictions.md         # 观点冲突与裁决记录
├── changelog.md              # 知识库变更日志
├── claim.schema.json         # claim JSON Schema
├── case.schema.json          # case JSON Schema
├── transcripts/              # 带时间戳转写（本地，gitignore）
├── prompts/                  # 抽取/文档 prompt（本地，gitignore）
├── docs/                     # 提炼后的视频文档（本地，gitignore，README 除外）
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
sync-state.json（上次最新视频日期）
  → 增量 list（list --since）
  → 字幕 / 音频转写（subtitles，带 [HH:MM:SS] 时间戳）
  → 文档 prompt / 大模型文档（docs）
  → COS 上传（upload，可选；没配置就跳过）
  → scripts/knowledge.mjs prompt（claim 抽取提示词）
  → 大模型输出 claims.candidate.jsonl（status=candidate, reviewed=false）
  → 人工核对 quote / 时间戳 / 是否把 case 写成 rule
  → scripts/knowledge.mjs merge（进 claims.jsonl，仍是 candidate）
  → 审核后改 status=active + reviewed=true
  → scripts/knowledge.mjs compile
  → compiled/active-claims.md（runtime 只读这个）
```

## /9c update：增量更新

```bash
# 从 sync-state.json 的最后视频日期开始（第一次默认近 365 天，默认重叠 2 天）
node .dsh/skills/9c/scripts/bili-sync.mjs update

# 视频多时先小批量
node .dsh/skills/9c/scripts/bili-sync.mjs update --limit 10

# 强制只存本地，不上传
node .dsh/skills/9c/scripts/bili-sync.mjs update --no-cos
```

`update` 会写回 `knowledge/sync-state.json`：

```json
{
  "lastSyncedAt": "2026-11-04T...",
  "lastVideoPublishedAt": "2026-10-31",
  "lastVideoBvid": "BV...",
  "lastRun": { "listed": 5, "transcriptsOk": 4, "pendingDocs": 4, "cos": "skipped" }
}
```

- 第一次运行没有 `lastVideoPublishedAt`，从 `--days 365` 开始；
- 之后从 `lastVideoPublishedAt - overlap-days` 开始，避免跨天漏视频；
- 没有 COS 时 `cos: skipped`，文档仍在 `knowledge/docs/`，不是失败；
- B 站不可达时直接报错，不写 state，网络恢复后重跑。

## 视频 → 文档 → COS

在**仓库根目录**执行（`.dsh/skills/9c/scripts/bili-sync.mjs`，脚本就在 9c 技能里）：

```bash
# 1. 拉近一年投稿，写 knowledge/sources.jsonl
node .dsh/skills/9c/scripts/bili-sync.mjs list --days 365

# 1.1 或增量：从 sync-state.json 继续
node .dsh/skills/9c/scripts/bili-sync.mjs update --limit 20

# 2. 拉字幕，写 knowledge/transcripts/<bvid>.md
node .dsh/skills/9c/scripts/bili-sync.mjs subtitles --limit 20

# 3. 生成文档 prompt；配置了 LLM 才直接生成 docs
node .dsh/skills/9c/scripts/bili-sync.mjs docs \
  --api-base https://api.deepseek.com/v1 --api-key "$LLM_API_KEY" --model deepseek-chat

# 4. 上传 knowledge/docs/*.md 到 COS（没配置 COS 会自动跳过）
node .dsh/skills/9c/scripts/bili-sync.mjs upload --prefix 9c/docs

# 5. 看进度
node .dsh/skills/9c/scripts/bili-sync.mjs status
```

- B 站接口需要外网；被拦时用 `--list-file` 导入另一台机器抓好的列表，或设置 `BILI_COOKIE`；
- 只有 B 站字幕时不需要 ASR；没有字幕的视频会标 `no-subtitle`，需要另接 ASR；
- `docs` 不配置 LLM 时只写 `knowledge/prompts/*.doc.prompt.md`，不会伪造文档；
- 生成的 `docs/*.md` 默认 gitignore，只把结构化 claim 提交进仓库。

## 常用命令

```bash
cd .dsh/skills/9c

node scripts/knowledge.mjs init
node scripts/knowledge.mjs validate
node scripts/knowledge.mjs validate --json
node scripts/knowledge.mjs compile
node scripts/knowledge.mjs stats

# 把大模型抽出的候选 claim 合并进 claims.jsonl（强制 candidate / reviewed:false）
node scripts/knowledge.mjs merge --candidates knowledge/claims.candidate.jsonl
node scripts/knowledge.mjs merge --candidates knowledge/claims.candidate.jsonl --dry-run

node scripts/knowledge.mjs prompt \
  --transcript knowledge/transcripts/BV1xxxxxxxxx.md \
  --bvid BV1xxxxxxxxx \
  --title "三大选股因子"
```

- `validate` 会检查 id 唯一、日期、枚举、证据格式、`active` 必须 `reviewed:true`、`supersedes` 引用是否存在；
- `compile` 只把 `status=active` 且 `reviewed=true` 的条目写进 `compiled/`；
- `merge` 只接受通过校验的 candidate，重复 id 自动跳过，写前备份 `claims.jsonl.bak`；
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
