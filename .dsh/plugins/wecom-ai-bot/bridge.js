import { randomUUID } from 'node:crypto';
import { bindingKey, bindingKeyFor } from './store.js';
import { byteLength, code, field, inline, limitBytes, markdownBody, title, validIdentifier, MAX_INBOUND_BYTES, MAX_NOTICE_BYTES, MAX_REPLY_BYTES, sessionLabel } from './format.js';
import { summarizeTurn } from './turns.js';

const LEADING_MENTIONS_RE = /^(?:@\S+\s*)+/;
function stripLeadingMentions(text) {
  return text.replace(LEADING_MENTIONS_RE, '');
}

export function parseInbound(frame, botId) {
  if (frame?.cmd !== 'aibot_msg_callback' || !validIdentifier(frame.headers?.req_id, 512)) return null;
  const body = frame.body;
  if (!body || body.aibotid !== botId || !validIdentifier(body.msgid, 512)) return null;
  if (typeof body.msgtype !== 'string' || !body.msgtype) return null;
  if (body.chattype !== 'single' && body.chattype !== 'group') return null;
  const user = body.from?.userid;
  if (!validIdentifier(user)) return null;
  const chat = body.chattype === 'group' ? body.chatid : user;
  if (!validIdentifier(chat)) return null;
  const rawText = body.msgtype === 'text' ? body.text?.content : undefined;
  const text = typeof rawText === 'string' && body.chattype === 'group' ? stripLeadingMentions(rawText) : rawText;
  return {
    frame,
    reqId: frame.headers.req_id,
    msgId: body.msgid,
    chat,
    user,
    chatType: body.chattype,
    msgtype: body.msgtype,
    ...(typeof text === 'string' ? { text } : {}),
  };
}

export function createReplayGuard(windowMs = 5 * 60 * 1000, maxEntries = 1000) {
  const seen = new Map();
  return {
    first(id, now = Date.now()) {
      for (const [key, time] of seen) {
        if (time > now - windowMs && seen.size <= maxEntries) break;
        seen.delete(key);
      }
      if (seen.has(id)) return false;
      seen.set(id, now);
      return true;
    },
  };
}

function parseCommand(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = /^\/([A-Za-z]+)\s*(.*)$/.exec(trimmed);
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

export function createBridge(deps) {
  const { ctx, client, log, journal, status, scrub, store, observations, messageLog, resolveSessionTarget, workspaceLabel } = deps;
  // Mutable reference: `updateSettings` reassigns it when the runtime adopts a
  // new settings block, and every closure here reads the latest value.
  let settings = deps.settings;
  const replay = createReplayGuard();
  const lifetime = new AbortController();
  let closed = false;
  /** sessionId → number of WeCom-originated prompts still running. */
  const pendingPrompts = new Map();
  /** chat → delete confirmation in progress. */
  const pendingDelete = new Map();
  const chains = new Map();

  const isAdmin = user => settings.adminUserIds.includes(user);

  function parts(message) {
    return { chat: message.chat, user: message.user, chatType: message.chatType };
  }

  function serialize(chat, task) {
    const previous = chains.get(chat) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    chains.set(chat, tail);
    void tail.then(() => { if (chains.get(chat) === tail) chains.delete(chat); });
    return run;
  }

  async function reply(message, text) {
    if (closed) return;
    const content = limitBytes(text, MAX_REPLY_BYTES);
    const streamId = `stream_${randomUUID()}`;
    messageLog.append({ level: 'info', event: 'wecom.response', direction: 'out', chat: message.chat, chatType: message.chatType, kind: 'reply', msgtype: 'stream', streamId, content });
    try {
      await client.replyStream(message.frame, streamId, content, true);
    } catch (error) {
      status.count('failures');
      log.warn('WeCom reply failed');
      journal.write({ event: 'wecom.reply', level: 'warn', chatId: message.chat, error: scrub(String(error?.message ?? error)) });
    }
  }

  function notify(chat, text, kind) {
    if (closed || !chat) return;
    const content = limitBytes(text, MAX_NOTICE_BYTES);
    messageLog.append({ level: 'info', event: 'wecom.response', direction: 'out', chat, kind, msgtype: 'markdown', content });
    client.sendMessage(chat, { msgtype: 'markdown', markdown: { content } })
      .then(() => status.count('notifications'))
      .catch(error => {
        status.count('failures');
        journal.write({ event: 'wecom.send', level: 'warn', chatId: chat, kind, error: scrub(String(error?.message ?? error)) });
      });
  }

  function nameSession(sessionId, name) {
    try {
      const sessions = ctx.get?.('sessions');
      const titles = ctx.get?.('sessionTitle');
      const session = sessions?.get?.(sessionId);
      if (session && typeof titles?.rename === 'function') titles.rename(session, name);
    } catch {
      journal.write({ event: 'dsh.session.title', level: 'warn', sessionId });
    }
  }

  async function ensureSession(binding) {
    const key = bindingKey(binding.kind, binding.id);
    if (binding.sessionId) return binding.sessionId;
    const target = await resolveSessionTarget(binding.workspaceId);
    const created = await ctx.sessionController.create(target);
    const updated = await store.update(key, { sessionId: created.sessionId });
    if (!updated) return undefined;
    nameSession(created.sessionId, `wecom-ai-bot-${binding.id}`);
    journal.write({ event: 'session.created', binding: key, sessionId: created.sessionId, target });
    return created.sessionId;
  }

  /** Accepts the sender, and where the message must go. */
  async function resolveAccess(message) {
    const key = bindingKeyFor(parts(message));
    let binding = store.get(key);
    if (binding) return { accepted: true, binding };
    if (message.chatType === 'single' && isAdmin(message.user)) {
      binding = await store.create('user', message.user, { workspaceId: '' });
      return { accepted: true, binding };
    }
    if (message.chatType === 'group' && isAdmin(message.user) && settings.adminGroupAutoAuthorize) {
      binding = await store.create('group', message.chat, { workspaceId: '' });
      return { accepted: true, binding, autoGroup: true };
    }
    return { accepted: false, reason: 'unauthorized' };
  }

  async function submitPrompt(message, content) {
    const key = bindingKeyFor(parts(message));
    const binding = store.get(key);
    if (!binding) {
      await reply(message, `${title('↩️', '授权已变更')}\n> 本条消息未提交，请重新发送。`);
      return;
    }
    let sessionId;
    try {
      sessionId = await ensureSession(binding);
    } catch (error) {
      journal.write({ event: 'bridge.error', level: 'error', stage: 'session', error });
      await reply(message, `${title('⚠️', '无法创建会话')}\n> ${inline(error instanceof Error ? error.message : String(error))}`);
      return;
    }
    if (!sessionId) {
      await reply(message, `${title('↩️', '授权已变更')}\n> 本条消息未提交，请重新发送。`);
      return;
    }
    await reply(message, `${title('🚀', '已提交给 DSH')} · ${sessionLabel(undefined)}\n> 本轮完成后我会在这里通知你；发送 /cancel 可以停止本轮。`);
    try {
      const request = {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      };
      pendingPrompts.set(sessionId, (pendingPrompts.get(sessionId) ?? 0) + 1);
      await ctx.sessionController.prompt(request, lifetime.signal);
      status.count('prompts');
      journal.write({ event: 'dsh.prompt', sessionId, chatId: message.chat, userId: message.user });
    } catch (error) {
      pendingPrompts.set(sessionId, Math.max(0, (pendingPrompts.get(sessionId) ?? 1) - 1));
      status.count('failures');
      journal.write({ event: 'dsh.prompt', level: 'warn', sessionId, error });
      await reply(message, `${title('⚠️', 'DSH 提交失败')}\n> DSH 未接受这条消息，请到 DSH 页面查看详情后重试。`);
    }
  }

  async function whoamiText(message) {
    const key = bindingKeyFor(parts(message));
    const binding = store.get(key);
    const nickname = store.name(key) || binding?.id || message.user;
    const admin = isAdmin(message.user);
    const lines = [
      `${title('👤', '你的身份')}`,
      '',
      `- ${field('昵称', inline(nickname, 120))}`,
      `- ${field('ID', code(inline(message.user, 120)))}`,
      `- ${field('身份', admin ? '管理员' : (binding ? '已授权成员' : '未授权'))}`,
    ];
    if (binding) {
      const label = workspaceLabel(binding.workspaceId);
      lines.push(`- ${field('工作空间', inline(label || '默认工作空间', 160))}`);
    }
    if (message.chatType === 'group') lines.push(`- ${field('会话类型', '群聊（全群共享）')}`);
    return lines.join('\n');
  }

  async function runCommand(message, command) {
    switch (command.name) {
      case 'help':
        await reply(message, [
          title('📖', '企业微信 · DSH 智能机器人'),
          '',
          '直接把消息发给我，就会进入你的 DSH 会话（授权工作空间内）；本轮结束后，我会把结果发回这里。',
          '',
          `- ${code('/help')} — 显示这份说明`,
          `- ${code('/whoami')} — 查看昵称、ID、管理员身份与授权工作空间`,
          `- ${code('/status')} — 查看当前会话`,
          `- ${code('/cancel')} — 停止正在运行的回合`,
          `- ${code('/delete')} — 归档当前会话（再发 ${code('/delete confirm')} 确认）`,
        ].join('\n'));
        return;
      case 'whoami':
        await reply(message, await whoamiText(message));
        return;
      case 'status': {
        const key = bindingKeyFor(parts(message));
        const binding = store.get(key);
        if (!binding) {
          await reply(message, `${title('ℹ️', '还没有会话')}\n> 发送任意消息即可创建。`);
          return;
        }
        const lines = [
          `${title('🗂', '当前会话')}`,
          '',
          `- ${field('会话', binding.sessionId ? code(inline(binding.sessionId, 40)) : '待创建')}`,
          `- ${field('工作空间', inline(workspaceLabel(binding.workspaceId) || '默认工作空间', 160))}`,
        ];
        await reply(message, lines.join('\n'));
        return;
      }
      case 'cancel': {
        const binding = store.get(bindingKeyFor(parts(message)));
        if (!binding?.sessionId) {
          await reply(message, `${title('ℹ️', '没有正在运行的会话')}`);
          return;
        }
        try {
          ctx.sessionController.cancel({ sessionId: binding.sessionId });
          await reply(message, `${title('⏹', '已请求停止本轮')}`);
        } catch (error) {
          await reply(message, `${title('⚠️', '停止失败')}\n> ${inline(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case 'delete': {
        const key = bindingKeyFor(parts(message));
        const binding = store.get(key);
        if (!binding?.sessionId) {
          await reply(message, `${title('ℹ️', '还没有会话可以归档')}`);
          return;
        }
        if (command.args.toLowerCase() === 'confirm') {
          const registry = ctx.get?.('workspaceRegistry');
          if (!registry || typeof registry.archiveSession !== 'function') {
            await reply(message, `${title('⚠️', '当前 DSH 无法归档会话')}`);
            return;
          }
          try {
            await registry.archiveSession(binding.sessionId, { stopActivity: true });
          } catch (error) {
            await reply(message, `${title('⚠️', '归档失败')}\n> ${inline(error instanceof Error ? error.message : String(error))}`);
            return;
          }
          await store.update(key, { sessionId: '' });
          pendingDelete.delete(message.chat);
          await reply(message, `${title('🗑', '会话已归档')}\n> 下一条消息会在新会话里开始。`);
          return;
        }
        pendingDelete.set(message.chat, true);
        await reply(message, [
          `${title('🗑', '归档会话会清空它的记忆')}`,
          '',
          '确认后这个会话不再被继续，历史不会再进入任何请求，下一条消息会在新会话里开始。',
          '',
          `再发送一次 ${code('/delete confirm')} 确认；其它消息不会执行这个操作。`,
        ].join('\n'));
        return;
      }
      default:
        await reply(message, `${title('❓', '未知命令')}\n> 发送 ${code('/help')} 查看可用命令。`);
    }
  }

  async function handleMessage(message) {
    if (closed) return;
    status.count('received');
    journal.write({
      event: 'wecom.message', chatId: message.chat, userId: message.user, chatType: message.chatType,
      msgId: message.msgId, msgtype: message.msgtype,
    });
    const access = await resolveAccess(message);
    observations.record({
      chat: message.chat, user: message.user, chatType: message.chatType,
      accepted: access.accepted,
      ...(message.text ? { text: message.text } : {}),
    });
    if (!access.accepted) {
      status.count('rejected');
      await reply(message, `${title('🔒', '用户未授权')}\n\n请联系管理员，把你或你所在的群授权后再试。`);
      return;
    }
    if (access.autoGroup) {
      await reply(message, `${title('✅', '管理员已授权本群')}\n\n这个群现在可以和机器人互动了；直接发消息即可。`);
      return;
    }
    if (message.msgtype !== 'text') {
      await reply(message, `${title('⚠️', '目前只支持文本消息')}\n\n图片、语音、文件暂时无法提交给 DSH。`);
      return;
    }
    const content = message.text?.trim() ?? '';
    if (!content) {
      await reply(message, `${title('⚠️', '消息内容为空')}\n\n发送文字内容即可继续这个会话。`);
      return;
    }
    if (byteLength(content) > MAX_INBOUND_BYTES) {
      await reply(message, `${title('⚠️', '消息过长')}\n\n请缩短后再发送。`);
      return;
    }
    const command = parseCommand(content);
    if (command) {
      await runCommand(message, command);
      return;
    }
    if (pendingDelete.has(message.chat)) pendingDelete.delete(message.chat);
    await submitPrompt(message, content);
  }

  async function handleFrame(frame) {
    if (closed) return;
    messageLog.append({ level: 'info', event: 'wecom.request', direction: 'in', frame });
    const message = parseInbound(frame, settings.botId);
    if (!message) {
      journal.write({ event: 'wecom.message.ignored', level: 'debug', reason: 'invalid-or-foreign-frame' });
      return;
    }
    if (!replay.first(message.msgId)) return;
    return await serialize(message.chat, () => handleMessage(message));
  }

  async function onTurnEnd(session, end) {
    if (closed) return;
    const count = pendingPrompts.get(session.id) ?? 0;
    if (!count) return;
    pendingPrompts.set(session.id, count - 1);
    const summary = summarizeTurn(session, end);
    const chats = store.forSession(session.id).map(binding => binding.id);
    if (!chats.length) return;
    const text = summary.reason === 'error'
      ? `${title('❌', 'DSH 会话因错误终止')} · ${sessionLabel(summary.assistantText ? '' : undefined)}\n> 本轮已停止，请到 DSH 页面查看错误详情；原始错误内容不会外发。`
      : [
          `${title('✅', 'DSH 本轮完成')}`,
          '',
          summary.assistantText ? markdownBody(summary.assistantText, MAX_NOTICE_BYTES - 400) : '本轮没有可展示的文本回复。',
        ].join('\n');
    for (const chat of chats) notify(chat, text, 'turn-complete');
  }

  return {
    handleFrame,
    onTurnEnd,
    notify,
    updateSettings(next) {
      settings = next;
    },
    stop() {
      closed = true;
      lifetime.abort();
      chains.clear();
      pendingDelete.clear();
      pendingPrompts.clear();
    },
  };
}
