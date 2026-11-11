# 写脚本自动登录（通用打法）

目标：给任意一个需要登录的系统，产出**懒加载**的脚本——第一次用才登录，之后复用会话；
会话过期自动重登一次；凭据不落地在代码里、不进日志。**默认不排定时任务**，需要定时再单独加。

> **触发规则**：用户资料里只要出现「网址 + 账号密码」，就**后台异步**跑一遍本文的流程，
> 不要阻塞环境准备主线；一个站点一个任务，完成后按矩阵汇报（见 SKILL.md 三 3.1）。

> 先用 `curl`/`fetch` 探明机制，再写代码。**不要一上来就猜登录接口**。

## 第 1 步：探测（10 分钟）

```bash
# 1. 通不通
nslookup <host>; Test-NetConnection <host> -Port 443     # Windows
curl -sk -D - -o /dev/null <目标 URL>                     # 看 302 与 Set-Cookie
```

- 目标页返回 **JSON 且带业务码**（如 `{"code":"01100","message":"会话已过期"}`）→ 这是 API 路径，不是页面；
- 返回 **302 到别的域名** → 单点登录（SSO），记下 `Location`；
- 返回 HTML → 拿它的 `<script src>`，逐个下载，在 bundle 里搜：

```js
/api/  /sso/api  /login  /token  access-token  Authorization  Bearer  publicKey  captcha
```

在压缩后的 JS 里搜这些串，能直接找到登录接口、请求字段和 header 名。

## 第 2 步：判定认证类型

| 类型 | 特征 | 会话怎么带 |
| --- | --- | --- |
| 表单 / JSON 登录 | `POST /login` 返回 200 + `Set-Cookie` | Cookie（最常见） |
| Token 登录 | 响应体里 `data.token` / `access_token` | `Authorization: Bearer <token>` |
| OAuth2 / SSO 授权码 | 302 到 `auth.<domain>/sso/api/v1/authorize` | 走完回调后应用侧下发 Cookie |
| 带验证码 / 短信 / OTP | 登录页有 captcha、`/captcha` 接口 | **不能全自动**：人工过一次或复用浏览器会话 |

OAuth2 授权码（本例 AIO 平台）的完整链路：

```
GET  /sys-web/oauth2/login
  → 302 auth.<domain>/sso/api/v1/authorize?response_type=code&client_id=...&redirect_uri=...
  → 302 auth.<domain>/login?req=<uuid>&app=AIO
POST auth.<domain>/sso/api/v1/login   {username, password, request_id}
GET  auth.<domain>/sso/api/v1/callback?request_id=<uuid>
  → 302 <app>/sys-web/oauth2/code/<app>?code=...&state=...
  → 应用侧 Set-Cookie: access-token=...（后续所有 API 带它）
```

## 第 3 步：实现（照 `templates/auto-login.mjs` 改）

必须有的四件套：

1. **CookieJar**：吸收每次响应的 `set-cookie`，持久化到本地 `session.json`；
2. **登录后校验**：拿一个“必须登录才能看”的接口试一次，HTTP 200 且业务码正常才算成功；
3. **过期自愈**：命中 `401` 或业务码 `01100/会话过期` 时**重登一次**再重试；
   只重试一次，失败就退出——别写成死循环；
4. **失败不重试**：账号密码被拒时立刻停（很多平台有失败次数限制，重试会锁号）。

## 第 4 步：凭据与产物放哪

- 凭据：环境变量（`AIO_USER` / `AIO_PASS`）优先，其次 `<项目>/.env-prep/<site>-credentials.json`；
  该目录已在 `.gitignore` 里，且**不要打印、不要写进日志、不要提交**；
- 会话：脚本同目录 `session.json`（含 Cookie，等于半个密码）；
- 输出：`--json` 打到 stdout，需要留档时重定向到文件。

## 第 5 步：懒加载（默认工作方式）

每次执行命令前先 `ensureSession()`，三态处理：

| 状态 | 行为 |
| --- | --- |
| 没有 `session.json` | 走完整登录流程，成功后写会话 |
| 有会话且探活通过 | 直接复用，不发登录请求 |
| 会话过期（401 / 业务码） | 重登一次并刷新会话 |

探活要点：

- 选**必须登录才能访问、且足够便宜**的接口（`/auth/me` 这类）；
- 探活请求体也要合法：AIO 的探活一开始没带 `queryCondition`，服务端回 `10001`，
  被误判成"过期"，每次多登一次——探活失败要和"会话过期"区分开；
- 探活失败别急着重登：先看是 401/01100（过期）还是 4xx 参数错（脚本 bug）。

## 第 5.5 步：可选——确实需要定时再加

只有当用户明确要"每天/每小时自动跑"时才挂调度，命令就是普通的一次调用：

```powershell
schtasks /Create /TN "aio-bugs" /SC DAILY /ST 09:30 /TR ^
  "node D:\harnessworkspace\jasolar\.env-prep\tools\aio\aio.mjs bugs --json > D:\harnessworkspace\jasolar\.env-prep\tools\aio\bugs.json"
```

```bash
30 * * * * cd /path && node .env-prep/tools/aio/aio.mjs bugs --json > .env-prep/tools/aio/bugs.json
```

脚本要满足：幂等、可并发重跑、失败用非 0 退出码、别把凭据写进命令行历史。

## 第 6 步：沉淀差异，而不是复制脚本

同一个引擎、不同站点的差异只写进配置：

```js
const SITE = {
  baseUrl: 'https://aio.llschain.com',
  authMode: 'cookie',                    // cookie | bearer
  login: { url: '/sso/api/v1/login', method: 'POST', fields: ['username', 'password', 'request_id'] },
  check: { url: '/project-web/qaBug/page', method: 'POST' },
};
```

## 已落地实例（可对照抄）

`D:\harnessworkspace\jasolar\.env-prep\tools\aio\aio.mjs` —— 公司 AIO 平台（OAuth2 授权码 + cookie 会话）：

- 登录：`sys-web/oauth2/login → authorize → /login?req=… → POST sso/api/v1/login → callback → 应用侧 cookie`；
- 会话：`session.json` 存 cookie；`01100 会话已过期` 自动重登一次；
- 业务：`POST /project-web/qaBug/page` 拉缺陷；
- 坑：`currentAssignTos` 只认用户 ID（传名字返回 0），改成翻页后按 `assignTo` 本地匹配。

`D:\harnessworkspace\jasolar\.env-prep\tools\beecloud\beecloud.mjs` —— BeeCloud 应用观测（本地账号 + JWT cookie）：

- 登录：`POST /u5/api/v2/login {username,password}` → `Set-Cookie: token=<JWT>`，无需 SSO；
- 业务：`POST /beelog/api/v1/tenants/{tenant}/search?project=<名>`，body 里 `env` / `env_instance` / `cluster` 必须匹配平台下拉值；
- 坑 1：`projects/{id}/searchQuery` 只回显查询串，真正的检索在 `tenants/{tenant}/search`；
- 坑 2：`env_instance` 传空会 500 `build index error: empty tenant name or cluster name`；
- 定位接口的方法：`/app-observe/js/app.*.js` 里查 `logBaseUrl` → 找到 `chunk-*.js` → 搜 `searchQuery` 找到 API 模块（`url: logBaseUrl + "/search"`），比猜路径快得多。

## 常见坑

| 坑 | 处理 |
| --- | --- |
| 密码被 RSA 加密后提交 | 在 bundle 里找 `publicKey` / `encrypt`，用 `node:crypto` + SPKI 公钥加密 |
| 需要 CSRF / XSRF token | 先 GET 表单页，取隐藏字段或 cookie，再带进 POST |
| Cookie 的 Domain 不同（auth 域 vs 业务域） | 两个域各自存 cookie，回调那一步必须带着 auth 域的 cookie |
| `SameSite`/`Secure` 丢 cookie | 脚本直接按 `Set-Cookie` 原文自己管理，不依赖浏览器策略 |
| 需要 `Referer` / `User-Agent` | 补上，很多网关会校验 |
| 多次 302 | 按顺序手动跟（`redirect: 'manual'`），每一步都吸收 cookie |
| 频率限制 | 加最小间隔；定时任务别设太密 |
| 账号被锁 | 一旦返回“密码错误”，**停止重试**，把原始 message 打给用户 |

## 验收清单

- [ ] `login` 能成功，且 `session` 能看到 cookie 名
- [ ] 关掉网络/改错密码时，退出码非 0 且错误信息可读
- [ ] 删掉 `session.json` 后，下一次调用能自动重登
- [ ] 会话过期（`01100`/401）时自动重登一次并成功
- [ ] 凭据不在代码、不在日志、不在 git 里
- [ ] 删掉 `session.json` 后下一次调用能自动登录并写回
- [ ] 会话有效时不重复发登录请求（`state: reused`）
- [ ] 会话过期时自动重登一次并成功（`state: relogin`）
- [ ] 凭据不在代码、不在日志、不在 git 里
- [ ] （可选）需要定时时才建任务，跑一次产物有更新
