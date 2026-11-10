import z from '@deepseek-ai/schemastery';
import { DEFAULT_SECRET_REF } from './protocol.js';

/**
 * Plugin Config: only the connection identity lives here (the Bot ID and the
 * *reference* to the Secret in DSH's credential store). Everything the operator
 * edits at runtime — the global switch, administrators, the group
 * auto-authorization toggle, workspace grants and nicknames — lives in the
 * plugin's own document (`store.js`, `<DSH home>/wecom-ai-bot/settings.json`)
 * and applies live, without reconnecting the socket.
 */
export const Config = z.object({
  botId: z.string().default('').volatile()
    .description('企业微信智能机器人的 Bot ID（必填）。'),
  secretEnv: z.string().role('credential-ref').default(DEFAULT_SECRET_REF).volatile()
    .description('Bot Secret 在 DSH 凭据库中的引用名；Secret 本身不写入配置。'),
});

export function uniqueIds(values) {
  const result = new Set();
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id) result.add(id);
  }
  return [...result];
}

/** The connection identity, as the bridge wants it. */
export function readBridgeSettings(config) {
  return {
    botId: config.botId.get().trim(),
    secretRef: config.secretEnv.get().trim(),
  };
}

