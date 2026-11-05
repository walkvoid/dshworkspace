# 范围裁剪（scope filter）

**先裁剪，再分析。** 需求文档里经常有两种“不该进本期分析”的内容：

1. **被删掉的**：Word 删除线（单线/双线）、修订模式下的删除（`w:del`）；
2. **不属于本期的**：标题或段落带版本/取消标记。

把它们当需求分析，估时和方案都会失真。

## 判定表

| 形态 | 判定 | 处理 |
| --- | --- | --- |
| 文字带删除线（`w:strike` / `w:dstrike`） | 作者已删除 | 整段删除 → `excluded`，`reason: struck` |
| 修订删除（`w:del`） | 修订模式删掉的内容 | 同上 |
| 标题含【下版本】【后续版本】【下一期】 | 本期不做 | 整节排除，`reason: next-version` |
| 标题或规则含【取消】【废弃】【不再支持】 | 已取消 | `reason: cancelled` |
| 正文含“本期不做”“不在本期范围”“暂不实现” | 范围外 | `reason: out-of-scope` |
| 整节只有标题、没有可落地规则 | 无法分析 | `reason: no-anchor`（可选，写清原因） |

> 只删了单元格的删除线：按单元格剔除，不要整表丢弃；标题被划掉：整节排除。

## 怎么读（docx）

用 python-docx 读 `run.font.strike`、`w:strike`、`w:dstrike`、`w:del`，把“保留文本”和“被删文本”分开输出：

```python
import docx
from docx.oxml.ns import qn

def keep_runs(p):
    parts = []
    for r in p.runs:
        rpr = r._element.find(qn('w:rPr'))
        struck = bool(r.font.strike) or (rpr is not None and (
            rpr.find(qn('w:strike')) is not None or rpr.find(qn('w:dstrike')) is not None))
        if not struck:
            parts.append(r.text)
    return ''.join(parts)

doc = docx.Document(path)
for p in doc.paragraphs:
    kept = keep_runs(p)
    if p.text.strip() and not kept.strip():
        print('整段被删:', p.text.strip()[:80])   # → excluded(struck)
```

- 表格：对每个 cell 的每个 paragraph 做同样处理；
- 只读 `kept` 文本重建一份“干净文档”，后续抽条目只看它；
- 被删内容不要凭印象补回来——真的重要，产品会重新写一版。

## 记录排除项

`requirement.json` 里的 `excluded[]`（不影响 `totals`）：

```json
"excluded": [
  { "id": "EX-1", "label": "补充协议状态与签署弹窗", "reason": "next-version",
    "sourceId": "SRC-1", "locator": "3.3.4 标题【下版本】补充协议", "note": "整节标注下版本" },
  { "id": "EX-2", "label": "企业账户信息同步", "reason": "cancelled",
    "sourceId": "SRC-1", "locator": "3.3.3 标题【1012取消】账户变更", "note": "标题标注取消" }
]
```

规则：

- 每条要有 `reason` 和**来源**（哪份材料、哪一节），否则就是“悄悄漏掉”；
- `analysis.md` 的 §8「明确不做」直接由 `excluded` 生成，不另写一套；
- **不得**把排除项写进 `subRequirements`；
- 排除项如果被本期功能依赖（典型：下版本的额度查询被本期开立依赖），**开 P0 问题**，不要偷偷做，也不要假装没依赖。

## 常见坑

| 坑 | 后果 |
| --- | --- |
| 只读文字、不看格式 | 把已删除的规则当需求（本项目实测：1281 个整段被删） |
| 只按标题判断 | 标题没标【下版本】，但正文被整段划掉 |
| 把 §8 写死成手写清单 | 和 `excluded` 脱节，下次改需求无法核对 |
| 排除后不留痕 | 评审时无法证明“看过但决定不做” |
