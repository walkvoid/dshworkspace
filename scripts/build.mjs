/**
 * Rebuild `client.js` from `client-source.js` with the pinned ECharts distribution
 * inlined. ECharts is downloaded once into `.cache/` (git-ignored) so the
 * generated bundle stays reproducible without vendoring 1 MB of upstream code.
 *
 * Usage: node scripts/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'client-source.js');
const targetPath = path.join(root, 'client.js');
const cachePath = path.join(root, '.cache', 'echarts.min.js');
const marker = '/*__ECHARTS_BUNDLE__*/';
const ECHARTS_VERSION = '5.6.0';
const ECHARTS_SOURCES = [
  `https://cdn.jsdelivr.net/npm/echarts@${ECHARTS_VERSION}/dist/echarts.min.js`,
  `https://unpkg.com/echarts@${ECHARTS_VERSION}/dist/echarts.min.js`,
];

/** Minimum plausible size of the minified UMD build. */
const MIN_ECHARTS_BYTES = 500_000;

async function readEcharts() {
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > MIN_ECHARTS_BYTES) {
    return fs.readFileSync(cachePath, 'utf8');
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  for (const url of ECHARTS_SOURCES) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length < MIN_ECHARTS_BYTES) throw new Error(`unexpected payload (${text.length} bytes)`);
      fs.writeFileSync(cachePath, text);
      console.log(`fetched echarts ${ECHARTS_VERSION} from ${url}`);
      return text;
    } catch (error) {
      console.warn(`echarts download failed from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `cannot obtain echarts ${ECHARTS_VERSION}; download dist/echarts.min.js manually to ${cachePath}`,
  );
}

const echartsSource = await readEcharts();
const source = fs.readFileSync(sourcePath, 'utf8');
if (!source.includes(marker)) throw new Error(`missing marker ${marker} in ${sourcePath}`);

const wrapper = [
  '/** ECharts 5.6.0 (Apache-2.0), bundled inline so the client half needs no Harness package. */',
  'const echarts = (function () {',
  '  const module = { exports: {} };',
  '  const exports = module.exports;',
  echartsSource,
  '  return module.exports;',
  '})();',
].join('\n');

const output = source.replace(marker, () => wrapper);
fs.writeFileSync(targetPath, output);
console.log(`wrote ${targetPath} (${(output.length / 1024).toFixed(0)} KiB)`);
