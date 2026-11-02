/**
 * One HTTP helper for every provider: timeout, browser-ish headers, and a
 * decodable body. Upstreams reject default Node clients and mix GBK with UTF-8,
 * so both concerns live here instead of in each provider.
 */

/** Upstream timeout; one hung request must not pin a provider open. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/** Headers that the public feeds accept. */
export const BROWSER_HEADERS = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

/**
 * Fetch a URL and decode it to text.
 * @param url - absolute URL.
 * @param options - `encoding` (default utf-8), `referer`, `timeoutMs`, `headers`.
 * @returns decoded body text.
 */
export async function fetchText(url, options = {}) {
  const { encoding = 'utf-8', referer, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = options;
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...BROWSER_HEADERS,
      ...(referer === undefined ? {} : { referer }),
      ...headers,
    },
  });
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}: ${url}`);
  const bytes = await response.arrayBuffer();
  return new TextDecoder(encoding).decode(bytes);
}

/**
 * Fetch a URL and parse it as JSON.
 * @param url - absolute URL.
 * @param options - forwarded to {@link fetchText}.
 * @returns parsed body.
 */
export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`upstream returned malformed JSON: ${url}`);
  }
}
