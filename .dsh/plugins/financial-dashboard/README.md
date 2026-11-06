# 金融看板（Financial Dashboard）

DSH 单 bundle 插件：在右侧栏新增「金融看板」标签页类型，并在左侧栏提供一个同名的整页面板；
页面标题下有页内子标签「行情」，展示指数指标卡、自选股列表与近 120 个交易日 K 线；整块看板每天 16:05（香港/北京时间）更新一次。

仓库：<https://github.com/walkvoid/dshworkspace>，本插件位于仓库的 `.dsh/plugins/financial-dashboard/` 目录
（该目录即 bundle 根，包含 `package.json`）。

## 在另一台电脑安装

前提：那台机器已经装好 DeepSeek Harness，并且本仓库已克隆到本地（例如 `D:\dshworkspace`）。

```powershell
git clone https://github.com/walkvoid/dshworkspace.git D:\dshworkspace
```

然后在 DSH 里安装这个本地 bundle（两种方式任选）：

1. 让 DSH 里的 Agent 执行：`plugin_manager` → `install_bundle`，`target` 指到
   **`D:\dshworkspace\.dsh\plugins\financial-dashboard`**（即本目录，包含 `package.json` 的那层）；
2. 或使用插件管理界面的「添加插件」，选择本目录安装。

安装返回 `application: applied` 后刷新 Web GUI。左侧栏会出现「金融看板」，右侧栏开始页会出现「金融看板」卡片（副标题写明「行情」）。
以后更新：在仓库根目录 `git pull` 之后重启 DSH（替换已安装包需要重新加载客户端 JS），再刷新页面。

## 使用

- **左侧栏（整页）**：点「金融看板」→ 中间列打开整页看板。标题下是页内子标签「行情」，
  指标卡 / K 线 / 自选列表都在这个子标签下（后续可在 `SubTabs` 的 `subTabs` 列表里加项扩展）。
  「更多」菜单里也能看到该入口，并可用固定开关把它收进「更多」。
- **右侧栏（标签页）**：展开右侧栏 → 开始页的「金融看板」卡片（副标题「行情」）→ 紧凑版「金融看板」标签页。
- 顶部按钮切换「红涨绿跌 / 绿涨红跌」，选择写入 `localStorage`；颜色全部来自 `--dsw-alias-*`
  主题 token，亮暗主题随宿主切换，K 线颜色在主题变更时重新读取。

## 龟龟选股（页内子标签）

整页看板与右侧栏紧凑面板都有「龟龟选股」子标签：

- **每天 16:05 跑一次**：以香港/北京时间为准，宿主在 16:05 自动生成当天榜单；当天 16:05 之前打开页面会沿用最近一份，并在标题旁标明是哪天的结果。已有结果直接复用，一个自然日只有一份。
- **只选港股通**：观察池先与东财港股通板块（`b:DLMK0144`）求交集，名单按自然日缓存；REITs、港灯等不在港股通的标的会被自动剔除。
- **选股口径**（见 `picks.js` 的 `THRESHOLDS`）：股息率 ≥ 4.5%、PE ≤ 12、派息率 ≤ 95%、
  负债率 ≤ 75%，每个行业最多 3 只；按 股息 40% / 估值 25% / 资产折价 20% / 派息余地 15% 打分，取前 10。
- **列表字段**：市值、净现金、穿透回报率、股息率、PE、PB、派息率、负债率。净现金 = 现金及等价物 + 短期存款 + 中长期存款 − 短期贷款 − 长期贷款 − 应付票据(非流动) − 融资租赁负债；季报没有明细时回退到最近一份半年报/年报；穿透回报率 = 净利润 × 派息率 ÷（港币市值 × HKDCNY）。
  银行与融资租赁**整类不进观察池**——他明确说过「银行的表我看不清楚，负债看不清的一律不买」
  （`BV16fH76GEoD` @ 01:30:12，已作为 active claim 入库）。
- **观察池**是固定港股名单（公用事业、电信、收费公路、REIT、消费、银行、医药、综合），
  不追周期股、地产、保险、博彩——这是收息层粗筛，不替代 `framework.md` 的三因子逐项分析。
- **历史选股**按钮打开抽屉，按日期回看当时的榜单与分数；结果落盘后不再变化。
- 结果只保存在 `.data/picks.json`（git 忽略），换机或清目录会丢历史。

```text
GET /financial-dashboard/picks              # 今天的榜单（16:05 生成；还没到就返回最近一份）
GET /financial-dashboard/picks?refresh=1    # 强制重跑今天并覆盖
GET /financial-dashboard/picks?date=2026-11-05
GET /financial-dashboard/picks?history=1    # 历史日期列表
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半侧：注册 `GET /financial-dashboard/quotes` 与 `GET /financial-dashboard/picks`，把参数转成统一数据层的 `getMany()` / `get()` 调用，再把结果映射成客户端认识的字段 |
| `picks.js` | 龟龟选股：观察池、硬门槛、打分、每日结果落盘与历史摘要 |
| `client.js` | 生成的浏览器半侧：内联 ECharts 5.6.0，注册标签类型、正文、标题、开始页卡片与左侧栏面板 |
| `client-source.js` | 浏览器半侧的源码（Authoring source） |
| `scripts/build.mjs` | 构建：下载固定版本 ECharts 并内联进 `client.js` |
| `scripts/test-route.mjs` | 行情路由自测：真实上游 + mock ctx，覆盖缓存、降级、围栏与参数校验 |
| `scripts/test-picks.mjs` | 选股路由自测：真实上游选股一次，覆盖门槛、每行业上限、历史与落盘 |
| `cordis.patch.yml` | 插入 Host 插件行 `financial-dashboard` |
| `locale/*.json` | 插件管理中的显示标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | 插件图标 |

行情抓取、归一化、缓存与过期兜底都在仓库 `.dsh/data/` 的[数据层](../../../README.md#4-数据层统一取数入口)里；
本插件通过 `../../data/index.mjs` 引用它（安装时是指向本目录的 junction，因此 `.dsh/data/` 必须与它一起在位）。

## Host 路由

```
GET /financial-dashboard/quotes?codes=sh600519,sz000001[&daily=sh600519]
```

- 每个请求先调用 `ctx.connection.requestRejection({ headers })`；被拒绝时直接返回 401/403，不触达上游。
- `codes` 仅接受 `sh|sz|bj` + 6 位数字，最多 24 个，逗号分隔。
- 响应：

```json
{
  "ok": true,
  "stale": false,
  "fetchedAt": 1762040000000,
  "quotes": [{ "code": "sh600519", "name": "贵州茅台", "price": 1425.69, "changePct": 2.42 }],
  "daily": { "code": "sh600519", "bars": [["2026-11-02", 1410, 1425.69, 1443.55, 1395.02, 46762]], "stale": false }
}
```

- 快照按自然日缓存（同一份代码 + 日线组合当天只打一次上游，`?refresh=1` 强制重拉）；日线在数据层缓存 5 分钟。
- 上游失败时返回上一次缓存并带 `stale: true`；冷缓存失败返回 `ok: false`、空数组与 `error`，
  客户端据此显示降级/空态而不是白屏。

## 开发与构建

需要 Node.js 18+（使用全局 `fetch`）。在本目录（`.dsh/plugins/financial-dashboard/`）执行：

```powershell
npm run build    # 等价于 node scripts/build.mjs
npm test         # 等价于 node scripts/test-route.mjs（需要能访问腾讯行情接口）
```

构建脚本首次运行会把 ECharts 5.6.0 的 `dist/echarts.min.js` 下载到 `.cache/`（已 git 忽略），
之后复用缓存。不要手工编辑 `client.js` 里的 ECharts 段落。

## 许可

插件代码为 MIT（见 `LICENSE`）。浏览器包内联了 Apache ECharts 5.6.0（Apache-2.0），
其许可证全文在 `licenses/echarts-LICENSE.txt`，第三方说明见 `THIRD_PARTY_NOTICES.md`。

行情数据来自腾讯公开行情接口，仅用于个人自用；对外分发或商用前请自行确认数据源条款。
