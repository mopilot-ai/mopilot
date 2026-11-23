// A Codex hook run that failed, was blocked or cancelled, kept as a chat note so its line survives a reload (#2066).
// thread/read carries no hook runs, and a run before the first turn (SessionStart, turnId null) has no turn to show in.
const { codexHookItem } = require('../../shared/hookRuns.mjs');

/**
 * Watches the app-server's messages in main, so a chat no window has open keeps its hook lines too. A run with a turn
 * notes it under that turn. One with none (SessionStart) leads the thread's running turn, or, between turns, shows
 * under the chat's latest turn until the thread's next turn starts and takes it as its first line.
 */
class HookNotes {
  /**
   * @param {{ chats: { record(id: string): any, patchMeta(id: string, patch: object): boolean },
   *   chatOf(threadId: string): string, changed(chatId: string): void, now?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    /** @type {Map<string, Set<string>>} per thread, the turnless notes its next turn takes */
    this.waiting = new Map();
    /** @type {Map<string, string>} per thread, the turn running now */
    this.running = new Map();
  }

  /** @param {{ method?: string, params?: any }} msg an app-server notification */
  observe(msg) {
    const p = msg?.params ?? {};
    if (msg?.method === 'hook/completed') this.noteRun(p);
    else if (msg?.method === 'turn/started' && p.threadId && p.turn?.id) {
      this.running.set(p.threadId, p.turn.id);
      this.adopt(p.threadId, p.turn.id);
    } else if (msg?.method === 'turn/completed' && p.threadId && this.running.get(p.threadId) === p.turn?.id)
      this.running.delete(p.threadId);
  }

  /** The chat a thread belongs to, when it is a chat this app keeps: chatOf answers an unknown key with itself. */
  chatFor(threadId) {
    const chatId = this.o.chatOf(threadId);
    return chatId && this.o.chats.record(chatId) ? chatId : null;
  }

  noteRun(p) {
    const item = codexHookItem(p.run);
    const chatId = item && p.threadId ? this.chatFor(p.threadId) : null;
    if (!item || !chatId) return;
    const notes = this.o.chats.record(chatId).meta?.notes ?? [];
    // a run reported twice (a reconnect replays it) keeps one line
    if (notes.some((n) => n.id === item.id)) return;
    const own = p.turnId ?? null;
    const turnId = own ?? this.running.get(p.threadId) ?? null;
    const note = {
      id: item.id,
      kind: 'hook',
      text: item.fragments[0].text,
      turnId,
      // no turn yet: the chat's latest turn shows it until the next one takes it (shared/chatNotes.mjs)
      turn: Number.MAX_SAFE_INTEGER,
      at: this.now(),
      ...(own ? {} : { lead: true }),
    };
    // patchMeta-changes: the hook note is new, so the notes always change
    if (!this.o.chats.patchMeta(chatId, { notes: [...notes, note] })) return;
    if (!turnId) {
      const ids = this.waiting.get(p.threadId) ?? new Set();
      this.waiting.set(p.threadId, ids.add(note.id));
    }
    this.o.changed(chatId);
  }

  adopt(threadId, turnId) {
    const ids = this.waiting.get(threadId);
    if (!ids) return;
    this.waiting.delete(threadId);
    const chatId = this.chatFor(threadId);
    if (!chatId) return;
    const notes = this.o.chats.record(chatId).meta?.notes ?? [];
    // re-read after the turn started: only notes still waiting (none taken or removed meanwhile) move
    if (!notes.some((n) => ids.has(n.id) && n.turnId === null)) return;
    const next = notes.map((n) => (ids.has(n.id) && n.turnId === null ? { ...n, turnId } : n));
    if (this.o.chats.patchMeta(chatId, { notes: next })) this.o.changed(chatId);
  }
}

module.exports = { HookNotes };
