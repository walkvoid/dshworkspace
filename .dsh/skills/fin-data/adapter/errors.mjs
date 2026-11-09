/**
 * Typed provider failures.
 *
 * The router only needs to know "this provider could not answer, try the next
 * one", but the caller needs to know *why* so a stale read or an empty result
 * can be explained instead of guessed at.
 */

/** Stable failure codes; callers may switch on these. */
export const ERROR_CODES = {
  UPSTREAM_DOWN: 'upstream_down',
  TIMEOUT: 'timeout',
  BAD_SHAPE: 'bad_shape',
  NOT_FOUND: 'not_found',
  UNSUPPORTED: 'unsupported',
  RATE_LIMITED: 'rate_limited',
};

/** One provider's failure, carrying its name so the router can report it. */
export class ProviderError extends Error {
  /**
   * @param provider - provider name.
   * @param code - one of `ERROR_CODES`.
   * @param message - short human readable reason.
   * @param options - `cause` is forwarded to `Error`.
   */
  constructor(provider, code, message, options = {}) {
    super(message, options);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
  }
}

/**
 * Normalize anything thrown by a provider into a `ProviderError`.
 * @param provider - provider name.
 * @param error - the caught value.
 * @returns a `ProviderError` with `cause` attached.
 */
export function asProviderError(provider, error) {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /abort|timeout/i.test(message) ? ERROR_CODES.TIMEOUT : ERROR_CODES.UPSTREAM_DOWN;
  return new ProviderError(provider, code, message, { cause: error });
}
