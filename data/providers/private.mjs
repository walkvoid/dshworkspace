/**
 * Private database provider: a stub with the shape a real adapter must take.
 *
 * It declares no capabilities today, so the router never selects it. When the
 * database is ready, fill in `fetch` and add the kinds/markets it can answer:
 * the policy already lists `private` first for fundamentals, dividends, and
 * annual reports, so it starts answering as soon as it claims the capability.
 *
 * Contract, once implemented:
 * - return the same normalized rows the eastmoney provider returns;
 * - read `request.instrument` and `request.options`, never a bare code;
 * - throw a `ProviderError` for anything the database cannot answer, so the
 *   router can fall back to the public source.
 */
import { ERROR_CODES, ProviderError } from '../errors.mjs';

export const privateProvider = {
  name: 'private',
  capabilities: {
    kinds: [],
    markets: [],
  },

  /**
   * @param request - normalized request; see `data/index.mjs`.
   * @returns never resolves today.
   */
  async fetch(request) {
    throw new ProviderError(
      'private',
      ERROR_CODES.UNSUPPORTED,
      `private provider is not configured yet (kind=${request.kind}, instrument=${request.instrument?.key ?? '-'})`,
    );
  },
};
