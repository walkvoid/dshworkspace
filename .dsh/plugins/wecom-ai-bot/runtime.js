import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { WSClient } from '@wecom/aibot-node-sdk';
import { createBridge } from './bridge.js';
import { readBridgeSettings } from './config.js';
import { createObservationStore } from './observation.js';
import { createStatusTracker } from './status.js';
import { createStore, bindingKey } from './store.js';
import { createMessageLog } from './message-log.js';
import { DEFAULT_WORKSPACE_DIRECTORY, PLUGIN_HOME_DIRECTORY, STORE_VERSION } from './protocol.js';

/** Resolve the DSH home the same way DSH does: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim();
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}
export function pluginHome(env = process.env) {
  return join(resolveDshHome(env), PLUGIN_HOME_DIRECTORY);
}

/** The settings the bridge reads on every message, minus the connection identity. */
function bridgeSettings(config, stored) {
  return {
    enabled: stored.enabled,
    adminUserIds: stored.adminUserIds,
    adminGroupAutoAuthorize: stored.adminGroupAutoAuthorize,
    botId: config.botId.get().trim(),
  };
}

export function createRuntime(options) {
  const { ctx, config, log } = options;
  const journal = options.journal ?? { write() {} };
  const status = createStatusTracker(journal);
  const observations = createObservationStore();
  const store = createStore({
    directory: pluginHome(),
    onError: (error, stage) => log.warn(`WeCom workspace store ${stage} failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  const messageLog = createMessageLog({ directory: pluginHome() });

  const workspaceRegistry = ctx.get?.('workspaceRegistry');
  const defaultWorkspacePath = () => join(pluginHome(), DEFAULT_WORKSPACE_DIRECTORY);
  let defaultWorkspaceId = '';

  /** Register (or reuse) the plugin's own directory as a DSH Workspace. */
  async function ensureDefaultWorkspace() {
    if (!workspaceRegistry) return;
    const target = defaultWorkspacePath();
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      let workspace = await workspaceRegistry.resolveByPath(target);
      if (workspace === undefined) workspace = await workspaceRegistry.create(target);
      defaultWorkspaceId = workspace?.id ?? '';
    } catch (error) {
      log.warn(`default workspace setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function listWorkspaces() {
    if (!workspaceRegistry) return [];
    return workspaceRegistry.list().map(workspace => ({
      workspaceId: workspace.id,
      title: workspace.title ?? '',
      path: workspace.path ?? '',
    }));
  }

  /** Human label for a workspace id; an empty id means the plugin default. */
  function workspaceLabel(workspaceId) {
    const id = String(workspaceId ?? '').trim() || defaultWorkspaceId;
    const workspace = id && workspaceRegistry ? workspaceRegistry.get(id) : undefined;
    if (!workspace) return id || '默认工作空间';
    return workspace.title || workspace.path || id;
  }

  /**
   * Turn a binding's workspaceId into the `sessionController.create` target.
   * Falls back to the plugin's own directory when no Workspace can be used.
   */
  async function resolveSessionTarget(workspaceId) {
    const id = String(workspaceId ?? '').trim() || defaultWorkspaceId;
    if (id && workspaceRegistry?.get(id)) {
      return { workspaceId: id };
    }
    if (id && workspaceRegistry) {
      throw new Error(`工作空间不存在或已被移除（${id}）`);
    }
    const cwd = defaultWorkspacePath();
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return { cwd };
  }

  let bridge;
  let stopBridge;
  let connectionIdentity = '';
  let secret = '';
  let queue = Promise.resolve();
  let disposed = false;
  const disposers = [];
  const scrub = text => (secret.length >= 6 ? text.split(secret).join('[redacted]') : text);

  function sdkLogger() {
    const forward = level => (...args) => {
      const parts = args.map(arg => typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : arg);
      const text = scrub(parts.filter(part => typeof part === 'string').join(' '));
      journal.write({ event: 'wecom.sdk', level, message: parts });
      if (/^Authentication failed/.test(text)) status.set('error', `认证失败：${text.replace(/^Authentication failed:\s*/, '').slice(0, 160)}`);
      else if (/^Max auth failure attempts/.test(text)) status.set('error', '多次认证失败，已停止重试；请检查 Bot ID 与 Secret');
      else if (/^Max reconnect attempts/.test(text)) status.set('offline', '多次重连失败，已停止重连；在插件页重新保存一次即可再连');
    };
    return { debug() {}, info: forward('info'), warn: forward('warn'), error: forward('error') };
  }

  function teardown() {
    stopBridge?.();
    stopBridge = undefined;
    bridge = undefined;
  }

  async function reconfigure() {
    if (disposed) return;
    await store.load();
    if (disposed) return;
    const identity = readBridgeSettings(config);
    const stored = store.settings();
    const summary = bridgeSettings(config, stored);

    // The global switch is off: never dial out, regardless of credentials.
    if (!summary.enabled) {
      teardown();
      secret = '';
      connectionIdentity = '';
      status.set('disabled', '全局开关已关闭');
      return;
    }

    let resolved = '';
    if (identity.secretRef) {
      try {
        resolved = (await ctx.credentials.resolve(identity.secretRef))?.value ?? '';
      } catch (error) {
        if (disposed) return;
        teardown();
        secret = '';
        connectionIdentity = '';
        status.set('error', '读取 DSH 凭据失败');
        journal.write({ event: 'config.error', level: 'error', stage: 'credentials', secretRef: identity.secretRef, error });
        return;
      }
    }
    if (disposed) return;

    const connection = JSON.stringify([identity.botId, resolved]);
    if (connection === connectionIdentity) {
      // Identity unchanged: hand the live bridge the new settings only.
      if (bridge) bridge.updateSettings(summary);
      return;
    }
    connectionIdentity = connection;
    teardown();
    secret = resolved;
    journal.write({ event: 'config.applied', connection: 'rebuilt', botId: identity.botId, secretRef: identity.secretRef, enabled: summary.enabled });
    if (!identity.botId || !resolved) {
      status.set('unconfigured', !identity.botId ? '缺少 Bot ID' : '缺少 Bot Secret');
      return;
    }
    const client = new WSClient({ botId: identity.botId, secret: resolved, logger: sdkLogger() });
    const created = createBridge({
      ctx, client, log, journal, status, scrub, store, observations,
      messageLog, settings: summary, resolveSessionTarget, workspaceLabel,
    });
    client.on('connected', () => journal.write({ event: 'wecom.socket', state: 'connected' }));
    client.on('authenticated', () => status.set('online'));
    client.on('reconnecting', attempt => status.set('reconnecting', `第 ${attempt} 次重连`));
    client.on('disconnected', reason => status.set('offline', scrub(String(reason ?? '')).slice(0, 200) || undefined));
    client.on('error', error => status.set('error', scrub(error?.message ?? String(error)).slice(0, 200)));
    client.on('event.disconnected_event', () => status.set('displaced', '同一个 Bot 在别处建立了新连接，本连接已被断开'));
    client.on('message', frame => {
      void created.handleFrame(frame).catch(error => {
        log.error('WeCom callback failed (details in the journal)');
        journal.write({ event: 'bridge.error', level: 'error', stage: 'message', error });
      });
    });
    try {
      client.connect();
    } catch (error) {
      created.stop();
      client.removeAllListeners();
      status.set('error', scrub(error instanceof Error ? error.message : String(error)).slice(0, 200));
      return;
    }
    stopBridge = () => { created.stop(); client.disconnect(); client.removeAllListeners(); };
    bridge = created;
  }

  function schedule() {
    queue = queue.then(reconfigure).catch(error => {
      log.error('WeCom reconfigure failed (details in the journal)');
      journal.write({ event: 'bridge.error', level: 'error', stage: 'reconfigure', error });
    });
    return queue;
  }

  function onSessionEvent(session, event) {
    if (disposed) return;
    if (event.type === 'turn/end') {
      void bridge?.onTurnEnd(session, event).catch(() => {
        journal.write({ event: 'bridge.error', stage: 'turn-end', sessionId: session.id });
      });
    }
  }

  return {
    observations, status, store,
    async start() {
      const off = [
        ctx.on('app-boot/config-reload', schedule),
        ctx.on('credentials/reference-updated', ref => {
          if (ref === config.secretEnv.get().trim()) schedule();
        }),
        ctx.on('session/event', onSessionEvent),
      ];
      for (const dispose of off) if (typeof dispose === 'function') disposers.push(dispose);
      await store.load();
      await ensureDefaultWorkspace();
      schedule();
      await queue;
    },
    async stop() {
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
      await queue;
      teardown();
      await store.flush();
      await messageLog.flush();
    },
    async state() {
      await store.load();
      const identity = readBridgeSettings(config);
      const stored = store.settings();
      let secretConfigured = false;
      try {
        secretConfigured = Boolean((await ctx.credentials.resolve(identity.secretRef))?.value);
      } catch { /* leave false */ }
      const bindings = store.bindings().map(binding => {
        const key = bindingKey(binding.kind, binding.id);
        const name = store.name(key);
        return Object.freeze({ key, ...binding, name, displayName: name || binding.id });
      });
      const admins = stored.adminUserIds.map(id => {
        const key = `user:${id}`;
        const name = store.name(key);
        return Object.freeze({ id, name, displayName: name || id });
      });
      const rejected = observations.rejected(key => Boolean(store.get(key))).map(row => {
        const name = store.name(row.key);
        return Object.freeze({ ...row, name, displayName: name || row.id });
      });
      return {
        version: STORE_VERSION,
        connection: status.connection(),
        traffic: status.traffic(),
        settings: stored,
        config: { botId: identity.botId, secretRef: identity.secretRef, secretConfigured },
        workspaces: listWorkspaces(),
        defaultWorkspaceId,
        rejected,
        bindings,
        admins,
      };
    },
    async applyOps(ops) {
      await store.load();
      const beforeAdmins = new Set(store.settings().adminUserIds);
      const authorized = [];
      let changed = 0;
      let settingsChanged = false;
      for (const op of ops) {
        switch (op.op) {
          case 'settings.set': {
            const prev = store.settings();
            await store.setSettings(op.patch);
            if (JSON.stringify(prev) !== JSON.stringify(store.settings())) {
              changed++;
              settingsChanged = true;
            }
            break;
          }
          case 'binding.add': {
            const record = await store.create(op.kind, op.id, { workspaceId: op.workspaceId ?? '', name: op.name });
            changed++;
            authorized.push({ kind: op.kind, id: op.id, workspaceId: record.workspaceId });
            break;
          }
          case 'binding.update': {
            if (await store.update(op.key, op.patch)) changed++;
            break;
          }
          case 'binding.remove': {
            if (await store.remove(op.key)) changed++;
            break;
          }
          case 'name.set': {
            await store.setName(op.key, op.name);
            changed++;
            break;
          }
          default:
            return { ok: false, error: `未知操作：${String(op.op)}` };
        }
      }
      const afterAdmins = new Set(store.settings().adminUserIds);
      const promotedAdmins = [...afterAdmins].filter(id => !beforeAdmins.has(id));
      if (settingsChanged) {
        bridge?.updateSettings(bridgeSettings(config, store.settings()));
        await schedule();
      }
      for (const entry of authorized) {
        bridge?.notify(entry.id, authorizedText(entry), 'authorized');
      }
      for (const id of promotedAdmins) {
        bridge?.notify(id, adminGrantedText(), 'admin');
      }
      return { ok: true, changed, ...(promotedAdmins.length ? { promotedAdmins } : {}) };
    },
  };
}

function authorizedText(entry) {
  const who = entry.kind === 'group' ? '这个群' : '你';
  return [
    '**✅ 管理员已授权**',
    '',
    `${who}现在可以和机器人互动了；直接发消息即可。`,
    '> 回复 `/help` 可以获取更多信息。',
  ].join('\n');
}
function adminGrantedText() {
  return [
    '**🔑 你已被设为管理员**',
    '',
    '> 你现在可以在单聊中直接与机器人互动；若开启了「管理员入群自动授权」，你在群里的发言还会自动授权整个群。',
  ].join('\n');
}
