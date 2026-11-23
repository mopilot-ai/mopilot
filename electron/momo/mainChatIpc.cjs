// MoMo's main chat over IPC (#2139): make sure it exists, read and change its brain, list the earlier ones; each call is refused while MoMo isn't
// allowed for the account. Registered with main's startup (not from electron/app/ipc/), once MoMo's service is made.
const { notAllowed } = require('./mainChat.cjs');

/** Told to every window when MoMo's brain changed (its chip reads it again). */
const BRAIN_CHANGED = 'momoChat:brainChanged';
/** The service's `brainChanged`, sent to every window. */
const brainChangedTo = (/** @type {(channel: string, payload: unknown) => void} */ broadcastAll) => (/** @type {unknown} */ brain) =>
  broadcastAll(BRAIN_CHANGED, brain);

/**
 * @param {{ handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void }} ipcMain
 * @param {object} o
 * @param {ReturnType<typeof import('./mainChat.cjs').createMomoMainChat>} o.service
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => { list: () => Promise<unknown>, watch: (key: number, on: boolean) => void } | undefined} [o.activity] MoMo's activity (made with its routines, after this IPC)
 */
function registerMomoMainChatIpc(ipcMain, { service, allowed, activity }) {
  // errors come back as values, so the window sees the message and its code (the preload's call() rethrows them)
  // (`withEvent`: the call's event comes first, for a handler that needs the window it came from)
  const handle = (/** @type {string} */ channel, /** @type {(...args: any[]) => unknown} */ fn, withEvent = false) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!allowed()) throw notAllowed();
        return { value: await fn(...(withEvent ? [event, ...args] : args)) };
      } catch (err) {
        return { error: { message: String(err?.message ?? err), code: err?.code ?? null } };
      }
    });
  handle('momoChat:mainChat', () => service.ensureMainChat());
  handle('momoChat:brain:get', () => service.getBrain());
  handle('momoChat:brain:set', (brain) => service.setBrain(brain));
  handle('momoChat:previous', () => service.previousChats());
  handle('momoChat:model:set', (chatId, model, label) => service.setChatModel(chatId, model, label));
  // MoMo's activity for the right panel: the list a phone reads, and a window saying it shows (or no longer shows) it
  handle('momoChat:activity:list', () => activity?.()?.list() ?? { items: [] });
  handle(
    'momoChat:activity:watch',
    (/** @type {any} */ event, /** @type {unknown} */ on) => {
      const sender = event?.sender;
      const key = sender?.id ?? 0;
      activity?.()?.watch(key, on === true);
      // a window that goes away stops watching with it
      if (on === true) sender?.once?.('destroyed', () => activity?.()?.watch(key, false));
      return true;
    },
    true,
  );
}

module.exports = { registerMomoMainChatIpc, brainChangedTo, BRAIN_CHANGED };
