/**
 * Routing policy: which data kinds exist, how long they stay fresh, and which
 * providers may answer them, in preference order.
 *
 * Changing a source means editing this file, not a consumer.
 */

/** Supported data kinds. */
export const KINDS = ['quote', 'bars', 'search', 'fundamentals', 'dividends', 'annual', 'fx', 'announcements'];

/** Freshness per kind: quotes move, annual reports do not. */
export const DEFAULT_TTL_MS = {
  quote: 10_000,
  bars: 5 * 60_000,
  search: 24 * 60 * 60_000,
  fundamentals: 6 * 60 * 60_000,
  dividends: 6 * 60 * 60_000,
  annual: 24 * 60 * 60_000,
  fx: 5 * 60_000,
  announcements: 60 * 60_000,
};

/** Provider preference per kind; the router tries them left to right. */
export const DEFAULT_POLICY = {
  // Tencent stays first: it is free, batches the whole watchlist and needs no
  // quota. iFinD is the authoritative fallback when it cannot answer.
  quote: ['tencent', 'ifind'],
  bars: ['tencent'],
  search: ['tencent'],
  fundamentals: ['private', 'eastmoney'],
  dividends: ['private', 'eastmoney', 'eastmoney-ann'],
  annual: ['private', 'eastmoney'],
  fx: ['tencent'],
  announcements: ['eastmoney-ann'],
};

/**
 * Resolve the provider order for one kind.
 * @param kind - data kind.
 * @param policy - policy override; defaults to `DEFAULT_POLICY`.
 * @returns provider names in attempt order.
 */
export function resolveOrder(kind, policy = DEFAULT_POLICY) {
  const configured = policy[kind];
  return Array.isArray(configured) ? configured : [];
}
