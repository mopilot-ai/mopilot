// How a task session's Host events become the typed `SessionEvent`s the task manager takes: one reading for a session on this Host (its runtime events) and on another Host (the same events inside its journal's durable frames), whatever agent runs it.

/**
 * A Host chat's end, as the task manager reads it. A restart's end says what was cut off; a person's Stop (cancelled, no error) is the manager's own Stop and says nothing; an error carries the typed code the Host gave it (`rate_limit`, `auth`, ...); anything else is the reply.
 * @param {any} end the `turnEnd` event @param {string} text the turn's reply
 * @returns {import('../../../shared/momoTasks/types.ts').SessionEvent | null}
 */
export function endOf(end, text) {
  if (end.interrupted) return { kind: 'lost', reason: end.interrupted.by === 'host_restart' ? 'machine_restarted' : 'session_gone' };
  if (end.error) return { kind: 'failed', signal: end.error.code, message: String(end.error.message ?? end.error) };
  if (end.stopReason === 'cancelled') return null;
  return { kind: 'finished', report: text };
}

/** Whether a chat's state patch says it waits on the person's approval (true), is no longer waiting (false), or says nothing of it (null). @param {any} patch */
export function waitingIn(patch) {
  if (!patch || typeof patch !== 'object' || !('attention' in patch)) return null;
  return patch.attention?.kind === 'approval';
}

/** The chats of tasks that are working, with the reply of the turn running now; reads one chat event at a time. */
export function createTurnReader() {
  /** @type {Map<string, string>} */
  const texts = new Map();
  return {
    /** @param {string} chatId */
    track: (chatId) => void (texts.has(chatId) || texts.set(chatId, '')),
    /** @param {string} chatId */
    untrack: (chatId) => void texts.delete(chatId),
    /** @param {string} chatId */
    has: (chatId) => texts.has(chatId),
    ids: () => [...texts.keys()],
    size: () => texts.size,
    clear: () => texts.clear(),
    /**
     * One chat event. Answers `{ end }` when a tracked chat's turn ended (`end` null for a person's Stop, which says nothing), null for anything else.
     * @param {string} chatId @param {any} e
     * @returns {{ end: import('../../../shared/momoTasks/types.ts').SessionEvent | null } | null}
     */
    read(chatId, e) {
      if (!texts.has(chatId)) return null;
      if (e.kind === 'turnStart') texts.set(chatId, '');
      else if (e.kind === 'update' && e.update?.sessionUpdate === 'agent_message_chunk')
        texts.set(chatId, /** @type {string} */ (texts.get(chatId)) + String(e.update.content?.text ?? ''));
      else if (e.kind === 'turnEnd') {
        const end = endOf(e, /** @type {string} */ (texts.get(chatId)));
        texts.set(chatId, '');
        return { end };
      }
      return null;
    },
  };
}
