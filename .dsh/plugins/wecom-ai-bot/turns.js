function textOf(content) {
  return (content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Walk back from the end of the log to this turn's `turn/start`. */
export function summarizeTurn(session, end) {
  const events = session.snapshotEvents();
  const turn = end.data?.turn;
  let assistantText = '';
  let finalFound = false;
  let steps = 0;
  let startedAt;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === end || event.type === 'turn/end') continue;
    if (event.type === 'turn/start') {
      if (turn === undefined || event.data?.turn === turn) {
        startedAt = event.time;
        break;
      }
      continue;
    }
    if (turn !== undefined && typeof event.data?.turn === 'number' && event.data.turn !== turn) continue;
    switch (event.type) {
      case 'assistant/message': {
        if (finalFound) break;
        const text = textOf(event.data?.message?.content);
        if (!text) break;
        finalFound = true;
        assistantText = text;
        break;
      }
      case 'step/start':
        steps++;
        break;
      default:
        break;
    }
  }
  const endedAt = end.time;
  const failure = end.data?.reason?.kind === 'error' ? end.data.reason.error : undefined;
  const detail = failure && typeof failure === 'object' ? failure : undefined;
  const failureCode = typeof detail?.code === 'string' && /^[a-z][a-z0-9_.\/-]{0,63}$/i.test(detail.code) ? detail.code : undefined;
  const failureStatus = typeof detail?.status === 'number' && Number.isInteger(detail.status) && detail.status >= 400 && detail.status <= 599 ? detail.status : undefined;
  return {
    ...(failureCode || failureStatus ? { failure: { ...(failureCode ? { code: failureCode } : {}), ...(failureStatus ? { status: failureStatus } : {}) } } : {}),
    sessionId: session.id,
    ...(turn === undefined ? {} : { turn }),
    reason: end.data?.reason?.kind ?? 'unknown',
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(startedAt !== undefined && endedAt !== undefined ? { durationMs: endedAt - startedAt } : {}),
    steps,
    assistantText,
  };
}
