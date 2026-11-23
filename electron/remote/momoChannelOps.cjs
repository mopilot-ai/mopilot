// What a paired phone may do with MoMo's channels and groups (A2; electron/remote/methods/momo.cjs, momoChannels.cjs): list, create (name only), rename, archive, delete, move into a group, the answer to a channel's first row, the group calls, and the chat a request names with an optional `channelId`. The registry calls go through the handlers the Mac's windows use (momoChannels:*, tapped from the IPC registration), so a phone's change is gated, written and broadcast exactly as a window's; the chat of a channel comes from the channel service, which refuses an unknown or archived id. The phone never names a chat: an id it sends is a channel's, validated against the list.
const { RemoteError } = require('./serviceErrors.cjs');
const { userError } = require('../../shared/userError.mjs');

/** A refusal the handlers gave as a value, as the phone sees it: its own words, a code it can branch on. */
function refusal(/** @type {any} */ res) {
  const reason = res?.reason;
  const message = String(res?.error || 'MoMo could not do that.');
  if (reason === 'not_allowed' || reason === 'unavailable') return new RemoteError('forbidden', message);
  if (reason === 'gone') return new RemoteError('gone', message);
  if (reason === 'bad_args' || reason === 'duplicate' || reason === 'cap') return new RemoteError('invalid', message);
  return new RemoteError('failed', message);
}

/** The value of a handler that answers `{ ok: true, ... }` or `{ ok: false, reason, error }`. */
function okOf(/** @type {any} */ res) {
  if (!res?.ok) throw refusal(res);
  const { ok: _ok, ...rest } = res;
  return rest;
}

/** An error the channel service threw, as the phone sees it. */
function thrown(/** @type {any} */ error) {
  return refusal({ reason: error?.code, error: userError(error) });
}

/**
 * @param {{ call: (channel: string, ...args: any[]) => any, chats: { ensure: (id: unknown) => Promise<{ chatId: string }>, chatIdOf: (id: unknown) => string | null } | null,
 *   registry: { get: (id: unknown) => unknown, byChatId: (chatId: unknown) => unknown, list: () => { channels: { id: string }[] }, chatIdOf: (id: string) => string | null } | null, enabled: () => boolean, allowed: () => boolean }} o
 */
function createChannelRemote({ call, chats, registry, enabled, allowed }) {
  const on = () => allowed() === true && enabled() === true && !!chats && !!registry;
  return {
    /** The chats of the open channels that have one (none while channels are off): where a card raised in a channel waits. */
    chatIds() {
      if (!on()) return [];
      const reg = /** @type {NonNullable<typeof registry>} */ (registry);
      return reg
        .list()
        .channels.map((c) => reg.chatIdOf(c.id))
        .filter((id) => id !== null);
    },
    /** Whether `chatId` is a channel's journal a phone may talk to (never an archived one's). */
    isChannelChat: (/** @type {string} */ chatId) => on() && !!registry?.byChatId(chatId),
    /**
     * The journal a request with a `channelId` reaches, made on its first use when `make`; refused for an unknown or archived channel, or with channels off.
     * @param {string} channelId @param {boolean} make @returns {Promise<string | null>} null: it has no chat yet (only when not `make`)
     */
    async chatId(channelId, make) {
      if (!on()) throw new RemoteError('forbidden', 'Channels are off.');
      try {
        if (make) return (await /** @type {any} */ (chats).ensure(channelId)).chatId;
        return /** @type {any} */ (chats).chatIdOf(channelId);
      } catch (error) {
        throw thrown(error);
      }
    },
    /** A channel a voice note may be for: refused when unknown or archived. */
    assertChannel(/** @type {string} */ channelId) {
      if (!on()) throw new RemoteError('forbidden', 'Channels are off.');
      if (!registry?.get(channelId)) throw new RemoteError('gone', 'That channel isn’t there any more.');
    },
    list: async () => okOf(await call('momoChannels:list')),
    create: async (/** @type {string} */ name, /** @type {string | null} */ group) => okOf(await call('momoChannels:create', name, group)),
    rename: async (/** @type {string} */ id, /** @type {string} */ name) => okOf(await call('momoChannels:rename', id, name)),
    archive: async (/** @type {string} */ id) => okOf(await call('momoChannels:archive', id)),
    remove: async (/** @type {string} */ id) => okOf(await call('momoChannels:delete', id)),
    move: async (/** @type {string} */ id, /** @type {string | null} */ group) => okOf(await call('momoChannels:move', id, group)),
    welcome: async (/** @type {string} */ id, /** @type {string} */ answer) => okOf(await call('momoChannels:welcome', id, answer)),
    group: {
      create: async (/** @type {string} */ name) => okOf(await call('momoChannels:group:create', name)),
      rename: async (/** @type {string} */ id, /** @type {string} */ name) => okOf(await call('momoChannels:group:rename', id, name)),
      remove: async (/** @type {string} */ id) => okOf(await call('momoChannels:group:delete', id)),
    },
  };
}

module.exports = { createChannelRemote, refusal, okOf };
