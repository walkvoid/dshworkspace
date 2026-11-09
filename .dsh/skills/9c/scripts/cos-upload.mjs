#!/usr/bin/env node
/**
 * 用 COS MCP Server 上传本地目录到腾讯云 COS。
 *
 *   node .dsh/skills/9c/scripts/cos-upload.mjs --dir .dsh/skills/9c/knowledge/docs --prefix 9c/docs
 *
 * 凭据从环境变量或 --env-file 读：
 *   COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

if (has('help')) {
  console.log(`用法：node .dsh/skills/9c/scripts/cos-upload.mjs --dir <local-dir> [--prefix 9c/docs] [--env-file .env-prep/cos-mcp.env] [--json]
凭据环境变量：COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY`);
  process.exit(0);
}

const envFile = flag('env-file', '.env-prep/cos-mcp.env');
if (envFile !== '' && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (/^(COS_|Region$|Bucket$|SecretId$|SecretKey$|DatasetName$)/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
const region = process.env.COS_REGION ?? process.env.Region ?? '';
const bucket = process.env.COS_BUCKET ?? process.env.Bucket ?? '';
const secretId = process.env.COS_SECRET_ID ?? process.env.SecretId ?? '';
const secretKey = process.env.COS_SECRET_KEY ?? process.env.SecretKey ?? '';
if (!region || !bucket || !secretId || !secretKey) {
  console.error('缺少 COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY');
  process.exit(1);
}

const localDir = path.resolve(flag('dir', '.dsh/skills/9c/knowledge/docs'));
const prefix = flag('prefix', '9c/docs').replace(/^\/+|\/+$/g, '');
if (!fs.existsSync(localDir)) {
  console.error(`目录不存在：${localDir}`);
  process.exit(1);
}
const files = fs
  .readdirSync(localDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
  .map((entry) => path.join(localDir, entry.name));
if (files.length === 0) {
  console.error(`目录里没有文件：${localDir}`);
  process.exit(1);
}

const child = spawn('npx', ['-y', 'cos-mcp@1.0.15'], {
  env: {
    ...process.env,
    Region: region,
    Bucket: bucket,
    SecretId: secretId,
    SecretKey: secretKey,
    connectType: 'stdio',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  windowsHide: true,
});

const pending = new Map();
let nextId = 1;
let stderr = '';
let closed = false;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim();
  if (!text.startsWith('{')) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
  if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
});
child.on('exit', (code) => {
  if (closed) return;
  closed = true;
  for (const { reject } of pending.values()) reject(new Error(`COS MCP 提前退出（code=${code}）`));
});

function request(method, params = {}, timeout = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeout);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cos-upload', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await request('tools/list', {});

  const uploaded = [];
  const failed = [];
  for (const file of files) {
    const fileName = path.basename(file);
    const targetDir = prefix;
    const response = await request('tools/call', {
      name: 'putObject',
      arguments: { filePath: file, fileName, targetDir },
    });
    const parsed = parseToolText(response);
    if (response?.isError === true) {
      failed.push({ file, error: parsed?.error?.Message ?? parsed?.message ?? String(parsed) });
    } else {
      uploaded.push({ file: fileName, key: `${targetDir}/${fileName}`, size: fs.statSync(file).size });
    }
  }
  child.stdin.end();
  child.kill();
  const report = { ok: failed.length === 0, bucket, region, prefix, uploaded, failed };
  if (has('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`上传到 cos://${bucket}/${prefix}/`);
    for (const item of uploaded) console.log(`OK  ${item.key} (${item.size} bytes)`);
    for (const item of failed) console.log(`ERR ${item.file} — ${item.error}`);
  }
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  child.kill();
  console.error(`上传失败：${error instanceof Error ? error.message : error}`);
  if (stderr.trim() !== '') console.error(stderr.slice(-2000));
  process.exit(1);
}
