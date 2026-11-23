// IPC for MoMo's suggestions (A7): momoSuggestions:list reads the live ones (suggestions.cjs, best first, with the score inputs), momoSuggestions:act takes the user's Add, Start or Hide; both are refused while MoMo is not allowed, and unavailable while `prefs.momo.suggestions` is off, whatever the Tasks panel is. A change is told to the windows as momoSuggestions:changed. Start sends the suggestion's first step to MoMo in its channel as the user's own message through `start`, which the app wires to the chat's normal send; nothing else here starts anything.
const { messageOf } = require('../ignored.cjs');
/** The refusal the memory handlers give (memoryIpc.cjs NOT_ALLOWED), repeated so this module imports nothing that writes to disk. */
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'unavailable', error: 'Suggestions are off' });

const CHANNELS = Object.freeze(['momoSuggestions:list', 'momoSuggestions:act']);

/** The message Start sends: the first step, labelled as the suggestion's, so a step written from outside text never reads as the user's own request. */
const startText = (/** @type {{ title: string, step: string, source: string }} */ s) =>
  `Start: ${s.title}\nFirst step: ${s.step}\n(From your suggestion, ${s.source})`;

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ store: ReturnType<typeof import('./suggestions.cjs').createSuggestions>, allowed: () => boolean, enabled: () => boolean,
 *   start: (s: import('./suggestions.cjs').Suggestion, text: string) => Promise<unknown>, broadcast?: ((channel: string) => void) | null,
 *   now?: () => number }} o
 *   start: sends `text` to MoMo's chat for the suggestion's channel as the user's message (rejects when it cannot)
 * @returns {() => void} removes the handlers
 */
function registerSuggestionsIpc(ipcMain, { store, allowed, enabled, start, broadcast = null, now = Date.now }) {
  ipcMain.handle('momoSuggestions:list', async () => {
    if (allowed() !== true) return NOT_ALLOWED;
    if (enabled() !== true) return UNAVAILABLE;
    try {
      return { ok: true, v: 1, ...store.list(), now: now() };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });
  ipcMain.handle('momoSuggestions:act', async (_e, id, action) => {
    if (allowed() !== true) return NOT_ALLOWED;
    if (enabled() !== true) return UNAVAILABLE;
    try {
      const done = await store.act(id, action, (s) => start(s, startText(s)));
      broadcast?.('momoSuggestions:changed');
      return { ok: true, id: done.id, action: done.action, channel: done.item.channel };
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      return { ok: false, error: messageOf(error), ...(code === 'gone' ? { reason: 'gone' } : {}) };
    }
  });
  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerSuggestionsIpc, startText, CHANNELS, NOT_ALLOWED, UNAVAILABLE };
