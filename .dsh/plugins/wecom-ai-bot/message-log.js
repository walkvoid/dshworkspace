import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Append-only plaintext message log (JSON Lines).
 *
 * One line per WeCom request / response packet, written to a daily file under
 * `<pluginHome>/logs/YYYY-MM-DD.jsonl`. Writes are serialized and best-effort:
 * a failure is swallowed so logging can never break message handling.
 */
export function createMessageLog(options = {}) {
  const directory = options.directory;
  const now = options.now ?? (() => new Date());
  let seq = 0;
  let chain = Promise.resolve();

  function dayFile(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`;
  }

  function append(record) {
    const at = now();
    seq += 1;
    const line = `${JSON.stringify({ ts: at.toISOString(), seq, ...record })}\n`;
    const file = join(directory, 'logs', dayFile(at));
    chain = chain.then(async () => {
      try {
        await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 });
        await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Best-effort only; never propagate a logging failure.
      }
    });
    return chain;
  }

  return {
    append,
    flush: () => chain,
  };
}
