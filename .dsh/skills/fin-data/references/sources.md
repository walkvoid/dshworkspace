# 数据源与降级链

```
akshare → adata → iFinD（仅抽样校验，不写主数据） → web（东方财富 / 腾讯直连）
```

逐标的降级：某只票在某源失败（HTTP/空数据/字段变化）就换下一个源；整批不中断。
每行写入时记录 `src`（ak/ad/web），用于审计。

## 各源要点

| 源 | 适配器 | 能力 | 限速 | 已知坑 |
| --- | --- | --- | --- | --- |
| akshare | `sources/akshare_source.py` | A 股/指数日线（不复权） | 250ms/次 | 成交量单位「手」→ ×100；中文列名；版本升级可能改字段（用 `_STOCK_REQUIRED` 断言） |
| adata | 预留 | 日线/复权 | — | 尚未接入（M2） |
| iFinD | 预留（MCP） | 日频需 NL 查询 | 配额 | 仅做抽样校验，不写主数据，避免许可与解析稳定性问题 |
| 东方财富直连 | `sources/web_source.py` | 日线（`push2his`，`fqt=0` 不复权） | 500ms/次 | `secid`：沪 `1.`，深/北 `0.`；成交量「手」→ ×100 |
| 腾讯直连 | 预留 | 日线 | — | 现有 `.dsh/skills/fin-data/adapter/providers/tencent.mjs` 已实现，可移植 |

## 校验与除权

- 逐行校验：价格 > 0、`high ≥ max(open,close)`、`low ≤ min(open,close)`、volume ≥ 0。
- 涨跌幅：
  - 正向超过涨跌停限制 → `LIMIT_UP`（error，疑似错误数据）。
  - 负向大幅下跌 → `EX_RIGHTS`（note）。**不复权价在除权除息日会自然跳空**，
    这是预期现象，等复权因子表落地后再精确区分。
- 停牌/退市/新股导致缺行属正常，不用相邻日填充。

## 新增数据源的步骤

1. 在 `sources/` 新建适配器，实现 `fetch(symbol, kind, start, end, cfg)`，返回统一行字典。
2. 失败一律抛 `ProviderError(NAME, CODE, message)`。
3. 在 `sources/__init__.py` 的 `REGISTRY` 与 `PROVIDER_CODE` 注册。
4. 补 fixtures 单测（用真实响应样本断言列映射与单位）。
