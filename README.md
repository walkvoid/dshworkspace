# dshworkspace

DeepSeek Harness（DSH）插件集合。每个子目录都是一个可直接安装的 bundle（自带 `package.json`），
生成的浏览器包随仓库提交，clone 后无需构建即可安装。

## 插件

| 目录 | 说明 |
| --- | --- |
| [`financial-dashboard`](./financial-dashboard/README.md) | 金融看板：右侧栏标签页 + 左侧栏整页面板，指数与自选股行情、近 120 个交易日 K 线，15 秒自动刷新 |

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
