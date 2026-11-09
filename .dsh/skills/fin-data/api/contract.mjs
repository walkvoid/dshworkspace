/**
 * fin-data 统一查询契约（`fin-data.query/v1`）。
 *
 * 这是 9c、金融看板等**消费方唯一允许依赖的取数面**：
 *
 *   一个请求形状： `{ kind, instrument? , query? , pair?, options? }`
 *   一个返回信封： `{ schema, ok, kind, instrument, data, meta, warnings }`
 *   一份来源记录： `meta.source / meta.asOf / meta.fetchedAt / meta.mock / meta.stale`
 *
 * 真实上游（腾讯快照、东财 F10、iFinD）只是 fin-data 的内部适配器；消费方不得
 * 直接引用 `.dsh/data/`，否则换源、加缓存、接真实财报时又要改一遍调用方。
 */

/** 信封版本。新增字段向后兼容；破坏性改动必须换版本号。 */
export const SCHEMA = 'fin-data.query/v1';

/**
 * 支持的数据种类。
 *
 * - `status`      数据集状态（manifest + 交易日历 + 可用适配器）
 * - `quote`       实时快照（A 股 / 港股）
 * - `bars`        日线（默认实时源；`options.source='local'` 读 fin-data 落盘 CSV）
 * - `financials`  财报（利润表 / 资产负债表 / 现金流量表 + 指标）★ 现阶段可返回模拟数据
 * - `dividends`   分红明细
 * - `annual`      年报关键项
 * - `universe`    标的集合（指数成分 / 港股通名单）
 * - `fx`          汇率
 * - `search`      名称 -> 代码
 * - `announcements` 公告列表
 */
export const KINDS = [
  'status',
  'quote',
  'bars',
  'financials',
  'dividends',
  'annual',
  'universe',
  'fx',
  'search',
  'announcements',
];

/** 每个 kind 的一句话说明，`describe()` 与文档共用。 */
export const KIND_DOCS = {
  status: '数据集覆盖率、最新交易日、已注册适配器；回答里引用 asOf 前先看这里',
  quote: '实时快照：价格、涨跌幅、成交量、PE、市值',
  bars: '日线序列；默认实时源（前复权），options.source=local 读本地 CSV（不复权）',
  financials: '财报：利润表/资产负债表/现金流量表关键项，按报告期倒序；现阶段允许模拟',
  dividends: '分红明细：每股派息、除权日、方案',
  annual: '年报关键项：财年、归母净利润、总股本',
  universe: '标的集合：sse50（本地） / hk-connect（东财港股通，按日缓存）',
  fx: '汇率快照，如 HKDCNY',
  search: '名称/拼音 -> 候选代码',
  announcements: '公告列表：标题、日期、链接',
};

/** 财报实现来源：auto 先真实、失败回落模拟；real 只认真实；mock 只给模拟。 */
export const FINANCIALS_SOURCES = ['auto', 'real', 'mock'];

/** 模拟数据的固定免责声明；任何 mock 响应都必须带上它。 */
export const MOCK_DISCLAIMER =
  '模拟财报：仅用于打通 fin-data 查询接口，数值由代码生成，不代表任何公司的真实经营情况。';

/** 查询失败码；调用方可据此分支，不必解析 message。 */
export const ERROR_CODES = {
  INVALID_REQUEST: 'invalid_request',
  UNKNOWN_KIND: 'unknown_kind',
  NOT_FOUND: 'not_found',
  UNSUPPORTED: 'unsupported',
  UPSTREAM_DOWN: 'upstream_down',
};

/** 一眼能看懂的请求错误。 */
export class QueryError extends Error {
  /**
   * @param {string} code - one of `ERROR_CODES`.
   * @param {string} message - short human readable reason.
   * @param {object} [extra] - `kind` / `instrument` for the envelope.
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.kind = extra.kind ?? null;
    this.instrument = extra.instrument ?? null;
  }
}

/** 数字或 `null`；`NaN` / `Infinity` 一律当缺数据。 */
export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** 四舍五入；空值原样返回。 */
export const round = (value, digits = 2) =>
  num(value) === null ? null : Number(value.toFixed(digits));

/** 元 -> 亿元（保留 2 位），与 fin-data 的 `*Yi` 字段口径一致。 */
export const toYi = (value) => (num(value) === null ? null : round(value / 1e8, 2));

/** 亿元 -> 元。 */
export const fromYi = (value) => (num(value) === null ? null : value * 1e8);

/** 空 meta，供各分支按需覆盖。 */
export const emptyMeta = () => ({
  source: null,
  fetchedAt: new Date().toISOString(),
  asOf: null,
  cached: false,
  stale: false,
  mock: false,
  ttlMs: null,
  degraded: [],
});

/**
 * 成功信封。
 * @param {string} kind - data kind.
 * @param {string|null} instrument - canonical instrument key.
 * @param {unknown} data - payload.
 * @param {object} [meta] - partial meta; defaults fill the rest.
 * @param {string[]} [warnings] - caller-facing notes.
 */
export function okEnvelope(kind, instrument, data, meta = {}, warnings = []) {
  return {
    schema: SCHEMA,
    ok: true,
    kind,
    instrument,
    data,
    meta: { ...emptyMeta(), ...meta },
    warnings: [...warnings],
  };
}

/**
 * 失败信封。`data` 为 null，永远不编数据。
 * @param {string} kind - data kind.
 * @param {string|null} instrument - canonical instrument key.
 * @param {string} code - one of `ERROR_CODES`.
 * @param {string} message - short human readable reason.
 * @param {object} [meta] - partial meta.
 * @param {string[]} [warnings] - caller-facing notes.
 */
export function failEnvelope(kind, instrument, code, message, meta = {}, warnings = []) {
  return {
    schema: SCHEMA,
    ok: false,
    kind,
    instrument,
    data: null,
    error: { code, message },
    meta: { ...emptyMeta(), ...meta },
    warnings: [...warnings],
  };
}
