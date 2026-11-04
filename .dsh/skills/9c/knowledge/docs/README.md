# 视频文档（distilled）

每支视频一份 Markdown，由 `knowledge/transcripts/<bvid>.md` 提炼而来：

```text
knowledge/docs/<bvid>.md
```

文档结构建议固定：

```markdown
# 视频标题

- bvid:
- 发布日期:
- 时长:
- 来源: CC 字幕 / ASR
- 校对状态:

## 一句话结论
## 他讲了什么
## 可执行规则（只写明确说过的）
## 案例与标的
## 关键原话（带时间戳）
## 与 framework 的差异 / 冲突
```

文档只做“结构化 + 摘录”，不把转述写成原话；原话必须带 `[HH:MM:SS]`。
`claims.jsonl` 的抽取单独走 `scripts/knowledge.mjs prompt`，审核后才标 active。
