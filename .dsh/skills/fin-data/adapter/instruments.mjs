/**
 * Instrument identity: one string in, one canonical descriptor out.
 *
 * Accepted forms:
 *   cn:601318 / cn:sh601318 / sh601318 / 601318   -> A share
 *   hk:02318 / hk02318 / 02318                    -> Hong Kong share
 *
 * Codes are never passed around as bare strings: `instrument.key` is the only
 * identity used for caching, logging, and provider routing.
 */

/** Canonical key shape: `<market>:<code>`. */
const INSTRUMENT_KEY = /^(cn|hk):([a-z0-9]+)$/;

/** A-share code: exchange prefix plus six digits. */
const CN_CODE = /^(sh|sz|bj)\d{6}$/;

/** Hong Kong code: up to five digits (00700 may be typed as 700). */
const HK_CODE = /^\d{1,5}$/;

/** Bare six-digit A-share code. */
const CN_BARE = /^\d{6}$/;

/**
 * Infer the exchange prefix of a bare six-digit A-share code.
 * @param code - six digits.
 * @returns the prefixed code.
 */
function inferCnExchange(code) {
  const first = code[0];
  if (first === '6' || first === '9') return `sh${code}`;
  if (first === '4' || first === '8') return `bj${code}`;
  return `sz${code}`;
}

/**
 * Parse any accepted instrument spelling.
 * @param input - user or caller supplied identifier.
 * @returns normalized instrument, or `undefined` when the input is not recognized.
 */
export function parseInstrument(input) {
  if (typeof input !== 'string') return undefined;
  const value = input.trim().toLowerCase();
  if (value === '') return undefined;

  const keyed = INSTRUMENT_KEY.exec(value);
  if (keyed !== null) {
    const [, market, code] = keyed;
    return buildInstrument(market, code);
  }

  if (CN_CODE.test(value)) {
    return { market: 'cn', code: value, key: `cn:${value}`, currency: 'CNY' };
  }

  if (/^hk\d{1,5}$/.test(value)) {
    const digits = value.slice(2).padStart(5, '0');
    return { market: 'hk', code: digits, key: `hk:${digits}`, currency: 'HKD' };
  }

  if (CN_BARE.test(value)) {
    const code = inferCnExchange(value);
    return { market: 'cn', code, key: `cn:${code}`, currency: 'CNY' };
  }

  // Five digits or four digits: Hong Kong. Six digits were handled above.
  if (HK_CODE.test(value)) {
    const code = value.padStart(5, '0');
    return { market: 'hk', code, key: `hk:${code}`, currency: 'HKD' };
  }

  return undefined;
}

/**
 * Build one instrument from a market and a code.
 * @param market - `cn` or `hk`.
 * @param code - market-specific code, with or without prefix.
 * @returns the canonical instrument.
 */
function buildInstrument(market, code) {
  if (market === 'cn') {
    const normalized = CN_CODE.test(code) ? code : inferCnExchange(code);
    return { market: 'cn', code: normalized, key: `cn:${normalized}`, currency: 'CNY' };
  }
  const normalized = code.replace(/^hk/, '').padStart(5, '0');
  return { market: 'hk', code: normalized, key: `hk:${normalized}`, currency: 'HKD' };
}

/** The Hong Kong feed spells codes with an `hk` prefix. */
export const toTencentCode = (instrument) =>
  instrument.market === 'hk' ? `hk${instrument.code}` : instrument.code;

/** Eastmoney spells codes as `<digits>.<MARKET>`. */
export const toSecuCode = (instrument) =>
  `${instrument.code.replace(/^(sh|sz|bj)/, '')}.${instrument.market === 'hk' ? 'HK' : instrument.code.slice(0, 2).toUpperCase()}`;
