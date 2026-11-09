/**
 * 本地日线（fin-data 落盘的 CSV）作为 `bars` 的一个实现。
 *
 * 为什么单独一层：fin-data 的日线是**不复权**的原始价，而消费方（看板 K 线）
 * 默认看的是前复权序列。两者口径不同，所以 `bars` 默认仍走实时源，只有调用方
 * 明确 `options.source = 'local'` 时才读本地 CSV，并在 `meta.adjust` 里写明 `none`。
 *
 * 目录约定（与 `findata/store.py` 一致）：
 *   data/daily/cn/<sh|sz|bj|index>/<code>.csv        种子集（入库）
 *   data/local/daily/cn/<sh|sz|bj|index>/<code>.csv  按需拉取（gitignore）
 * `config.json` 的 `storage.compress = "gzip"` 时后缀为 `.csv.gz`。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** fin-data 技能根目录（`api/` 的上一级）。 */
export const FIN_DATA_ROOT = path.resolve(HERE, '..');

/** 数据目录。 */
export const DATA_DIR = path.join(FIN_DATA_ROOT, 'data');

/** CSV 列顺序，与 `findata/store.py::COLUMNS` 一致。 */
const COLUMNS = ['date', 'symbol', 'open', 'high', 'low', 'close', 'volume', 'amount', 'turnover', 'src'];

/** 进程内读取的小 JSON 缓存（manifest/配置变动很少，读到坏文件就退化为空）。 */
const jsonCache = new Map();

/** 读一个小 JSON；失败返回 `null`。 */
function readJson(file) {
  try {
    const stat = fs.statSync(file);
    const cached = jsonCache.get(file);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

/** `config.json`（缺失时按默认值）。 */
export function loadConfig() {
  return readJson(path.join(FIN_DATA_ROOT, 'config.json')) ?? {};
}

/** `data/instruments.json` 的 `items`，按规范代码索引。 */
export function loadInstruments() {
  const raw = readJson(path.join(DATA_DIR, 'instruments.json'));
  return raw?.items ?? {};
}

/** 标的类型：`index` 或 `stock`；查不到按股票处理。 */
function kindOf(symbol) {
  const item = loadInstruments()[symbol];
  return item?.kind === 'index' ? 'index' : 'stock';
}

/** 候选文件路径，按「种子集 -> 本地缓存」顺序。 */
function candidatePaths(instrument) {
  const exchange = instrument.code.slice(0, 2);
  const symbol = `${instrument.code.replace(/^(sh|sz|bj)/, '')}.${exchange.toUpperCase()}`;
  const directory = kindOf(symbol) === 'index' ? 'index' : exchange;
  const code = instrument.code.replace(/^(sh|sz|bj)/, '');
  const compressed = loadConfig()?.storage?.compress === 'gzip';
  const suffixes = compressed ? ['.csv.gz', '.csv'] : ['.csv', '.csv.gz'];
  const roots = [
    { root: path.join(DATA_DIR, 'daily', 'cn'), local: false },
    { root: path.join(DATA_DIR, 'local', 'daily', 'cn'), local: true },
  ];
  const paths = [];
  for (const { root, local } of roots) {
    for (const suffix of suffixes) {
      paths.push({ file: path.join(root, directory, `${code}${suffix}`), local, symbol });
    }
  }
  return paths;
}

/** 解压或直接读文本。 */
function readText(file) {
  const buffer = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
}

/**
 * 解析一份 CSV 为行对象（跳过表头，忽略空行）。
 * @param {string} text - CSV 文本。
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('date,')) continue;
    const parts = line.split(',');
    if (parts.length < COLUMNS.length) continue;
    const row = {};
    for (let index = 0; index < COLUMNS.length; index += 1) row[COLUMNS[index]] = parts[index] === '' ? null : parts[index];
    rows.push(row);
  }
  return rows;
}

/**
 * 读一只标的的本地日线。
 * @param {object} instrument - canonical instrument.
 * @param {object} [options] - `start` / `end` / `limit`（取最后 N 根）。
 * @returns {{found: boolean, file?: string, local?: boolean, symbol?: string, rows?: object[]}}
 */
export function readLocalSeries(instrument, options = {}) {
  if (instrument?.market !== 'cn') return { found: false, reason: 'non-cn' };
  for (const candidate of candidatePaths(instrument)) {
    if (!fs.existsSync(candidate.file)) continue;
    const rows = parseCsv(readText(candidate.file));
    const start = options.start ?? null;
    const end = options.end ?? null;
    let filtered = rows;
    if (start !== null) filtered = filtered.filter((row) => row.date >= start);
    if (end !== null) filtered = filtered.filter((row) => row.date <= end);
    const limit = Number(options.limit);
    if (Number.isFinite(limit) && limit > 0) filtered = filtered.slice(-limit);
    return {
      found: true,
      file: candidate.file,
      local: candidate.local,
      symbol: candidate.symbol,
      rows: filtered,
    };
  }
  return { found: false, reason: 'no-file' };
}

/**
 * 本地日线 -> `bars` 契约里的紧凑数组 `[date, open, close, high, low, volume]`。
 * 顺序与实时源一致，消费方不需要区分来源。
 * @param {object[]} rows - CSV rows.
 */
export function toBars(rows) {
  return rows.map((row) => [
    row.date,
    Number(row.open),
    Number(row.close),
    Number(row.high),
    Number(row.low),
    Number(row.volume),
  ]);
}

/** 序列里出现过的来源短码（`ak` / `ad` / `web`），用于 provenance。 */
export function sourcesOf(rows) {
  const counts = {};
  for (const row of rows) {
    if (row.src === null) continue;
    counts[row.src] = (counts[row.src] ?? 0) + 1;
  }
  return counts;
}
