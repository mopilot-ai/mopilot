// IPC for MoMo's Memory tab (#2139, src/components/momo/MemoryTab.tsx): list and search the facts, edit or delete one, and read or write About you and MoMo's persona; every change, the agent's included, goes to the windows as momoMemory:changed (no data in it). Every handler refuses while MoMo is not allowed, so an account that was not invited reads and changes nothing, and is told of no change.
const { messageOf } = require('../ignored.cjs');
const { FILES } = require('./memory.cjs');
const { MemoryError } = require('./memoryFacts.cjs');

const CHANNELS = Object.freeze([
  'momoMemory:list',
  'momoMemory:add',
  'momoMemory:update',
  'momoMemory:forget',
  'momoMemory:files',
  'momoMemory:writeFile',
  'momoMemory:changes',
  'momoMemory:undo',
  'momoMemory:past',
  'momoMemory:background',
]);
/** The most recent changes and past facts the tab shows. */
const SHOWN = 30;
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ store: InstanceType<typeof import('./memory.cjs').MemoryStore>, allowed: () => boolean,
 *           broadcast?: ((channel: string) => void) | null, background?: () => object | null }} o broadcast: to every
 *   window; background: the day's background token cap and each kind's share and use (backgroundBudget.cjs usage), null before it runs
 */
function registerMemoryIpc(ipcMain, { store, allowed, broadcast = null, background = () => null }) {
  const changed = () => {
    if (allowed() === true) broadcast?.('momoMemory:changed');
  };
  store.on('changed', changed);
  /** A handler that answers NOT_ALLOWED while MoMo is not allowed, and a failure as `{ ok: false, error }`. */
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      try {
        return { ok: true, ...(await fn(...args)) };
      } catch (error) {
        // no encryption on this Mac: the tab says memory is off, not that one call failed
        const unavailable = error instanceof MemoryError && error.code === 'unavailable';
        return { ok: false, error: messageOf(error), ...(unavailable ? { reason: 'unavailable' } : {}) };
      }
    });
  const id = (/** @type {unknown} */ v) => {
    if (typeof v !== 'string' || !v) throw new Error('A fact id is needed');
    return v;
  };
  on('momoMemory:list', (q) => {
    const query = q && typeof q === 'object' && typeof q.query === 'string' ? q.query.trim() : '';
    const { facts, unreadable } = store.list({ includeExpired: true });
    // a search leaves out expired facts, as the agent's does; the whole list shows them, so they can be deleted
    return { facts: query ? store.search(query, { limit: 50 }) : facts, unreadable, now: Date.now() };
  });
  // a fact the user typed: theirs, so sure
  on('momoMemory:add', async (text) => store.save({ text, source: 'user', confidence: 'sure' }));
  on('momoMemory:update', async (factId, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    // an expired fact the user corrects may be brought back (expiresAt: null), never given a new expiry here; text the
    // user wrote is theirs, so sure
    const fact = await store.update(id(factId), {
      text: p.text,
      confidence: p.text !== undefined ? 'sure' : p.confidence,
      ...(p.expiresAt === null ? { expiresAt: null } : {}),
    });
    if (!fact) throw new Error('That fact is no longer in memory');
    return { fact };
  });
  on('momoMemory:forget', async (factId) => {
    if (!(await store.forget(id(factId)))) throw new Error('That fact is no longer in memory');
    return {};
  });
  // a document that can't be decrypted reads as empty and is named, so the tab says so before it is replaced
  on('momoMemory:files', () => {
    /** @type {string[]} */
    const unreadable = [];
    const read = (/** @type {keyof typeof FILES} */ name) => {
      try {
        return store.readFile(name);
      } catch (error) {
        if (!(error instanceof MemoryError) || error.code !== 'unreadable') throw error;
        unreadable.push(name);
        return '';
      }
    };
    return { aboutYou: read('aboutYou'), persona: read('persona'), unreadable };
  });
  on('momoMemory:writeFile', async (name, text) => {
    if (!Object.hasOwn(FILES, name)) throw new Error(`No such memory file: ${name}`);
    await store.writeFile(name, text);
    return {};
  });
  // the newest changes first; each says whether Undo can still take it back
  on('momoMemory:changes', () => ({
    changes: store
      .changes()
      .slice(0, SHOWN)
      .map((c) => ({ ...c, undoable: c.op !== 'undo' && c.undone === undefined })),
  }));
  // the store says why it refuses (a fact changed since, undone already, no longer in the log)
  on('momoMemory:undo', async (changeId) => {
    if (typeof changeId !== 'string' || !changeId) throw new Error('A change id is needed');
    return { change: await store.undo(changeId) };
  });
  // facts a newer one replaced, the latest replaced first
  on('momoMemory:past', () => ({
    facts: store
      .list({ includeExpired: true, includePast: true })
      .facts.filter((f) => f.invalidAt !== undefined)
      .sort((a, b) => Number(b.invalidAt) - Number(a.invalidAt))
      .slice(0, SHOWN),
  }));
  on('momoMemory:background', () => ({ limits: background() }));
  return () => {
    store.off('changed', changed);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerMemoryIpc, CHANNELS, NOT_ALLOWED, SHOWN };
