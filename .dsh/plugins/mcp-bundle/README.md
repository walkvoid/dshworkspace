# MCP bundle（可选）：MySQL ×3 + 腾讯 COS

一个 dsh **bundle**：把它加入任意 profile 的 `dsh.profile.bundles`，该 profile 就会加载这里声明的 MCP 服务器。
条目默认 **disabled**，只有对应环境变量存在时才启用——所以没配的人不会看到一堆启动失败的服务。

| serverName | 工具前缀 | 启用条件 |
| --- | --- | --- |
| `mysql_dev` | `mcp__mysql_dev__*` | `MYSQL_DEV_HOST` 存在 |
| `mysql_qa` | `mcp__mysql_qa__*` | `MYSQL_QA_HOST` 存在 |
| `mysql_uat` | `mcp__mysql_uat__*` | `MYSQL_UAT_HOST` 存在 |
| `cos` | `mcp__cos__*` | `COS_SECRET_ID` 存在 |

## 启用

```powershell
cd .dsh/plugins/mcp-bundle
node scripts/enable.mjs --profile web --install    # 任意 profile：web / headless / 自定义
node scripts/enable.mjs --profile desktop --install
```

脚本只改 `<profile>/package.json`（加 `link:` 依赖 + bundle 条目），写前备份，然后在 profile 里跑 `pnpm install`。
之后**重启 DSH** 才会加载。

手动等价操作（不想跑脚本时）：

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": {
    "@local/mcp-bundle": "link:D:/github/dshworkspace/.dsh/plugins/mcp-bundle"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/mcp-bundle"]
    }
  }
}
```

再在该 profile 目录执行 `pnpm install`。

## 配置变量

DSH 启动时按 `继承环境变量 > <cwd>/.env > ~/.dsh/.env` 的顺序读环境变量，并会把值写回 `process.env`。
推荐放在 `~/.dsh/.env`（不随仓库走）：

```dotenv
# MySQL 环境（按需只填要用的）
MYSQL_DEV_HOST=127.0.0.1
MYSQL_DEV_PORT=3306
MYSQL_DEV_USER=root
MYSQL_DEV_PASS=
MYSQL_DEV_DB=

MYSQL_QA_HOST=
MYSQL_QA_PORT=3306
MYSQL_QA_USER=
MYSQL_QA_PASS=
MYSQL_QA_DB=

MYSQL_UAT_HOST=
MYSQL_UAT_PORT=3306
MYSQL_UAT_USER=
MYSQL_UAT_PASS=
MYSQL_UAT_DB=

# 腾讯云 COS
COS_REGION=ap-guangzhou
COS_BUCKET=your-bucket-1250000000
COS_SECRET_ID=
COS_SECRET_KEY=
# COS_DATASET_NAME=
```

注意：`.env` 里不能放 DSH 启动相关的变量（`DSH_*`、`HOME`、`PATH`、代理等），DSH 会直接报错。

## 移除

```powershell
node scripts/enable.mjs --profile web --remove --install
```

或手工从 `dependencies` / `dsh.profile.bundles` 删掉 `@local/mcp-bundle` 后 `pnpm install`。

## 与手写 patch 的关系

- bundle 的 patch 层在 profile 的 `cordis.patch.yml` **之前**应用；想覆盖某个条目，在 profile patch 里用**相同 `id`** 重写（整段替换，不是深合并）。
- 如果 profile patch 里已经有同样 `serverName` 的手写条目（例如旧的三条 MySQL），先删掉，否则会报 `serverName "x" is already in use`。
- 同一 profile 里 `mcp__<serverName>__` 前缀必须唯一。

## 验证

```powershell
# 合成后的配置里应能看到 mcp-mysql-dev / mcp-cos 条目
dsh web --dump-config | Select-String -Pattern 'mcp-(mysql|cos)'

# 重启后工具列表：mcp__mysql_dev__*、mcp__cos__*
```

## 安全

- 仓库里**不含任何凭据**；密钥只从环境变量读取。
- 不要提交 `~/.dsh/.env` 或带密钥的 `cordis.patch.yml`。
- `failOnStartupError: false`：数据库/网络不通只影响对应工具，不会阻塞 DSH 启动。
