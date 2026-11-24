// The protocol's finished chat items and session stream, persistent when served from a Host data directory and in-memory for legacy embedders.
import { prefixUnits } from '../../shared/textPrefix.mjs';
import { lostCalls } from './callIntents.mjs';
import { createStreamHub } from './stream.mjs';
import { createJournalItems } from './journalItems.mjs';
import { createSessionJournal } from './sessionJournal.mjs';
import { createChatIndex } from './chatIndex.mjs';

/** @param {{ dataDir?: string, epoch: (chatId: string) => number, live?: (chatId: string) => Record<string, unknown>, report?: (message: string) => void }} o */
export function createChatLog({ dataDir, epoch, live, report }) {
  const storage = dataDir ? createSessionJournal({ dataDir, active: (chatId) => hub.active(chatId) }) : undefined;
  /** @type {Map<string, {rev: number, items: object[]}>} */
  const states = new Map();
  const snapshot = (chatId) => {
    if (storage) {
      const saved = storage.read(chatId);
      return {
        rev: saved.rev,
        items: saved.frames.map((f) => f.item),
        ...(saved.storageError ? { storageError: saved.storageError } : {}),
      };
    }
    return states.get(chatId) ?? { rev: 0, items: [] };
  };
  const indexes = new Map();
  const index = (chatId) => {
    if (!indexes.has(chatId)) indexes.set(chatId, createJournalItems());
    return indexes.get(chatId);
  };
  /** The summaries of the chats this Host holds, kept current from what its stream sees (`host.chats`, its events). */
  const chatIndex = createChatIndex({ load: async () => storage?.chats() ?? [], epoch, report });
  const hub = createStreamHub({ snapshot, epoch, storage, live, observe: chatIndex.observe });
  return {
    hub,
    index: chatIndex,
    history(p) {
      if (!storage) throw Object.assign(new Error('This Host cannot read saved history.'), { code: 'unsupported' });
      return storage.history(p);
    },
    deleted: (chatId) => storage?.deleted(chatId) ?? false,
    /** The chats this Host holds (`host.chats`): none for an embedder with no data directory. */
    chats: async () => storage?.chats() ?? [],
    /** The title of a chat that has only a stand-in summary (`host.chats`). @param {string} chatId @param {number} [budget] */
    fillTitle: (chatId, budget) => storage?.fillTitle(chatId, budget) ?? { status: /** @type {const} */ ('deferred') },
    remove(chatId) {
      storage?.remove(chatId);
      states.delete(chatId);
      indexes.delete(chatId);
      hub.remove(chatId);
      chatIndex.observe(chatId, { t: 'removed' });
    },
    /**
     * The turn's tool calls that had started and not ended, oldest first. One a restart already closed (`settled`) is still one it cut off.
     * @param {string} chatId @param {string} turnId @returns {{ id: string, title: string, settled: boolean }[]}
     */
    open(chatId, turnId) {
      /** @type {Map<string, { title: string, settled: boolean }>} */
      const calls = new Map();
      for (const item of snapshot(chatId).items) {
        const event = /** @type {any} */ (item).event;
        const update = event?.kind === 'update' && event.turnId === turnId ? event.update : null;
        if (typeof update?.toolCallId !== 'string' || !/^tool_call(_update)?$/.test(String(update.sessionUpdate))) continue;
        const title = prefixUnits(String(update.title ?? calls.get(update.toolCallId)?.title ?? 'a tool call'), 200);
        const settled = update._meta?.mopilot?.settled === 'host_restart';
        if ((update.status === 'completed' || update.status === 'failed') && !settled) calls.delete(update.toolCallId);
        else calls.set(update.toolCallId, { title, settled });
      }
      return [...calls].map(([id, call]) => ({ id, ...call }));
    },
    /** The chat's durable items so far, oldest first. @param {string} chatId */
    items: (chatId) => snapshot(chatId).items,
    /** The newest durable items, with the total before the cut. */
    recentItems(chatId, limit) {
      if (storage) return storage.recentItems(chatId, limit);
      const { items } = snapshot(chatId);
      return { items: items.slice(-limit), total: items.length };
    },
    /** The acting calls the last Host sent in the turn and never heard back from (./callIntents.mjs). @param {string} chatId @param {string} turnId */
    lost: (chatId, turnId) => (dataDir ? lostCalls(dataDir, chatId, turnId) : []),
    terminal(chatId, turnId) {
      return storage ? storage.turn(chatId, turnId) : index(chatId).turn(turnId);
    },
    /**
     * Whether a turn event repeats one the journal has: a start for a turn that is open or already ended, or an end of a turn that is not open. Told again it opens or ends nothing, so each turn id is started once and its end is the last of it.
     * @param {string | undefined} chatId @param {{ kind: string, turnId?: string }} e @param {{ has: (turnId: string) => boolean }} open the turns the stream has been told started and not ended
     */
    repeats(chatId, e, open) {
      if (typeof chatId !== 'string' || typeof e.turnId !== 'string') return false;
      // a turn the journal has never seen has no record to read
      if (e.kind === 'turnStart') return open.has(e.turnId) || !!this.terminal(chatId, e.turnId)?.end;
      // an end of a turn the stream has not been told started (it came first, or the turn already ended) ends nothing
      return e.kind === 'turnEnd' && !open.has(e.turnId);
    },
    /** Refuse before dispatch; no model/tool action has happened, so retrying is safe. @param {string} chatId */
    check(chatId, text = '') {
      try {
        storage?.check(chatId, text ? Buffer.byteLength(JSON.stringify({ text })) + 1024 : 0);
      } catch (error) {
        if (['session_journal_full', 'session_journal_budget', 'session_journal_busy', 'session_journal_deleted'].includes(error?.code))
          throw error;
        throw Object.assign(new Error('This machine cannot save this chat. Check its disk space and permissions, then retry.'), {
          code: 'session_storage_unavailable',
        });
      }
    },
    /** Commit the durable item before it can be observed on the stream. @param {string} chatId @param {object} item @param {string} [promotes] */
    finish(chatId, item, promotes) {
      if (storage ? storage.seen(chatId, item) : index(chatId).seen(item)) return;
      const s = storage ? storage.head(chatId) : snapshot(chatId);
      const rev = s.rev + 1;
      if (!storage) states.set(chatId, { rev, items: [...snapshot(chatId).items, item].slice(-2000) });
      hub.durable(chatId, { rev, item, promotes });
      if (!storage) index(chatId).add({ item, rev });
    },
  };
}

/** The finished reply summary kept alongside the adapter's durable events. */
export function assistantItem(turn, event) {
  return {
    t: 'assistant',
    turnId: event.turnId,
    text: turn.text,
    stopReason: event.stopReason ?? null,
    error: event.error ? String(event.error.message ?? event.error) : null,
  };
}

/** What the journal and the call records say, for the notice only: one that cannot be read must not keep the turn from being ended. */
function known(read, ...args) {
  try {
    return read(...args);
  } catch {
    return [];
  }
}

/** Adopt an already persisted terminal before synthesizing interruption; a missing summary is completed independently. */
export function recoverTurn({ terminal, finish, open, lost }, chatId, turnId, record, reason) {
  const saved = terminal(chatId, turnId);
  let end = saved?.end;
  if (!end) {
    const cut = known(open, chatId, turnId);
    const unanswered = known(lost, chatId, turnId);
    // a card left running would run forever for every client: each is settled as failed before the turn ends, marked as the restart's doing
    for (const call of cut.filter((c) => !c.settled))
      record(chatId, {
        kind: 'update',
        turnId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: call.id,
          status: 'failed',
          _meta: { mopilot: { settled: 'host_restart' } },
        },
      });
    // the end a restart writes says so and names what was cut off, so the app can offer to carry on (a person's Stop has no such field);
    // `lost` are the acting calls that were sent and never answered: they may or may not have happened, and nothing sends them again
    end = {
      kind: 'turnEnd',
      turnId,
      stopReason: 'cancelled',
      error: { message: reason },
      interrupted: {
        by: 'host_restart',
        running: cut.slice(0, 5).map((call) => call.title),
        ...(unanswered.length ? { lost: unanswered } : {}),
      },
    };
    record(chatId, end);
  }
  if (!saved?.assistant) finish(chatId, assistantItem({ text: saved?.text ?? '' }, end));
}
