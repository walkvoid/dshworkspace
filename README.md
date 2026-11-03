# dshworkspace

DeepSeek Harness（DSH）插件集合。每个子目录都是一个可直接安装的 bundle（自带 `package.json`），
生成的浏览器包随仓库提交，clone 后无需构建即可安装。

## 在另一台机器安装

[`SKILL_INSTALL_GUIDE.md`](./SKILL_INSTALL_GUIDE.md) 是写给 **AI Agent** 的安装引导：把这份文档
（或其 raw 地址）交给目标机器上的 Agent，它会自动完成下面几步——

1. 克隆仓库到固定位置；
2. 用 `scripts/install-skills.mjs` 把 `/9c`（`/史诗级韭菜` 为同一技能的触发词）装进技能目录（copy 会写 `repo.txt` 兜底路径，link 用目录联接）；
3. 在 DSH 里通过 `plugin_manager` 安装金融看板；
4. 可选：弹一个二选一（「不要（跳过）」/「要，我提供密钥」）；选「要」则装第三方技能包、写入密钥并自检。

```text
阅读 https://raw.githubusercontent.com/walkvoid/dshworkspace/main/SKILL_INSTALL_GUIDE.md，完成安装
```

## 插件

| 目录 | 说明 |
| --- | --- |
| [`financial-dashboard`](./financial-dashboard/README.md) | 金融看板：右侧栏标签页 + 左侧栏整页面板，指数与自选股行情、近 120 个交易日 K 线，15 秒自动刷新 |

## 人格化分析

把一位财经博主的方法论"数字化"，让他在对话里按自己的框架评价一只股票。
不是角色扮演，而是三层：人格卡 + 可执行的框架细则 + 实时数据接地。

| 路径 | 说明 |
| --- | --- |
| [`.dsh/skills/9c/`](./.dsh/skills/9c/SKILL.md) | 人格技能：`/9c 中国平安` 或 `/史诗级韭菜 中国平安` 触发，流程固定为 解析 → 取数 → 三因子填表 → 硬规则 → 输出 |
| [`scripts/stock-data.mjs`](./scripts/stock-data.mjs) | 数据接地：腾讯行情 + 东财 F10 财务/分红，算股息率、最低派息率、穿透回报率、现金流代理 |

用法（DSH 会自动发现项目根 `.dsh/skills`，无需重启）：

```text
/9c 中国平安这个股票如何
/史诗级韭菜 中国平安
用龟龟法看看 601318
```

技能名必须是 kebab-case，所以真正的斜杠命令是 `/9c`；`/史诗级韭菜` 作为触发词写在技能描述里，
模型会据此加载同一份指令。**拼音别名 `/shichijijiucai` 已取消**——DSH 的 `/name` 调用按技能名精确匹配，
一个技能只能有一个名字，与其维护一份"转发层"，不如把人格资产直接放在 `9c/` 下：只有一处正文，不会漂移。

数据脚本可单独使用：

```powershell
node scripts/stock-data.mjs all 中国平安
node scripts/stock-data.mjs resolve 贵州茅台
```

新增第二个人格：复制 `.dsh/skills/9c/` 为 `.dsh/skills/<新名字>/`，
改 `SKILL.md` 的 frontmatter 与 `persona.md`，`scripts/stock-data.mjs` 共用。

## 数据层（统一取数入口）

`data/` 是唯一的取数入口：一个请求形状、一种结果形状、一份缓存、一份来源记录，
不管最终是哪个上游答的。

```js
import { get } from './data/index.mjs';

const r = await get({ kind: 'quote', instrument: 'hk:02318' });
// r.data  → 归一化行情（A 股与港股同构，只有 currency 不同）
// r.meta  → { source, fetchedAt, cached, stale, degraded }
```

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 入口与路由 | `data/index.mjs` | `get()`、provider 注册表、失败回退、缓存与 stale 兜底 |
| 策略 | `data/policy.mjs` | 支持哪些 kind、各类 TTL、每个 kind 的 provider 优先顺序 |
| 身份 | `data/instruments.mjs` | `cn:601318` / `hk:02318` 解析，拒绝裸代码歧义 |
| 缓存 | `data/cache.mjs` | TTL + LRU 上限；过期条目保留给 stale 读取 |
| 错误 | `data/errors.mjs` | `ProviderError` 与稳定错误码 |
| 上游 | `data/providers/*.mjs` | tencent（A/H 行情、日线、名称搜索、汇率）、eastmoney（A/H 财务与年报、A 股分红）、eastmoney-ann（公告列表 + 港股分红公告解析）、ifind（iFinD MCP 实时快照）、private（私有库 stub） |

支持的数据种类：`quote` `bars` `search` `fundamentals` `dividends` `annual` `fx` `announcements`。
单只标的作用 `get()`，一组标的（自选股）用 `getMany()`——后者会先向支持批量的 provider
要一次，避免 N 次往返。`fx` 用于跨币种换算，例如 `get({ kind: 'fx', pair: 'HKDCNY' })`。

**港股分红**没有结构化报表，走港交所派息公告解析（`data/dividend-parse.mjs`）：公告正文是固定标签表，
正则确定性抽取「每股派息 / 宣派币种 / 除净日 / 派息日」，噪声公告按"是否含宣派金额"过滤，
"(更新)"版按「报告期末 + 股息类型」去重取最新。

**iFinD MCP 接入**：`.dsh/skills/ifind-finance-data` 是官方技能包，`data/providers/ifind.mjs`
把它的 `call-node.js` 包成 provider。只接了**结构化工具**（`stock_highfreq_quotes` 的
`real_time` 快照），因为它的财务/港美股工具是自然语言查询，返回列取决于问句，不能进
需要可复现的数字管线。策略里 `quote` 仍是腾讯优先、iFinD 兜底（免费且能批量，不烧 iFinD 额度）。

两个消费方自动受益：看板走 `getMany()`，人格技能走 `stock-data.mjs`，都吃同一条策略。
跨源核对用：

```powershell
node scripts/verify-quotes.mjs              # 默认核对 601318 / 600519
node scripts/verify-quotes.mjs 601318 000001 --threshold 1
```

它分别向两个源各取一次（`bypassCache`），逐字段比价格、市盈率、市净率、总市值，
偏差超阈值即退出码 1——这是"换数据源改坏了"最快的报警方式。

**接入私有数据库**：实现 `data/providers/private.mjs` 的 `fetch()`，在 `capabilities` 里声明
它能答哪些 kind / market 即可。`policy.mjs` 已经把 `private` 排在财务类第一位，声明后自动生效，
公开源自动退为兜底与交叉校验。

**契约测试**（离线，用 `data/test/fixtures/` 里固化的上游响应）：

```powershell
node --test data/test/contract.test.mjs
```

上游改字段时测试会变红——这是唯一低成本的防线。

## 安装

```powershell
git clone https://github.com/walkvoid/dshworkspace.git D:\dshworkspace
```

然后在 DSH 里用 `plugin_manager` 的 `install_bundle` 安装某一子目录，`target` 指到该子目录
（包含 `package.json` 的那一层）：

- 金融看板：`D:\dshworkspace\financial-dashboard`

返回 `application: applied` 后刷新 Web GUI。更新：在仓库根目录 `git pull` → 重启 DSH → 刷新页面。

## 约定

- 每个插件目录是一个独立 npm 包，自带 `package.json`、`cordis.patch.yml`，按需声明 `dsh.client`。
- 生成产物（如 `client.js`）随仓库提交；源码与构建脚本也一并保留，便于修改后重建。
- 根目录 `.gitattributes` 统一行尾为 LF，并把 `client.js` 标记为 `-text`，保证跨机器逐字节一致。
- `.dsh/skills/` 是项目级技能目录，DSH 按最近的 `.git` 祖先定位项目根后自动发现，改动即时生效。
