import { bindingKey } from './store.js';

export const OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OBSERVED = 200;
export const MAX_TEXT_CHARS = 120;

function excerpt(value, maxChars) {
  const squashed = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!squashed) return '';
  return squashed.length > maxChars ? `${squashed.slice(0, maxChars)}…` : squashed;
}

/**
 * In-memory record of every sender seen this run, so the settings page can list
 * first-contact senders (including refused ones) and offer to authorize them as
 * a member or an administrator.
 */
export function createObservationStore(options = {}) {
  const ttl = options.ttlMs ?? OBSERVATION_TTL_MS;
  const max = options.maxEntries ?? MAX_OBSERVED;
  const maxText = options.maxTextChars ?? MAX_TEXT_CHARS;
  const now = options.now ?? Date.now;
  const entries = new Map();
  function prune(at) {
    for (const [key, entry] of entries)
      if (entry.lastSeenAt <= at - ttl) entries.delete(key);
  }
  return {
    record(sighting) {
      const at = now();
      prune(at);
      const kind = sighting.chatType === 'group' ? 'group' : 'user';
      const id = kind === 'group' ? sighting.chat : sighting.user;
      const key = bindingKey(kind, id);
      const existing = entries.get(key);
      const entry = existing ?? {
        id, kind, chatType: sighting.chatType, firstSeenAt: at, lastSeenAt: at, messages: 0, refused: false,
      };
      entries.delete(key);
      entry.lastSeenAt = at;
      entry.messages++;
      entry.chatType = sighting.chatType;
      entry.refused = !sighting.accepted;
      const text = !sighting.accepted && sighting.text ? excerpt(sighting.text, maxText) : '';
      if (text) entry.text = text;
      else delete entry.text;
      entries.set(key, entry);
      if (entries.size > max) entries.delete(entries.keys().next().value);
    },
    rejected(authorized) {
      prune(now());
      const rows = [];
      for (const [key, entry] of [...entries].reverse()) {
        if (!entry.refused || authorized(key)) continue;
        rows.push(Object.freeze({
          key, kind: entry.kind, id: entry.id, chatType: entry.chatType,
          ...(entry.text ? { text: entry.text } : {}),
          messages: entry.messages, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt,
        }));
      }
      return rows;
    },
  };
}
