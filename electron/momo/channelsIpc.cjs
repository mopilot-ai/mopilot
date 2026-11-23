// IPC for MoMo's channels and groups (A2): the list, a channel's chat (made on the first open), create (name only), rename, archive, delete, move into a group, reorder (Mac only), its instructions, the answer to its first row, Everything's rows and the group calls. Each is refused while MoMo is not allowed for the account, as the memory handlers are, and (but the list, which then says `enabled: false`) while `momo.channels` is off. Every answer is `{ ok: true, ... }` or `{ ok: false, reason, error }`; a change is told to the windows as momoChannels:changed.
const { messageOf } = require('../ignored.cjs');
/** The refusal the memory handlers give (memoryIpc.cjs NOT_ALLOWED, held equal by tests/momoTasks.test.ts), repeated so this module imports nothing that writes to disk. */
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
const OFF = Object.freeze({ ok: false, reason: 'unavailable', error: 'Channels are off.' });

const CHANNELS = Object.freeze([
  'momoChannels:list',
  'momoChannels:chat',
  'momoChannels:create',
  'momoChannels:rename',
  'momoChannels:archive',
  'momoChannels:restore',
  'momoChannels:delete',
  'momoChannels:move',
  'momoChannels:reorder',
  'momoChannels:instructions:get',
  'momoChannels:instructions:set',
  'momoChannels:welcome',
  'momoChannels:everything',
  'momoChannels:group:create',
  'momoChannels:group:rename',
  'momoChannels:group:delete',
  'momoChannels:group:restore',
]);

/** A refusal as the answer: the codes the registry and the chat service give pass on, anything else is `failed`. */
function refusal(/** @type {any} */ error) {
  const code = error?.code;
  const reason = ['bad_args', 'duplicate', 'cap', 'gone', 'unavailable', 'resetting', 'not_allowed', 'no_harness'].includes(code)
    ? code
    : 'failed';
  return { ok: false, reason, error: messageOf(error) };
}

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ channels: ReturnType<typeof import('./channels.cjs').createChannels>, chats: { ensure: (id: unknown) => Promise<object>, archive: (id: unknown) => Promise<object>, restore: (id: unknown) => Promise<object>, remove: (id: unknown) => Promise<object> },
 *   everything: ReturnType<typeof import('./everything.cjs').createEverything>,
 *   allowed: () => boolean, enabled: () => boolean, broadcast?: ((channel: string) => void) | null }} o
 * @returns {() => void} removes the handlers
 */
function registerChannelsIpc(ipcMain, { channels, chats, everything, allowed, enabled, broadcast = null }) {
  /** @param {string} channel @param {(...args: any[]) => unknown} fn @param {boolean} [changes] it changes the registry: windows are told */
  const handle = (channel, fn, changes = false) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      if (enabled() !== true)
        return channel === 'momoChannels:list' ? { ok: true, enabled: false, channels: [], groups: [], room: 0 } : OFF;
      try {
        const out = /** @type {object} */ (await fn(...args));
        if (changes) broadcast?.('momoChannels:changed');
        return { ok: true, ...out };
      } catch (error) {
        return refusal(error);
      }
    });
  handle('momoChannels:list', () => ({ enabled: true, ...channels.list() }));
  // a channel's chat is made on the first open: windows hear of the chat itself (chats:changed), not of a channel change
  handle('momoChannels:chat', (id) => chats.ensure(id));
  handle('momoChannels:create', async (name, group) => ({ channel: await channels.create(name, group) }), true);
  handle('momoChannels:rename', async (id, name) => ({ channel: await channels.rename(id, name) }), true);
  handle('momoChannels:archive', (id) => chats.archive(id), true);
  handle('momoChannels:restore', (id) => chats.restore(id), true);
  handle('momoChannels:delete', (id) => chats.remove(id), true);
  handle('momoChannels:move', async (id, group) => ({ channel: await channels.move(id, group) }), true);
  handle('momoChannels:reorder', async (id, dir) => ({ channel: await channels.reorder(id, dir) }), true);
  handle('momoChannels:instructions:get', (id) => {
    if (!channels.get(id)) throw Object.assign(new Error('That channel isn’t there any more.'), { code: 'gone' });
    return { text: channels.instructionsOf(id) };
  });
  handle('momoChannels:instructions:set', async (id, text) => ({ channel: await channels.setInstructions(id, text) }), true);
  // Everything: the latest finished exchanges of Main and the channels, by time (everything.cjs); only one channel's with an id (or 'main')
  handle('momoChannels:everything', (only) => everything.list(only));
  handle('momoChannels:welcome', async (id, answer) => ({ channel: await channels.answerWelcome(id, answer) }), true);
  handle('momoChannels:group:create', async (name) => ({ group: await channels.createGroup(name) }), true);
  handle('momoChannels:group:rename', async (id, name) => ({ group: await channels.renameGroup(id, name) }), true);
  handle('momoChannels:group:delete', async (id) => ({ removed: await channels.removeGroup(id) }), true);
  handle('momoChannels:group:restore', async (group, channelIds) => ({ group: await channels.restoreGroup(group, channelIds) }), true);
  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerChannelsIpc, CHANNELS, NOT_ALLOWED, OFF };
