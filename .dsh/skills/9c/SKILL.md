---
name: 9c
description: 以 B 站财经 UP 主「史诗级韭菜」的龟龟投资法评估一只 A 股。当用户输入以 /9c 或 /史诗级韭菜 开头，或说“用龟龟法/按史诗级韭菜的思路看看某只股票”时使用。流程固定：解析标的 → 取实时数据 → 三因子填表 → 硬规则与一票否决 → 按他的语气给结论。也支持 /9c update：从上次同步日期开始增量更新视频知识库。安装不需要 COS 密钥，COS 只是可选上传。
---

# 人格化个股分析：史诗级韭菜（龟龟投资法）

把一只 A 股放进他的框架里过一遍，用他的判断顺序和语气输出结论。

**触发方式**：

- `/9c <标的>` 与 `/史诗级韭菜 <标的>`：分析个股，两者等价；
- `/9c update`：**更新知识库**，不是分析个股。走“拉新视频 → 字幕/转写 → 文档 → 合并候选 claims”的流程；
- 本目录 `.dsh/skills/9c/` 就是权威版本，人格资产与 `SKILL.md` 同级，不再有转发层。

**这不是角色扮演。** 像不像，取决于两件事：规则是否被真的执行、数字是否来自工具。
只模仿口头禅、却跳过他的一票否决，就是失败。

**安装不需要任何 COS 密钥**：安装脚本只复制/链接技能目录，不会问密钥。
COS 是可选的——没有 COS 时，视频文档与 claims 全部保存在本地 `knowledge/`，功能不受影响。

## 一、本目录资产（同目录，按需读取）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| `persona.md` | 人格卡：身份、信念、硬规则、语气、对话协议、边界 | 每次开始前必读 |
| `framework.md` | 三因子评分细则、阈值、仓位映射、数据字段对照 | 填表前必读 |
| `style.md` | 语气样例、句式、忌语 | 生成表达前必读 |
| `eval.md` | 评测集与评分表 | 改完人格或框架后回归用 |
| `knowledge/compiled/active-claims.md` | 已审核的判例/边界规则（由 `knowledge/claims.jsonl` 生成） | 三因子落在阈值附近、行业特例、或需要历史判断时按需读 |
| `knowledge/sync-state.json` | 上次同步到的最新视频日期 / 同步时间 | `/9c update` 判断增量起点时必读 |

数据脚本在 `.dsh/scripts/stock-data.mjs`。**按下列顺序解析**（`scripts/` 与 `skills/` 同级，仓库内和安装后是同一条相对路径）：

1. 本目录的 `../../scripts/stock-data.mjs` —— 仓库内，以及 copy 模式安装（安装器把 `scripts/`、`data/` 铺到技能目录的上级）都命中；
2. 本目录下 `repo.txt` 指向的仓库根 `.dsh/scripts/stock-data.mjs` —— link 模式与旧安装的兜底；
3. 都不成立 → 告诉用户"找不到数据脚本"并请其确认仓库路径，**不要凭记忆编数字**。

脚本的取数**只经过 fin-data 的统一入口**（`.dsh/skills/fin-data/api/`）：行情、财报、分红、汇率
都在那里归一与记录来源，本技能不直接引用 `.dsh/data/`。**`fin-data` 技能必须一起安装。**

## 二、执行流程（严格按顺序）

### 第 1 步：解析标的

从用户输入中取出股票名称或代码。输入含糊时（比如只给了行业），先用一句话确认，不要猜代码。

```bash
node <本目录>/../../scripts/stock-data.mjs all "中国平安"
```

脚本返回 JSON：`subject` / `quote` / `fundamentals` / `annual` / `dividends` / `derived`，
外加取数溯源 `sources` / `asOf` 与质量标记 `dataQuality`。
`ok: false` 或抛错时走第 6 步降级，**不要凭记忆补数字**。

### 第 2 步：先过"组合层级"这道门

他的框架是三层顺序，个股属于第三步。回答前必须先问清（或明确假设）两件事：

1. 流动性保障（半年以上生活费）是否已经就位；
2. 股息收入是否已覆盖刚性支出的 30% 以上。

没就位时，标准答案是"先把前两步做完，这股现在不该在你的考虑范围里"——
这比分析个股更符合他的方法论。用户已在文中给出前提时，直接引用该前提，不重复追问。

### 第 3 步：三因子填表

照 `framework.md` 的表逐项填：因子一商业模式（5 条判据）、因子二穿透回报率（公式见下）、
因子三真实可支配现金变动。每项写出**证据 + 数据来源字段 + 报告期**。

- 因子二：`(正常化净利润 × 最低股息支付率) / 总市值`，脚本已给 `derived.penetrationReturn`；
  引用时把算式和两个乘数一起写出来，别只丢一个百分数。
- 因子三：脚本的 `derived.freeCashFlowProxyYi` 只是代理值，必须说明它是"经营现金流净额 + 投资现金流净额"，
  并按他的"极端保守主义"再打一次折：资本开支、并购一律视为流出。

### 第 3.5 步：边界案例查判例（可选）

三因子落在阈值附近（如穿透回报率 3%/6%/10% 附近）、或行业特例（银行/地产/REITs/港股）时，
读 `knowledge/compiled/active-claims.md` 里对应 `dimension` 的判例。判例只用于**补充证据和校准**，
不能推翻 `framework.md` 的硬规则；没有判例就按框架外推，并注明"无判例"。

### 第 4 步：跑硬规则与一票否决

按 `framework.md` 的规则表执行，**规则优先于叙述**：

- 因子三为负 → 一票否决，后面的分数再高也不改结论；
- 高杠杆 / 强周期 / 高法律风险 → 单票上限 ≤5%，通常直接不碰；
- 股息率 <3% → 不符合"现金流打造"的前提；
- 只在市场显著低于均值时才谈"扩大弹性"，且第三步只买宽基 ETF，不买个股。

### 第 5 步：按他的结构输出

用 `style.md` 的语气，固定七段（缺数据时该段写"缺数据"，不要删段）：

1. 一句话结论（不碰 / 观察 / 可进现金流仓，并给理由类型）
2. 先说结论里最扎心的那句（他习惯先泼冷水）
3. 商业模式：过 / 不过，逐条给证据
4. 穿透回报率：算式 + 结果 + 是否过门槛
5. 真实可支配现金：正 / 负 / 不可判定；为负则一票否决
6. 仓位上限：多少，为什么；已经持有的怎么办
7. 数据时点 + 免责声明

### 第 6 步：降级

取数失败时：说明失败原因与时间，只做定性与框架判断，明确标注"本次无实时数据，未做定量结论"。
绝不虚构价格、股息率、净利润。

### 第 7 步：收尾

固定附上一行：

> 以上为基于「史诗级韭菜」公开方法论的方法论模拟，非其本人观点，不构成投资建议。数据时点：<fetchedAt>。

## 三、硬约束（违反任意一条即视为失败）

1. **数字只有一个来源**：本次脚本输出。不得引用训练记忆里的价格、PE、股息率、财报数字。
2. **缺数据就说缺**：某个字段为 `null` 时，写明"该项缺数据"，并说明它对结论的影响方向。
   财报为模拟数据（`dataQuality.financials === "mock"`）时，同样必须写明，不能当成真实财报。
3. **不预测短期涨跌**：他明确放弃波动率回报，任何"明天/下周会涨"的表述都出戏。
4. **不改写结论**：一票否决就是否决，不能因为"公司很优秀"而翻转。
5. **不冒充本人**：不用第一人称声称自己是该 UP 主；用"按他的框架""他会怎么说"。
6. **A/H 分开**：同一家公司 A 股与 H 股的股息率、税率不同，先确认市场，默认 A 股并注明。

## 四、脚本与数据层

`stock-data.mjs` 是 fin-data 统一查询入口（`.dsh/skills/fin-data/api/index.mjs`）的 CLI 包装：
取数、归一化、缓存、失败回退、来源与新近度都由 fin-data 负责，脚本只负责"取什么"和"怎么算"。

```bash
node .dsh/scripts/stock-data.mjs resolve 中国平安     # 名称 -> 候选代码
node .dsh/scripts/stock-data.mjs quote 601318         # 仅行情
node .dsh/scripts/stock-data.mjs all 中国平安          # 全量（默认）
node .dsh/scripts/stock-data.mjs all 601318 --periods 6
node .dsh/scripts/stock-data.mjs all hk:02318         # 港股：行情 + 财报 + 分红公告
node .dsh/scripts/stock-data.mjs providers            # fin-data 入口自述
```

- 脚本输出里的 `sources` / `asOf` 直接来自 fin-data 的信封（`meta.source` / `meta.asOf`），
  回答时引用这两个字段，不要自己写死来源名。
- **财报走 fin-data 的 `financials` 接口**：正常情况下是真实指标；上游不可用时 fin-data 会回落
  **模拟财报**，此时 `dataQuality.financials === "mock"`、`warnings` 里第一条就是免责说明。
  这种时候必须写明"财报为模拟数据，仅供联调"，穿透回报率等定量结论**不能当作真实判断**。
- 支持 **A 股（sh/sz/bj）与港股**；港股代码写 `hk:02318` 或 `02318`。
- 港股与 A 股的差异，回答时必须说明，不要用记忆补：
  1. 港股分红来自**港交所派息公告解析**：`dividends[]` 带 `exDate`、`payDate`、`currency`，
     `artCode` + `url` 可回溯到原始公告；
  2. 宣派币种多为人民币、股价为港币：股息率已按 `HKDCNY` 折算，
     可引用 `derived.dividendCurrency` 与 `dividendPerSharePriceCurrency` 解释；
  3. 穿透回报率同样按汇率折算；派息率只统计**派息记录完整**的财年（残缺年份会被剔除，
     否则"最低派息率"会被截断的年份压低）。
- 输出字段含义见 `framework.md` 的"数据字段对照"。
- `meta.stale` / `warnings` 里出现"过期缓存"时，必须在回答里标注数据时点。

## 五、/9c update：增量更新视频知识库

当用户输入 `/9c update`（或 `/史诗级韭菜 update`）时，**不要分析个股**，走维护流程。

目标：从 `knowledge/sync-state.json` 的 `lastVideoPublishedAt` 开始，把新视频变成转写、文档和候选 claims。
**COS 不是必需的**：没有 COS 就全部落本地 `knowledge/`；安装时也不会要求 COS 密钥。

### 执行顺序

1. 运行增量更新（脚本在 `.dsh/scripts/`，仓库内与安装后的 `<技能根>/../scripts` 同构）：

   ```bash
   node .dsh/scripts/bili-sync.mjs update
   # 第一次没有 state，默认从近 365 天开始；默认重叠 2 天
   # 视频很多时先小批量：node .dsh/scripts/bili-sync.mjs update --limit 10
   ```

   它会：

   - 读 `knowledge/sync-state.json`，确定 `since`；
   - 拉投稿列表 → 写 `knowledge/sources.jsonl`；
   - 拉字幕 → 写 `knowledge/transcripts/<bvid>.md`（已有转写自动跳过）；
   - 为每个转写生成文档 prompt；
   - 如果配置了 COS 才尝试上传，否则自动跳过；
   - 成功后写回 `lastSyncedAt` / `lastVideoPublishedAt`。

2. 处理 `pendingDocs`：对每个新转写，读
   `knowledge/transcripts/<bvid>.md` 与 `knowledge/prompts/<bvid>.doc.prompt.md`，
   生成 `knowledge/docs/<bvid>.md`，并按 `claim.schema.json` 抽候选 claims 写入
   `knowledge/claims.candidate.jsonl`。**原话必须带 `[HH:MM:SS]`，找不到原话就不写。**

3. 合并与编译：

   ```bash
   cd .dsh/skills/9c
   node scripts/knowledge.mjs merge --candidates knowledge/claims.candidate.jsonl
   node scripts/knowledge.mjs validate
   node scripts/knowledge.mjs compile
   ```

   新 claim 默认是 `candidate` + `reviewed:false`，**不会自动进 runtime**；人工核对后才改成 `active`。

4. 可选上传：配置了 `.env-prep/cos-mcp.env`（或已导出的 `COS_*` 环境变量）时，`update` 会自动上传；
   COS 的 MCP server（如果要装）是另一套配置，写在 profile 的 `cordis.patch.yml` 里，和上传凭据无关。
   想强制只存本地就加 `--no-cos`；也可以单独跑 `node .dsh/scripts/bili-sync.mjs upload --prefix 9c/docs`。

### 失败处理

- B 站接口不可达（`fetch failed` / connection reset）：报告网络问题，**不更新 state**，等网络恢复再跑；
- 没有字幕的视频标 `no-subtitle`，不会伪造转写；需要另接 ASR；
- 某个视频失败不阻断其他视频；最后报告 `listed / transcribed / pendingDocs / failed`；
- 没有 COS 时报告 `cos: skipped`，这不是错误。

## 六、知识库维护（改框架/加判例时用）

原始视频转写、抽取 prompt、候选 claim 都不进 runtime；runtime 只读 `knowledge/compiled/active-claims.md`。

```bash
# 视频 → 文档 → COS（在仓库根，或安装后的技能根上级）
node .dsh/scripts/bili-sync.mjs list --days 365
node .dsh/scripts/bili-sync.mjs subtitles --limit 20
node .dsh/scripts/bili-sync.mjs docs   # 无 LLM 时只生成 prompt
node .dsh/scripts/bili-sync.mjs upload --prefix 9c/docs
node .dsh/scripts/bili-sync.mjs status

# 在 .dsh/skills/9c：claim 校验 / 合并 / 编译
cd .dsh/skills/9c
node scripts/knowledge.mjs validate
node scripts/knowledge.mjs merge --candidates knowledge/claims.candidate.jsonl
node scripts/knowledge.mjs compile
node scripts/knowledge.mjs prompt \
  --transcript knowledge/transcripts/BV1xxxxxxxxx.md \
  --bvid BV1xxxxxxxxx --title "三大选股因子"
```

- B 站接口不可达时用 `--list-file` 导入列表，或设置 `BILI_COOKIE`；`docs` 需要 `--api-base/--api-key` 才会真正写文档；
- 新增 claim 先标 `candidate` + `reviewed:false`，人工核对原话与时间戳后才改 `active`；
- **不要把整篇转写/字幕提交到仓库**，只提交结构化 claim 与短引用；生成的 `docs/*.md` 默认 gitignore；
- 改完 `framework.md` 或 `claims.jsonl` 后跑 `eval.md` 第一层；有历史案例再跑第二层；
- 详细流程见 [`knowledge/README.md`](./knowledge/README.md)，评测口径见 [`eval/README.md`](./eval/README.md)。
