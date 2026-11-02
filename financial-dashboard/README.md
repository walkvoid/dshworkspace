# 金融看板（Financial Dashboard）

DSH 单 bundle 插件：在右侧栏新增「金融看板」标签页类型，并在左侧栏提供一个同名的整页面板；
页面标题下有页内子标签「行情」，展示指数指标卡、自选股列表与近 120 个交易日 K 线，每 15 秒自动刷新。

仓库：<https://github.com/walkvoid/dshworkspace>，本插件位于仓库的 `financial-dashboard/` 目录
（该目录即 bundle 根，包含 `package.json`）。

## 在另一台电脑安装

前提：那台机器已经装好 DeepSeek Harness，并且本仓库已克隆到本地（例如 `D:\dshworkspace`）。

```powershell
git clone https://github.com/walkvoid/dshworkspace.git D:\dshworkspace
```

然后在 DSH 里安装这个本地 bundle（两种方式任选）：

1. 让 DSH 里的 Agent 执行：`plugin_manager` → `install_bundle`，`target` 指到
   **`D:\dshworkspace\financial-dashboard`**（即本目录，包含 `package.json` 的那层）；
2. 或使用插件管理界面的「添加插件」，选择本目录安装。

安装返回 `application: applied` 后刷新 Web GUI。左侧栏会出现「金融看板」，右侧栏开始页会出现「行情」卡片。
以后更新：在仓库根目录 `git pull` 之后重启 DSH（替换已安装包需要重新加载客户端 JS），再刷新页面。

## 使用

- **左侧栏（整页）**：点「金融看板」→ 中间列打开整页看板。标题下是页内子标签「行情」，
  指标卡 / K 线 / 自选列表都在这个子标签下（后续可在 `SubTabs` 的 `subTabs` 列表里加项扩展）。
  「更多」菜单里也能看到该入口，并可用固定开关把它收进「更多」。
- **右侧栏（标签页）**：展开右侧栏 → 开始页的「行情」卡片 → 紧凑版「金融看板」标签页。
- 顶部按钮切换「红涨绿跌 / 绿涨红跌」，选择写入 `localStorage`；颜色全部来自 `--dsw-alias-*`
  主题 token，亮暗主题随宿主切换，K 线颜色在主题变更时重新读取。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半侧：注册 `GET /financial-dashboard/quotes`，代理腾讯行情/日线并维护内存缓存 |
| `client.js` | 生成的浏览器半侧：内联 ECharts 5.6.0，注册标签类型、正文、标题、开始页卡片与左侧栏面板 |
| `client-source.js` | 浏览器半侧的源码（Authoring source） |
| `scripts/build.mjs` | 构建：下载固定版本 ECharts 并内联进 `client.js` |
| `scripts/test-route.mjs` | 路由自测：真实上游 + mock ctx，覆盖缓存、降级、围栏与参数校验 |
| `cordis.patch.yml` | 插入 Host 插件行 `financial-dashboard` |
| `locale/*.json` | 插件管理中的显示标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | 插件图标 |

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

- 快照缓存 10 秒（按代码列表归一化后作为 key），日线缓存 5 分钟（按代码）。
- 上游失败时返回上一次缓存并带 `stale: true`；冷缓存失败返回 `ok: false`、空数组与 `error`，
  客户端据此显示降级/空态而不是白屏。

## 开发与构建

需要 Node.js 18+（使用全局 `fetch`）。在本目录（`financial-dashboard/`）执行：

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
