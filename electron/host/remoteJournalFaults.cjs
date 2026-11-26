// Host storage failures become a visible failed turn/session error, scoped to the followed chat rather than silently freezing its last live text; a stream the Host or the connection ended is read again, and said when it cannot be (#5404).
const { later } = require('./catchUpRetries.cjs');

/** The waits before the chat is read again after its stream ended, then the chat is told it is cut off. */
const RESUME_MS = [1000, 4000, 15000];
/** What a Host call fails with when its machine is away or its connection was let go: not a failure of the chat. */
const AWAY = new Set(['host_unreachable', 'disposed']);
const MESSAGES = {
  session_journal_budget:
    'This machine reached its saved-chat storage budget. Delete saved chats on that machine, then retry. Existing history is preserved.',
  session_journal_busy: 'This machine has too many active or pending chats. Close active chats or delete unused chats, then retry.',
  session_journal_deleted: 'This chat was deleted from the machine.',
  stream_lost: 'Lost contact with this chat on its machine, so its latest reply may not show. Reopen the chat to read it again.',
};
const MESSAGE = 'This machine could not save the chat. Check its disk space and permissions, then retry.';
/** @param {{ emit: (event: object) => void, state: () => any, report: (error: Error) => void }} o `report` is told of a read that failed: it is not the chat's own error to show, but it is not silent either. */
function createRemoteJournalFaults({ emit, state, report }) {
  const active = new WeakMap();
  /** The chats being read again, so a failure of that read does not start another round. */
  const resuming = new WeakSet();
  return {
    observe(f, event) {
      if (event.kind === 'turnStart') active.set(f, event.turnId);
      if (event.kind === 'turnEnd') active.delete(f);
    },
    show(f, code) {
      if (f.gone || typeof code !== 'string' || !(code.startsWith('session_journal_') || code === 'stream_lost')) return;
      f.shown.clear();
      const message =
        code === 'session_journal_full'
          ? 'This chat reached its saved history limit on the machine. Its history is still available; start a new chat to continue.'
          : (MESSAGES[code] ?? MESSAGE);
      const turnId = active.get(f);
      active.delete(f);
      if (turnId) emit({ kind: 'turnEnd', key: f.chatId, turnId, stopReason: 'error', error: message, errorCode: code });
      const store = state();
      if (store?.has?.(f.chatId)) store.patch(f.chatId, { error: message, turn: 'idle' });
    },
    /** The work on a followed chat failed with `error`: a storage fault is said, any other failure (a refused read, a record that could not be written) is read again from where the chat stands. @param {any} f @param {any} error @param {() => Promise<unknown>} resync */
    failed(f, error, resync) {
      this.show(f, error?.code);
      if (!AWAY.has(error?.code) && !String(error?.code).startsWith('session_journal_')) this.resume(f, resync);
    },
    /** The Host ended this chat's stream, or a read of it failed (a frame too large, a catch-up it refused): the chat is subscribed again from where it stands, a few times, then said to be cut off. @param {any} f @param {() => Promise<unknown>} resync @param {number} [tried] */
    resume(f, resync, tried = 0) {
      if (tried === 0 && resuming.has(f)) return;
      resuming.add(f);
      if (tried >= RESUME_MS.length) return void (resuming.delete(f), this.show(f, 'stream_lost'));
      later(() => {
        // a machine that is away is read again when it returns (the chat's own follow), not counted here
        if (f.gone || f.host.state?.() !== 'online') return void resuming.delete(f);
        f.synced = false;
        void resync()
          .catch((/** @type {Error} */ error) => report(error))
          .then(() => (f.synced ? void resuming.delete(f) : this.resume(f, resync, tried + 1)));
      }, RESUME_MS[tried]);
    },
    /** @param {any} host @param {(chatId: string) => any} mine @param {(f: any, work: () => unknown) => unknown} run @param {(f: any) => Promise<unknown>} resync @param {(f: any) => void} retire */
    attach(host, mine, run, resync, retire) {
      // Older Hosts/test transports have no close channel.
      return (
        host.events.onClosed?.(({ chatId, reason }) => {
          const f = mine(chatId);
          if (!f) return;
          retire(f);
          if (typeof reason === 'string' && reason.startsWith('session_journal_')) void run(f, () => this.show(f, reason));
          else this.resume(f, () => resync(f));
        }) ?? (() => undefined)
      );
    },
  };
}
module.exports = { createRemoteJournalFaults };
