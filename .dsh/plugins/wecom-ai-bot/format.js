/** Text helpers shared by bridge replies and notifications. */
const encoder = new TextEncoder();
export const MAX_INBOUND_BYTES = 6000;
export const MAX_NOTICE_BYTES = 3500;
export const MAX_REPLY_BYTES = 4000;

export function byteLength(text) {
  return encoder.encode(text).length;
}

/** Longest prefix within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function limitBytes(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '…';
  const budget = Math.max(0, maxBytes - byteLength(marker));
  let used = 0;
  let result = '';
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > budget) break;
    used += size;
    result += char;
  }
  return result + marker;
}

export function oneLine(text) {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Bounded identifier without control characters, as WeCom IDs are. */
export function validIdentifier(value, maxBytes = 256) {
  return typeof value === 'string' && Boolean(value.trim())
    && byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Swap Markdown metacharacters so untrusted short text never renders as a tag. */
const INLINE_SWAP = { '*': '＊', '_': '＿', '`': 'ˋ', '[': '［', ']': '］', '<': '‹', '>': '›', '#': '＃' };
export function inline(text, maxBytes = 300) {
  return limitBytes(oneLine(text).replace(/[*_`\[\]<>#]/g, char => INLINE_SWAP[char] ?? char), maxBytes);
}

/** Keep Markdown, but drop anything that could act as a tag or mention. */
export function markdownBody(text, maxBytes) {
  return limitBytes(text.replace(/<(?=[@a-zA-Z/!])/g, '‹'), maxBytes);
}

export function bold(text) {
  return `**${text}**`;
}

export function code(text) {
  return `\`${text}\``;
}

export function title(emoji, text) {
  return bold(`${emoji} ${text}`);
}

export function field(label, value) {
  return `${bold(label)}：${value}`;
}

export function sessionLabel(sessionTitle) {
  return `《${inline(sessionTitle || '未命名会话', 120)}》`;
}

/** Shorten a home-directory prefix for display: /Users/me/x → ~/x. */
export function displayPath(path) {
  return (path ?? '').replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
