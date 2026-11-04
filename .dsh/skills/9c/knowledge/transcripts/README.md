# 原始转写（本地）

每支视频一个 Markdown，文件名用 bvid：

```text
BV1xxxxxxxxx.md
```

格式：

```markdown
# 视频标题

- bvid: BV1xxxxxxxxx
- 发布日期: 2025-04-12
- 时长: 23:41
- 来源: B站 CC 字幕 / Whisper large-v3
- 校对: 已人工校对股票名与数字

## 转写

[00:00:00] ...
[00:00:08] ...
```

这个目录默认被 `.gitignore` 忽略：转写可能很长，也可能涉及版权。只把抽取后的 claim 提交进 `claims.jsonl`。
