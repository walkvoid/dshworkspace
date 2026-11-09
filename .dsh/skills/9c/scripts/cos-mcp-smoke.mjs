#!/usr/bin/env node
/**
 * 腾讯云 COS MCP Server 冒烟测试（不依赖 DSH）。
 *
 * 用 stdio 启动 `npx -y cos-mcp@<version>`，依次：
 *   1. initialize
 *   2. tools/list
 *   3. tools/call getCosConfig（只返回掩码后的配置）
 *   4. tools/call getBucket（验证 SecretId/SecretKey/Bucket/Region 是否真的可用）
 *
 * 凭据只从环境变量读，不打印、不写文件：
 *   COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY / COS_DATASET_NAME
 *
 * 用法：
 *   node .dsh/skills/9c/scripts/cos-mcp-smoke.mjs
 *   node .dsh/skills/9c/scripts/cos-mcp-smoke.mjs --no-bucket      # 只验证 MCP 能启动、工具能列出来
 *   node .dsh/skills/9c/scripts/cos-mcp-smoke.mjs --json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

if (has('help')) {
  console.log(`用法：node .dsh/skills/9c/scripts/cos-mcp-smoke.mjs [--no-bucket] [--write] [--json] [--version 1.0.15] [--timeout 120] [--env-file .env-prep/cos-mcp.env]
凭据环境变量：COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY / COS_DATASET_NAME

  --prefix <path>       只列该前缀下的对象
  --write               额外做一次 putString + getObject 回读（会留下一个 _mcp-smoke/ 测试文件）
  --write-key <key>     指定测试对象路径，默认 _mcp-smoke/hello-<时间戳>.txt
  --write-content <s>   指定写入内容`);
  process.exit(0);
}

// 可选：从本地 .env 文件读凭据，避免把 SecretKey 贴到命令行/聊天里。
const envFile = flag('env-file', '');
if (envFile !== '') {
  if (!fs.existsSync(envFile)) {
    console.error(`找不到 --env-file：${envFile}`);
    process.exit(1);
  }
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

const version = flag('version', '1.0.15');
const timeoutMs = Number(flag('timeout', '120')) * 1000;
const region = process.env.COS_REGION ?? process.env.Region ?? '';
const bucket = process.env.COS_BUCKET ?? process.env.Bucket ?? '';
const secretId = process.env.COS_SECRET_ID ?? process.env.SecretId ?? '';
const secretKey = process.env.COS_SECRET_KEY ?? process.env.SecretKey ?? '';
const dataset = process.env.COS_DATASET_NAME ?? process.env.DatasetName ?? '';
const bucketPrefix = flag('prefix', '');

if (region === '' || bucket === '' || secretId === '' || secretKey === '') {
  console.error('缺少环境变量：COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY');
  console.error('请先设置后再跑；不要把 SecretKey 写进命令行参数。');
  process.exit(1);
}

const child = spawn('npx', ['-y', `cos-mcp@${version}`], {
  env: {
    ...process.env,
    Region: region,
    Bucket: bucket,
    SecretId: secretId,
    SecretKey: secretKey,
    ...(dataset ? { DatasetName: dataset } : {}),
    connectType: 'stdio',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  windowsHide: true,
});

const pending = new Map();
let nextId = 1;
let closed = false;
let stderr = '';

function fail(message) {
  if (closed) return;
  closed = true;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  console.error(message);
  process.exit(1);
}

const timer = setTimeout(() => fail(`COS MCP 在 ${timeoutMs / 1000}s 内没有完成握手`), timeoutMs);

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
  // 只保留最后一段，避免 npx 下载日志淹没错误
  if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
});

child.on('exit', (code) => {
  if (closed) return;
  closed = true;
  clearTimeout(timer);
  for (const { reject } of pending.values()) reject(new Error(`COS MCP 提前退出（code=${code}）`));
  if (pending.size > 0) fail(`COS MCP 提前退出（code=${code}）\n${stderr.slice(-2000)}`);
});

function request(method, params = {}, timeout = 30_000) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const requestTimer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（${timeout / 1000}s）`));
    }, timeout);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(requestTimer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(requestTimer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeBucketError(result, parsed) {
  if (result?.isError === true) {
    if (parsed && typeof parsed === 'object') {
      return parsed.error?.Message ?? parsed.message ?? parsed.code ?? JSON.stringify(parsed);
    }
    return String(parsed);
  }
  if (parsed && typeof parsed === 'object' && (parsed.error || parsed.code)) {
    return parsed.error?.Message ?? parsed.message ?? parsed.code;
  }
  return null;
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cos-mcp-smoke', version: '1.0.0' },
  });
  notify('notifications/initialized');
  const tools = await request('tools/list', {});
  const toolNames = (tools?.tools ?? []).map((tool) => tool.name);
  if (toolNames.length < 10) throw new Error(`只发现 ${toolNames.length} 个工具，可能启动不完整`);

  const config = parseToolText(await request('tools/call', { name: 'getCosConfig', arguments: {} }));

  let bucketResult = null;
  let bucketError = null;
  if (!has('no-bucket')) {
    try {
      const response = await request(
        'tools/call',
        { name: 'getBucket', arguments: bucketPrefix === '' ? {} : { Prefix: bucketPrefix } },
        60_000,
      );
      const parsed = parseToolText(response);
      const error = describeBucketError(response, parsed);
      if (error === null) bucketResult = parsed;
      else bucketError = error;
    } catch (error) {
      bucketError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = {
    ok: bucketError === null,
    server: init?.serverInfo ?? null,
    protocolVersion: init?.protocolVersion ?? null,
    tools: toolNames,
    toolCount: toolNames.length,
    config,
    bucket: has('no-bucket') ? 'skipped' : bucketError === null ? 'ok' : `failed: ${bucketError}`,
    ...(bucketResult ? { bucketSample: bucketResult } : {}),
  };

  if (has('write')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const objectKey = flag('write-key', `_mcp-smoke/hello-${stamp}.txt`);
    const slash = objectKey.lastIndexOf('/');
    const targetDir = slash === -1 ? '' : objectKey.slice(0, slash);
    const fileName = slash === -1 ? objectKey : objectKey.slice(slash + 1);
    const content = flag(
      'write-content',
      `COS MCP smoke test\nbucket: ${bucket}\nregion: ${region}\ntime: ${new Date().toISOString()}\n`,
    );
    try {
      const putResponse = await request(
        'tools/call',
        { name: 'putString', arguments: { content, fileName, targetDir, contentType: 'text/plain; charset=utf-8' } },
        60_000,
      );
      const putParsed = parseToolText(putResponse);
      const putError = describeBucketError(putResponse, putParsed);
      if (putError !== null) {
        report.write = `failed: ${putError}`;
        report.ok = false;
      } else {
        report.write = 'ok';
        report.writeKey = objectKey;
        const getResponse = await request('tools/call', { name: 'getObject', arguments: { objectKey } }, 60_000);
        const getParsed = parseToolText(getResponse);
        const getError = describeBucketError(getResponse, getParsed);
        if (getError !== null) {
          report.readBack = `failed: ${getError}`;
          report.ok = false;
        } else {
          report.readBack = getParsed === content ? 'ok' : 'ok（内容与写入不一致）';
          if (getParsed !== content) report.ok = false;
        }
      }
    } catch (error) {
      report.write = `failed: ${error instanceof Error ? error.message : String(error)}`;
      report.ok = false;
    }
  }

  if (has('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`COS MCP 握手：OK（${init?.serverInfo?.name ?? 'unknown'} ${init?.serverInfo?.version ?? ''}）`);
    console.log(`工具数量：${toolNames.length}`);
    console.log(`配置：Region=${config?.cosConfig?.Region ?? region}，Bucket=${config?.cosConfig?.Bucket ?? bucket}`);
    if (has('no-bucket')) console.log('Bucket 列表：跳过（--no-bucket）');
    else if (bucketError === null) console.log('Bucket 列表：OK（凭据可用）');
    else console.log(`Bucket 列表：FAILED — ${bucketError}`);
    if (has('write')) {
      console.log(`写入测试：${report.write}${report.writeKey ? `（${report.writeKey}）` : ''}`);
      if (report.readBack) console.log(`回读测试：${report.readBack}`);
    }
  }
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  clearTimeout(timer);
  child.kill();
  if (has('json')) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stderr: stderr.slice(-3000) }, null, 2));
  } else {
    console.error(`COS MCP 测试失败：${error instanceof Error ? error.message : error}`);
    if (stderr.trim() !== '') console.error(stderr.slice(-3000));
  }
  process.exit(1);
}
