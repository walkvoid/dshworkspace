import { STORE_ROUTE, STATE_ROUTE } from './protocol.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
const MAX_OPS = 200;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** `GET /api/wecom-ai-bot/state` for the settings page. */
export function stateRoute(runtime) {
  return {
    path: STATE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      try {
        return json(await runtime.state());
      } catch {
        return json({ error: 'state unavailable' }, 500);
      }
    },
  };
}

export function isStoreOp(value) {
  if (!value || typeof value !== 'object') return false;
  const record = value;
  switch (record.op) {
    case 'settings.set':
      return Boolean(record.patch) && typeof record.patch === 'object' && !Array.isArray(record.patch);
    case 'binding.add':
      return (record.kind === 'user' || record.kind === 'group') && typeof record.id === 'string'
        && (record.workspaceId === undefined || typeof record.workspaceId === 'string');
    case 'binding.update':
      return typeof record.key === 'string' && Boolean(record.patch) && typeof record.patch === 'object';
    case 'binding.remove':
      return typeof record.key === 'string';
    case 'name.set':
      return typeof record.key === 'string' && typeof record.name === 'string';
    default:
      return false;
  }
}

/** `POST /api/wecom-ai-bot/store` — apply settings/binding/name edits. */
export function storeRoute(runtime) {
  return {
    path: STORE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: '请求体不是 JSON。' }, 400);
      }
      const ops = body?.ops;
      if (!Array.isArray(ops) || !ops.length) {
        return json({ ok: false, error: '缺少要应用的修改。' }, 400);
      }
      if (ops.length > MAX_OPS || !ops.every(isStoreOp)) {
        return json({ ok: false, error: '修改格式不正确。' }, 400);
      }
      try {
        const result = await runtime.applyOps(ops);
        const state = await runtime.state();
        return json({ ok: result.ok, ...(result.error ? { error: result.error } : {}), state }, result.ok ? 200 : 422);
      } catch {
        return json({ ok: false, error: '修改失败，请查看插件日志。' }, 500);
      }
    },
  };
}
