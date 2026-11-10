import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_BINDINGS, MAX_LABEL_CHARS, STORE_FILE, STORE_VERSION } from './protocol.js';
import { uniqueIds } from './config.js';

/** `user:<userid>` for private chats, `group:<chatid>` for groups. */
export function bindingKey(kind, id) {
  return `${kind}:${id}`;
}
export function bindingKeyFor(parts) {
  return parts.chatType === 'group' ? bindingKey('group', parts.chat) : bindingKey('user', parts.user);
}
export function parseBindingKey(key) {
  const match = /^(user|group):(.+)$/.exec(String(key).trim());
  if (!match) return undefined;
  return { kind: match[1], id: match[2] };
}

export function validBindingId(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** One-line nickname/name, bounded and free of control characters. */
export function normalizeLabel(value) {
  if (typeof value !== 'string') return '';
  const squashed = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(squashed)) return '';
  return squashed.slice(0, MAX_LABEL_CHARS);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function defaultStoreSettings() {
  return {
    enabled: true,
    adminUserIds: [],
    adminGroupAutoAuthorize: false,
  };
}

/** Re-type untrusted file content; nonsense values fall back to safe defaults. */
export function normalizeStoreSettings(value) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    enabled: record.enabled !== false,
    adminUserIds: uniqueIds(asArray(record.adminUserIds)),
    adminGroupAutoAuthorize: record.adminGroupAutoAuthorize === true,
  };
}

function stamp(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function normalizeBinding(value) {
  if (!value || typeof value !== 'object') return undefined;
  const record = value;
  const kind = record.kind === 'group' ? 'group' : record.kind === 'user' ? 'user' : undefined;
  if (!kind || !validBindingId(record.id)) return undefined;
  return {
    kind,
    id: record.id.trim(),
    workspaceId: text(record.workspaceId),
    sessionId: text(record.sessionId),
    createdAt: stamp(record.createdAt),
    updatedAt: stamp(record.updatedAt),
  };
}

export function createStore(options) {
  const file = join(options.directory, STORE_FILE);
  const max = options.maxEntries ?? MAX_BINDINGS;
  const now = options.now ?? Date.now;
  const report = (error, stage) => {
    try { options.onError?.(error, stage); } catch { /* reporting must never throw */ }
  };
  const bindings = new Map();
  /** Nicknames by principal key (`user:<id>` / `group:<id>`), members or not. */
  const names = new Map();
  let settings = defaultStoreSettings();
  let loaded;
  let chain = Promise.resolve();
  let dropped = false;

  function loadOnce() {
    loaded ??= readFileOnce();
    return loaded;
  }
  async function setAside(suffix) {
    await rename(file, `${file}.${suffix}`).catch(cause => report(cause, 'quarantine'));
  }
  async function readFileOnce() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') report(error, 'read');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      report(error, 'parse');
      await setAside('corrupt');
      return;
    }
    const version = typeof parsed.version === 'number' || typeof parsed.version === 'string'
      ? String(parsed.version) : '';
    if (version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      report(new Error(`store file version ${version || '(missing)'} is not ${STORE_VERSION}`), 'version');
      await setAside(`v${version.replace(/[^0-9A-Za-z.-]/g, '_').slice(0, 24) || 'unknown'}`);
      return;
    }
    settings = normalizeStoreSettings(parsed.settings);
    for (const entry of parsed.bindings) {
      const record = normalizeBinding(entry);
      if (!record) continue;
      if (!bindings.has(bindingKey(record.kind, record.id)))
        bindings.set(bindingKey(record.kind, record.id), record);
    }
    for (const [key, value] of Object.entries((parsed.names ?? {}))) {
      const nickname = normalizeLabel(value);
      if (!nickname || !parseBindingKey(key)) continue;
      names.set(key, nickname);
    }
  }

  function persist() {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      savedAt: new Date(now()).toISOString(),
      settings,
      bindings: [...bindings.values()],
      names: Object.fromEntries(names),
    }, undefined, 2);
    chain = chain.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        report(error, 'write');
      }
    });
    return chain;
  }

  function putBinding(record) {
    bindings.set(bindingKey(record.kind, record.id), record);
    void persist();
    return record;
  }

  async function writeName(key, value) {
    const nickname = normalizeLabel(value);
    if (nickname) names.set(key, nickname);
    else names.delete(key);
    await persist();
    return nickname;
  }

  return {
    file,
    async load() { await loadOnce(); },
    settings: () => settings,
    async setSettings(patch) {
      await loadOnce();
      const merged = { ...settings };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) merged[key] = value;
      }
      settings = normalizeStoreSettings(merged);
      await persist();
      return settings;
    },
    bindings: () => [...bindings.values()],
    get: key => bindings.get(key),
    async create(kind, id, createOptions = {}) {
      await loadOnce();
      const cleanId = id.trim();
      const key = bindingKey(kind, cleanId);
      const nickname = normalizeLabel(createOptions.name);
      if (nickname) await writeName(key, nickname);
      const existing = bindings.get(key);
      if (existing) {
        const next = { ...existing, ...(createOptions.workspaceId !== undefined ? { workspaceId: createOptions.workspaceId.trim() } : {}), updatedAt: now() };
        return putBinding(next);
      }
      if (bindings.size >= max) {
        if (!dropped) {
          dropped = true;
          report(new Error(`refusing to create more than ${max} authorizations`), 'limit');
        }
        throw new Error(`授权数量已达上限（${max}）`);
      }
      const at = now();
      return putBinding({
        kind, id: cleanId, workspaceId: text(createOptions.workspaceId), sessionId: '', createdAt: at, updatedAt: at,
      });
    },
    async update(key, patch) {
      await loadOnce();
      const existing = bindings.get(key);
      if (!existing) return undefined;
      const next = {
        ...existing,
        ...(patch.workspaceId !== undefined ? { workspaceId: text(patch.workspaceId) } : {}),
        ...(patch.sessionId !== undefined ? { sessionId: text(patch.sessionId) } : {}),
        updatedAt: now(),
      };
      return putBinding(next);
    },
    async remove(key) {
      await loadOnce();
      const existed = bindings.delete(key);
      if (existed) await persist();
      return existed;
    },
    name: key => names.get(key) ?? '',
    async setName(key, value) {
      await loadOnce();
      return await writeName(key, value);
    },
    forSession: sessionId => [...bindings.values()].filter(record => record.sessionId && record.sessionId === sessionId),
    flush: () => chain,
  };
}
