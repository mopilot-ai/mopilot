// Owns the remote-send queue projection and the sent inputs retained until a transcript turn has been applied.
const { waitingFor } = require('./outbox.cjs');

/** @param {{ outbox: any, state: () => any, ownerOf: (chatId: string) => { hostId: string }, rowOf: (hostId: string) => any, connected: (hostId: string) => boolean, signin: Set<string>, refused: Map<string, any>, describe: (chatId: string, entry: any) => { line: string, action: string | null, retry: boolean, mode?: string, named?: true, agent?: string, machine: string, hostId: string }, moved: Set<string>, moving: Map<string, string | null>, sideStart?: (chatId: string) => unknown, accepted?: (chatId: string) => void }} o */
function createSendProjection({ outbox, state, ownerOf, rowOf, connected, signin, refused, describe, moved, moving, sideStart, accepted }) {
  /** @type {Map<string, { key: string, text: string, item: any, shown: boolean }[]>} */
  const sentLog = new Map();
  const has = (/** @type {string} */ chatId, /** @type {string} */ key) => (sentLog.get(chatId) ?? []).some((m) => m.key === key);
  const pendingStart = (/** @type {string} */ chatId, /** @type {string} */ key) => Boolean(sideStart?.(chatId)) && has(chatId, key);
  /** @type {Map<string, Set<string>>} */
  const shown = new Map();
  /** @param {string} chatId @param {any} entry */
  function refusalOf(chatId, entry) {
    const { line, action, retry, agent, machine, hostId, mode, named } = describe(chatId, entry);
    // `own`: this app refused it before the Host saw it, so the row does not say the Host did
    return {
      error: line,
      refusal: {
        code: entry.code,
        action,
        retry,
        hostId,
        machine,
        ...(entry.own === true ? { own: true } : {}),
        ...(named ? { named: true } : {}),
        ...(agent ? { agent } : {}),
        ...(mode ? { mode } : {}),
        ...(named ? { named: true } : {}),
      },
    };
  }
  /** Keys of messages the Host took into its running turn: nothing starts a turn for them, so they leave the queue when that turn ends. @type {Set<string>} */
  const steeredKeys = new Set();
  /** The chat's queue: what the controller put there, then the messages kept for the Host. @param {string} chatId */
  function project(chatId) {
    const store = state();
    const own = shown.get(chatId) ?? new Set();
    const entries = outbox.pending(chatId).filter((e) => e.state === 'queued');
    const { hostId } = ownerOf(chatId);
    // away until both the registry and the connection say the machine answers
    const online = waitingFor(rowOf(hostId)) === null && connected(hostId);
    const items = entries.map((e) => ({
      .../** @type {any} */ (e.options).item,
      id: e.key,
      waitingFor: moving.has(chatId)
        ? 'hostMoving'
        : signin.has(e.key)
          ? 'orgSignin'
          : refused.has(e.key)
            ? 'hostRefused'
            : moved.has(e.key)
              ? 'hostMoved'
              : online
                ? undefined
                : 'host',
      // the machine the move is going to, for the row's cause
      ...(moving.get(chatId) ? { movingTo: moving.get(chatId) } : {}),
      // why the Host refused it, as the row says it: the cause, the one action that fixes it and whether Retry can succeed
      ...(refused.has(e.key) ? refusalOf(chatId, refused.get(e.key)) : {}),
      ...(pendingStart(chatId, e.key) ? { pendingStart: true } : {}),
    }));
    // a message the Host has but the transcript does not yet shows as it was sent, with no waiting state
    // the window that sent it already draws it in the transcript (a chat idle at send): the queue only has what is really waiting
    const taken = (sentLog.get(chatId) ?? []).filter((m) => !m.shown && !entries.some((e) => e.key === m.key));
    items.unshift(
      ...taken.map((m) => ({ ...m.item, id: m.key, waitingFor: undefined, ...(steeredKeys.has(m.key) ? { steered: true } : {}) })),
    );
    shown.set(chatId, new Set(items.map((i) => i.id)));
    const rest = store.get(chatId).queue.filter((q) => !own.has(q.id));
    store.patch(chatId, { queue: [...rest, ...items] });
  }

  return {
    project,
    has,
    pendingStart,
    /** @param {string} chatId @param {string} key @param {string} text @param {any} item @param {boolean} [shown] the sending window draws it in the transcript at once */
    remember(chatId, key, text, item, shown = false) {
      const log = sentLog.get(chatId) ?? [];
      if (!log.some((m) => m.key === key)) sentLog.set(chatId, [...log, { key, text, item: { ...item, id: key }, shown }]);
    },
    /** The Host took this message into its running turn: shown as sent, without Send, until the turn ends. @param {string} chatId @param {string} key */
    steered(chatId, key) {
      if (!(sentLog.get(chatId) ?? []).some((m) => m.key === key)) return;
      steeredKeys.add(key);
      project(chatId);
    },
    /** @param {string} chatId @param {string} key */
    forget(chatId, key) {
      sentLog.set(
        chatId,
        (sentLog.get(chatId) ?? []).filter((m) => m.key !== key),
      );
    },
    /** @param {string} chatId @param {string} key */
    remove(chatId, key) {
      const log = sentLog.get(chatId);
      if (!log?.some((m) => m.key === key)) return false;
      sentLog.set(
        chatId,
        log.filter((m) => m.key !== key),
      );
      project(chatId);
      return true;
    },
    sent: {
      /** Read without retiring the bubble; the transcript settles it after applying the turn start. @param {string} chatId @param {string} [key] @returns {string | undefined} */
      take(chatId, key) {
        const log = sentLog.get(chatId) ?? [];
        return ((key ? log.find((m) => m.key === key) : undefined) ?? log[0])?.text;
      },
      /** The attachments of a message this Mac sent and the transcript does not have yet. @param {string} chatId @param {string} [key] @returns {any[] | undefined} */
      attached(chatId, key) {
        return key ? (sentLog.get(chatId) ?? []).find((m) => m.key === key)?.item.attachments : undefined;
      },
      /** The turn the Host took steered messages into has ended: they leave the queue. @param {string} chatId */
      settleSteered(chatId) {
        const log = sentLog.get(chatId) ?? [];
        const done = log.filter((m) => steeredKeys.has(m.key));
        if (!done.length) return;
        for (const m of done) {
          outbox.ack(chatId, [m.key]);
          steeredKeys.delete(m.key);
        }
        sentLog.set(
          chatId,
          log.filter((m) => !done.includes(m)),
        );
        project(chatId);
      },
      /** @param {string} chatId @param {string | undefined} text @param {string} [key] */
      seen(chatId, text, key) {
        const log = sentLog.get(chatId);
        const exact = key ? (log?.findIndex((m) => m.key === key) ?? -1) : -1;
        const at = exact >= 0 ? exact : text === undefined ? -1 : (log?.findIndex((m) => m.text === text) ?? -1);
        if (!log || at < 0) return;
        outbox.ack(chatId, [log[at].key]);
        accepted?.(chatId);
        sentLog.set(
          chatId,
          log.filter((_, i) => i !== at),
        );
        project(chatId);
      },
    },
  };
}
module.exports = { createSendProjection };
