/**
 * Process-local TTL cache with bounded size.
 *
 * A stale entry is kept after expiry: the router returns it with
 * `meta.stale: true` when every provider fails, so a transient upstream outage
 * degrades the answer instead of blanking it.
 */

/** Default retained entries per cache instance. */
const DEFAULT_MAX_ENTRIES = 200;

export class TtlCache {
  /** @param options - `maxEntries` bounds retained keys. */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    /** @type {Map<string, {value: unknown, at: number, ttl: number, source: string}>} */
    this.entries = new Map();
  }

  /**
   * Read one entry.
   * @param key - cache key.
   * @param now - current timestamp.
   * @returns the entry with a `fresh` flag, or `undefined`.
   */
  read(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Refresh insertion order so eviction stays roughly LRU.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry, fresh: now - entry.at < entry.ttl };
  }

  /**
   * Store one entry.
   * @param key - cache key.
   * @param value - payload.
   * @param ttl - lifetime in milliseconds.
   * @param source - provider name that produced the value.
   */
  write(key, value, ttl, source) {
    this.entries.set(key, { value, at: Date.now(), ttl, source });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop every entry. */
  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Serialize options deterministically so cache keys do not depend on key order.
 * @param value - plain options object.
 * @returns stable JSON.
 */
export function stableKey(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.map((key) => [key, value[key]]));
}
