/**
 * The single data entry point.
 *
 *   const result = await get({ kind: 'quote', instrument: 'hk:02318' });
 *
 * One request shape, one result shape, one cache, one provenance record —
 * regardless of which upstream answered. Providers are chosen by declared
 * capability and by `policy.mjs` preference order; a failing provider falls
 * through to the next one, and an expired cache entry is returned with
 * `meta.stale: true` instead of an empty answer.
 *
 * Every result carries `meta.source` and `meta.fetchedAt`; consumers such as the
 * persona skill must quote those, never a remembered number.
 */
import { TtlCache, stableKey } from './cache.mjs';
import { ERROR_CODES, ProviderError, asProviderError } from './errors.mjs';
import { parseInstrument } from './instruments.mjs';
import { DEFAULT_POLICY, DEFAULT_TTL_MS, KINDS, resolveOrder } from './policy.mjs';
import { eastmoneyProvider } from './providers/eastmoney.mjs';
import { eastmoneyAnnProvider } from './providers/eastmoney-ann.mjs';
import { ifindProvider } from './providers/ifind.mjs';
import { privateProvider } from './providers/private.mjs';
import { tencentProvider } from './providers/tencent.mjs';

/** Registered providers by name. */
const registry = new Map();

/** Process-local cache shared by every consumer. */
const cache = new TtlCache();

/** Options that change the upstream payload and therefore the cache key. */
const OPTION_KEYS = ['periods', 'limit', 'years'];

/**
 * Register or replace one provider.
 * @param provider - `{ name, capabilities, fetch }`.
 * @returns the provider, for chaining.
 */
export function registerProvider(provider) {
  if (provider === null || typeof provider !== 'object' || typeof provider.name !== 'string') {
    throw new TypeError('provider must expose a string name');
  }
  if (typeof provider.fetch !== 'function') {
    throw new TypeError(`provider "${provider.name}" must expose fetch()`);
  }
  registry.set(provider.name, provider);
  return provider;
}

/** Describe the registered providers, for dashboards and debugging. */
export function listProviders() {
  return [...registry.values()].map((provider) => ({
    name: provider.name,
    kinds: [...(provider.capabilities?.kinds ?? [])],
    markets: [...(provider.capabilities?.markets ?? [])],
  }));
}

/** Drop every cached entry (tests, manual invalidation). */
export function clearCache() {
  cache.clear();
}

/** Expose the cache size for health checks. */
export const cacheSize = () => cache.size;

for (const provider of [tencentProvider, eastmoneyProvider, eastmoneyAnnProvider, ifindProvider, privateProvider]) {
  registerProvider(provider);
}

/**
 * Project the caller's options onto the keys that affect the payload.
 * @param options - raw caller options.
 * @returns stable option subset.
 */
function pickOptions(options) {
  const picked = {};
  for (const key of OPTION_KEYS) {
    if (options?.[key] !== undefined) picked[key] = options[key];
  }
  return picked;
}

/**
 * Keep only the providers that claim this kind and market, in policy order.
 * @param kind - data kind.
 * @param market - instrument market, or `undefined` for search.
 * @param policy - provider preference.
 * @returns candidate providers plus names that the policy mentioned but that
 *   are not registered.
 */
function candidatesFor(kind, market, policy) {
  const order = resolveOrder(kind, policy);
  const candidates = [];
  const unknown = [];
  for (const name of order) {
    const provider = registry.get(name);
    if (provider === undefined) {
      unknown.push(name);
      continue;
    }
    const kinds = provider.capabilities?.kinds ?? [];
    const markets = provider.capabilities?.markets ?? [];
    if (!kinds.includes(kind)) continue;
    if (market !== undefined && !markets.includes(market)) continue;
    candidates.push(provider);
  }
  return { candidates, unknown };
}

/**
 * Serialize one cache key.
 * @param kind - data kind.
 * @param subject - instrument key or search query.
 * @param options - option subset.
 * @returns the cache key.
 */
const cacheKeyFor = (kind, subject, options) => `${kind}|${subject}|${stableKey(options)}`;

/**
 * Fetch one kind of data through the provider chain.
 * @param request - `{ kind, instrument | query, options, policy }`.
 * @returns the unified result object.
 */
export async function get(request) {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('request must be an object');
  }
  const { kind } = request;
  if (!KINDS.includes(kind)) {
    throw new TypeError(`unknown kind "${kind}"; expected one of ${KINDS.join(', ')}`);
  }

  const policy = request.policy ?? DEFAULT_POLICY;
  const ttl = request.ttlMs ?? DEFAULT_TTL_MS[kind];
  const options = pickOptions(request.options);

  let instrument = null;
  let subject;
  if (kind === 'search') {
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (query === '') throw new TypeError('search requires a non-empty query');
    subject = query;
  } else if (kind === 'fx') {
    const pair = String(request.pair ?? '').trim().toUpperCase();
    if (!/^[A-Z]{6}$/.test(pair)) {
      throw new TypeError(`fx requires a six-letter pair such as HKDCNY, got "${request.pair}"`);
    }
    subject = pair;
  } else {
    instrument = parseInstrument(request.instrument);
    if (instrument === undefined) {
      throw new TypeError(`invalid instrument "${request.instrument}"; expected e.g. cn:601318 or hk:02318`);
    }
    subject = instrument.key;
  }

  const cacheKey = cacheKeyFor(kind, subject, options);
  // `bypassCache` exists for cross-source verification: two providers must each
  // answer the same question without the first one's cached value leaking in.
  const cached = request.bypassCache === true ? undefined : cache.read(cacheKey);
  if (cached?.fresh === true) {
    return {
      ok: true,
      kind,
      instrument: instrument?.key ?? null,
      data: cached.value,
      meta: {
        source: cached.source,
        fetchedAt: new Date(cached.at).toISOString(),
        cached: true,
        stale: false,
        ttlMs: cached.ttl,
        degraded: [],
      },
      warnings: [],
    };
  }

  const { candidates, unknown } = candidatesFor(kind, instrument?.market, policy);
  const warnings = unknown.map((name) => `policy names unregistered provider "${name}"`);
  const degraded = [];

  for (const provider of candidates) {
    try {
      const { data } = await provider.fetch({ ...request, kind, instrument, options });
      cache.write(cacheKey, data, ttl, provider.name);
      return {
        ok: true,
        kind,
        instrument: instrument?.key ?? null,
        data,
        meta: {
          source: provider.name,
          fetchedAt: new Date().toISOString(),
          cached: false,
          stale: false,
          ttlMs: ttl,
          degraded,
        },
        warnings,
      };
    } catch (error) {
      const providerError = asProviderError(provider.name, error);
      degraded.push({ provider: providerError.provider, code: providerError.code, message: providerError.message });
    }
  }

  if (cached !== undefined) {
    return {
      ok: true,
      kind,
      instrument: instrument?.key ?? null,
      data: cached.value,
      meta: {
        source: cached.source,
        fetchedAt: new Date(cached.at).toISOString(),
        cached: true,
        stale: true,
        ttlMs: cached.ttl,
        degraded,
      },
      warnings: [...warnings, 'every provider failed; returning the last cached payload'],
    };
  }

  const reason = degraded.at(-1)?.message ?? (candidates.length === 0 ? 'no provider serves this request' : 'all providers failed');
  return {
    ok: false,
    kind,
    instrument: instrument?.key ?? null,
    data: null,
    error: {
      code: degraded.at(-1)?.code ?? ERROR_CODES.UNSUPPORTED,
      message: reason,
      providers: degraded,
    },
    meta: {
      source: null,
      fetchedAt: null,
      cached: false,
      stale: false,
      ttlMs: ttl,
      degraded,
    },
    warnings,
  };
}

/**
 * Fetch one kind for several instruments, batching where a provider can.
 *
 * A provider may implement `fetchMany(request, instruments)`; when it does, the
 * router asks it once for every instrument that is not cached yet, so a
 * watchlist costs one upstream call instead of N. Anything batch could not
 * answer falls back to the single-instrument path above.
 *
 * @param request - `{ kind, instruments, options, policy }`.
 * @returns `{ ok, kind, items, invalid, meta, warnings }`, with one result per
 *   instrument in request order.
 */
export async function getMany(request) {
  if (request === null || typeof request !== 'object') throw new TypeError('request must be an object');
  const { kind, instruments } = request;
  if (!KINDS.includes(kind)) throw new TypeError(`unknown kind "${kind}"`);
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new TypeError('getMany requires a non-empty instruments array');
  }

  const policy = request.policy ?? DEFAULT_POLICY;
  const ttl = request.ttlMs ?? DEFAULT_TTL_MS[kind];
  const options = pickOptions(request.options);

  const parsed = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of instruments) {
    const instrument = parseInstrument(raw);
    if (instrument === undefined) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(instrument.key)) continue;
    seen.add(instrument.key);
    parsed.push(instrument);
  }

  // Group uncached instruments by market: one batch call per market and provider.
  const missesByMarket = new Map();
  for (const instrument of parsed) {
    if (cache.read(cacheKeyFor(kind, instrument.key, options))?.fresh === true) continue;
    const list = missesByMarket.get(instrument.market);
    if (list === undefined) missesByMarket.set(instrument.market, [instrument]);
    else list.push(instrument);
  }

  const degraded = [];
  for (const [market, misses] of missesByMarket) {
    if (misses.length < 2) continue; // a single miss is cheaper as a normal fetch
    const { candidates } = candidatesFor(kind, market, policy);
    for (const provider of candidates) {
      if (typeof provider.fetchMany !== 'function') continue;
      try {
        const { data } = await provider.fetchMany({ kind, instruments: misses, options });
        for (const [key, value] of Object.entries(data.byInstrument)) {
          cache.write(cacheKeyFor(kind, key, options), value, ttl, provider.name);
        }
        break;
      } catch (error) {
        const providerError = asProviderError(provider.name, error);
        degraded.push({ provider: providerError.provider, code: providerError.code, message: providerError.message });
      }
    }
  }

  const items = await Promise.all(
    parsed.map((instrument) => get({ kind, instrument: instrument.key, options, policy, ttlMs: ttl })),
  );

  const stale = items.some((item) => item.meta.stale === true);
  const sources = [...new Set(items.map((item) => item.meta.source).filter((source) => source !== null))];
  // One timestamp for the whole batch: the oldest payload actually served, so a
  // repeated cached request reports the same `fetchedAt` instead of a new one.
  const times = items
    .map((item) => item.meta.fetchedAt)
    .filter((value) => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  return {
    ok: items.some((item) => item.ok),
    kind,
    items,
    invalid,
    meta: {
      sources,
      stale,
      fetchedAt: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      degraded,
    },
    warnings: [],
  };
}

/** Convenience: one quote. */
export const getQuote = (instrument, options) => get({ kind: 'quote', instrument, options });

/** Convenience: daily bars. */
export const getBars = (instrument, options) => get({ kind: 'bars', instrument, options });

/** Convenience: name search. */
export const searchInstrument = (query) => get({ kind: 'search', query });

/** Convenience: periodic fundamentals. */
export const getFundamentals = (instrument, options) => get({ kind: 'fundamentals', instrument, options });

/** Convenience: dividend history. */
export const getDividends = (instrument, options) => get({ kind: 'dividends', instrument, options });

/** Convenience: annual reports. */
export const getAnnual = (instrument, options) => get({ kind: 'annual', instrument, options });

/** Convenience: announcement list. */
export const getAnnouncements = (instrument, options) => get({ kind: 'announcements', instrument, options });

export { ProviderError };
