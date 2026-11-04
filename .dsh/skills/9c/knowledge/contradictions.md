# 观点冲突记录

同一主题前后说法不一致时记在这里，不要直接把两个 claim 都标 active 不管。

| 主题 | 旧观点（claim id / 日期） | 新观点（claim id / 日期） | 是演化还是矛盾 | 处理 | 证据 |
| --- | --- | --- | --- | --- | --- |
|  |  |  | 演化 / 矛盾 / 口误 | 保留新的、旧标 deprecated，或写清适用条件 |  |

判定原则：

- **演化**：市场或公司基本面变化导致结论变化，旧 claim 标 `deprecated`，新 claim 写 `supersedes`；
- **条件差异**：两句话适用条件不同（A 股 vs 港股、个股 vs 组合层），两条都可 active，但必须把 `conditions` 写清；
- **口误/转写错误**：不生成 claim，或标 `candidate` 后删除；
- **无法判断**：保留双方，标 `confidence: low`，在 `notes` 写「待补证据」。
