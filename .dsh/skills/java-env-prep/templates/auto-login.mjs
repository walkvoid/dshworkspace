#!/usr/bin/env node
/**
 * auto-login.mjs —— 通用“自动登录 + 复用会话”模板
 *
 * 用法：拷到目标项目的工具目录，改下面 SITE 配置与 login() 的请求体，然后：
 *   node auto-login.mjs login     # 登录并缓存会话
 *   node auto-login.mjs session   # 看会话状态
 *   node auto-login.mjs get /api/xxx
 *
 * 约定：
 *   - 凭据优先环境变量（<SITE>_USER / <SITE>_PASS），其次 .env-prep/<site>-credentials.json；
 *   - 会话缓存同目录 session.json（含 cookie，视为密码）；
 *   - 会话过期（401 / 业务码 01100）自动重登一次；
 *   - 登录被拒立刻停，不重试（避免锁号）。
 *
 * 适配清单：SITE.baseUrl、SITE.login.*、SITE.check.*、isExpired()
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(HERE, 'session.json');
const CRED_FILE = path.resolve(HERE, '..', '.env-prep', 'credentials.json');

const SITE = {
  name: 'site',
  baseUrl: 'https://example.com',
  authMode: 'cookie', // cookie | bearer
  login: {
    url: '/login', // 相对 baseUrl
    method: 'POST',
    body: (username, password) => ({ username, password }), // 按站点改字段名
    // OAuth2 站点：先 GET 授权入口拿 request_id，再往 auth 域 POST，再跟 callback；
    // 见 java-env-prep/references/web-login.md 的“OAuth2 授权码”一节。
  },
  check: { url: '/api/me', method: 'GET' }, // 必须登录才能访问的接口
  tokenPath: 'data.token', // authMode=bearer 时，从响应体取 token 的路径
};

const argv = process.argv.slice(2);
const command = argv[0] ?? 'session';

class CookieJar {
  constructor(map = {}) { this.map = new Map(Object.entries(map)); }

  static load() {
    try { return new CookieJar(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).cookies ?? {}); } catch { return new CookieJar(); }
  }

  save(token = '') {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), token, cookies: Object.fromEntries(this.map) }, null, 2));
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

let jar = new CookieJar();
let token = '';

function readCreds() {
  const prefix = SITE.name.toUpperCase();
  const user = process.env[`${prefix}_USER`] ?? '';
  const pass = process.env[`${prefix}_PASS`] ?? '';
  if (user && pass) return { username: user, password: pass };
  const file = process.env.CRED_FILE || CRED_FILE;
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg.username && cfg.password) return { username: cfg.username, password: cfg.password };
  }
  throw new Error(`缺少凭据：设置 ${prefix}_USER/${prefix}_PASS，或在 ${file} 写 username/password`);
}

async function http(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (jar.map.size) headers.cookie = jar.header();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  jar.absorb(res);
  return res;
}

function isExpired(status, payload) {
  return status === 401 || payload?.code === '01100' || payload?.code === 1100;
}

async function login() {
  const { username, password } = readCreds();
  jar = new CookieJar();
  token = '';
  const body = SITE.login.body(username, password);
  const res = await http(`${SITE.baseUrl}${SITE.login.url}`, {
    method: SITE.login.method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.status >= 400 || (payload.code && payload.code !== 200)) {
    throw Object.assign(new Error(payload.message ?? `登录失败（HTTP ${res.status}）`), { auth: true });
  }
  if (SITE.authMode === 'bearer') {
    token = SITE.tokenPath.split('.').reduce((acc, key) => acc?.[key], payload) ?? token;
    if (!token) throw new Error(`响应里没有 ${SITE.tokenPath}`);
  }
  jar.save(token);
  return { ok: true, cookies: [...jar.map.keys()], hasToken: Boolean(token) };
}

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    jar = new CookieJar(data.cookies ?? {});
    token = data.token ?? '';
  } catch {
    jar = new CookieJar();
    token = '';
  }
}

/**
 * 懒加载：没有会话就登录；有会话先探活，过期才重登。
 * 返回 'login' | 'reused' | 'relogin'。
 * 探活接口要选“必须登录才能访问、且足够便宜”的那个（SITE.check）。
 */
async function ensureSession() {
  loadSession();
  if (!jar.map.size && !token) {
    await login();
    return 'login';
  }
  const probe = await http(`${SITE.baseUrl}${SITE.check.url}`, { method: SITE.check.method, headers: { accept: 'application/json' } });
  const text = await probe.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* 保留原文 */ }
  if (probe.status === 200 && !isExpired(probe.status, payload)) return 'reused';
  await login();
  return 'relogin';
}

async function api(pathname, options = {}, retried = false) {
  await ensureSession();
  const res = await http(`${SITE.baseUrl}${pathname}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* 保留原文 */ }
  if (isExpired(res.status, payload) && !retried) {
    await login();
    return api(pathname, options, true);
  }
  return { status: res.status, payload, text };
}

async function main() {
  if (command === 'login') {
    console.log(JSON.stringify(await login(), null, 2));
    return;
  }
  if (command === 'session') {
    const state = await ensureSession();
    console.log(JSON.stringify({ state, hasSession: jar.map.size > 0 || Boolean(token), cookies: [...jar.map.keys()], hasToken: Boolean(token) }, null, 2));
    return;
  }
  if (command === 'get') {
    const result = await api(argv[1] ?? '/', { method: 'GET' });
    console.log(result.text.slice(0, 2000));
    return;
  }
  if (command === 'check') {
    const result = await api(SITE.check.url, { method: SITE.check.method });
    console.log(JSON.stringify({ status: result.status, code: result.payload?.code ?? null }, null, 2));
    return;
  }
  console.error(`未知命令：${command}（login / session / check / get）`);
  process.exitCode = 1;
}

main().catch((error) => {
  if (error?.auth) {
    console.error(`登录被拒绝：${error.message}（不重试，避免锁号）`);
    process.exitCode = 2;
    return;
  }
  console.error(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
