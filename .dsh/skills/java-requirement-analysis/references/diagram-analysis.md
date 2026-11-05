# 流程图与图片识别（diagram analysis）

**流程图不是插图，是需求的第二作者。** 节点、分支、金额阈值、状态回写经常只画在图上，
正文只写“流程见下图”。所以**每张流程图都必须做图片识别并落成结构化节点**，不能只看标题。

## 什么时候必须做

| 图片类型 | 必须识别 | 说明 |
| --- | --- | --- |
| 流程图 / 时序图 / 状态机 | ✅ 必须 | 节点、分支、金额阈值、外部系统、回调 |
| 原型图 / UI 截图 | ✅ 必须 | 字段、按钮、列表列、必填与校验提示 |
| 架构图 / 部署图 | ✅ 必须 | 系统边界、调用方向 |
| 装饰图、公司 LOGO | 可跳过 | 在 §8 说明 |

> 判据：图片所在章节的标题里出现「流程」「时序」「状态」「原型」「界面」「架构」，或正文出现“见下图/如下图/流程图”。

## 用什么识别

按可用能力从高到低：

1. **多模态模型直接读图**：`read_image` 把裁剪后的图给视觉模型，让它按“节点 / 分支 / 条件 / 系统泳道”输出；
2. **OCR**（模型无视觉时）：Windows OCR、tesseract、云 OCR —— 只能拿文字，**必须靠坐标还原结构**；
3. 模型读不出、OCR 也糊：**不要猜**，记 `diagram.unresolved` 并开澄清问题。

### 关键：长图要切片

需求文档里的流程图常是 4000×15000 的长图，直接 OCR/读图会糊。做法：

```python
from PIL import Image
Image.MAX_IMAGE_PIXELS = None          # 关掉 PIL 的解压炸弹限制
im = Image.open(path).convert("RGB")
T, OV = 1500, 200                       # 切片边长、重叠
for y in range(0, im.height, T - OV):
    for x in range(0, im.width, T - OV):
        im.crop((x, y, min(x+T, im.width), min(y+T, im.height))).save(f"tile_{y}_{x}.png")
```

- 宽小于 1200 的图先**放大**到 1200，否则文字太小；
- 切片按 `(y, x)` 排序还原阅读顺序；
- 重叠区去重：按“去掉标点后的字符串”做集合去重。

### Windows OCR（无视觉模型时的兜底）

```powershell
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
# OcrEngine.TryCreateFromUserProfileLanguages() + AsTask 包装 IAsyncOperation
# 只取 $res.Lines.Text，不要碰 BoundingRect（WinRT 投影会抛 InvalidCast）
```

- 中文 OCR 会在汉字间插空格，按 `(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])` 去掉；
- OCR 会把 `E链` 认成 `E 链`、`code` 认成 `cod`，**只用于定位节点，术语以正文为准**；
- 200 张切片的 OCR 约 20 秒，可以整批跑。

## 落成结构化结果

`requirement.json` 的 `diagrams[]`：

```json
{
  "id": "DG-1",
  "sourceId": "SRC-4",
  "title": "凭证开立主流程",
  "kind": "flow",
  "lanes": ["本地客户端", "本地内管端", "SAAS 产融平台", "SAAS 讯易链"],
  "nodes": [
    { "seq": 1, "actor": "集团采购专员", "action": "资产导入", "system": "本地客户端" },
    { "seq": 2, "actor": "系统", "action": "校验开单额度", "system": "本地", "branch": "通过/不通过" }
  ],
  "branches": [
    { "from": "开单额度校验", "condition": "不通过", "to": "终止并提示额度不足" },
    { "from": "开单额度校验", "condition": "通过", "to": "推送核心企业" }
  ],
  "thresholds": [{ "field": "开单金额", "op": ">=", "value": 1500, "unit": "万元", "to": "集团资金复审" }],
  "integrations": ["企业建档信息推送", "单点登录-换码", "单点登录-取链", "资产导入", "资产状态查询"],
  "confidence": "verified",
  "note": "OCR 识别；术语按正文校正"
}
```

规则：

- `nodes` 按阅读顺序编号，**每个节点写清谁（actor）在哪个系统（system）做什么（action）**；
- `branches` 必须带条件，金额/数量阈值单列到 `thresholds`；
- `integrations` 列出图上出现的所有外部调用，用来核对子需求是否漏接口；
- `confidence`：视觉模型直读 `verified`；OCR + 正文校正 `inferred`；识别失败 `unresolved`；
- **图里有的节点，正文没有 → 开澄清问题**（常见：图上画了额度校验，正文标“下版本”）；
- **正文有、图里没有 → 也开问题**（可能是图没更新）。

## 与子需求的联动

- 流程图里的节点 → 落到 `changePoints` 或 `newCode`；
- 流程图里的分支 → 写到 `acceptance`；
- 流程图里的外部调用 → 至少一条子需求覆盖，否则视为漏项；
- 优先级判定：图上的**金额阈值、状态回写、回调**最容易漏，逐条核对。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 只读正文、跳过图 | 漏掉额度校验节点、确权回调、二级审核等关键分支 |
| 只看图不读正文 | 把已删/下版本的节点算进本期 |
| OCR 完不校正术语 | 代码里出现 `cust 尾`、`BuILD SUCCESS` 这类错拼 |
| 长图不切片 | 文字糊成一团，识别不出分支条件 |
| 识别失败就编 | 违反“不猜”原则，必须标 `unresolved` 并提问 |
