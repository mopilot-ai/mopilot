// DEV ONLY: MoMo's channels and groups (A2) as the dev host's fake Mac answers them: the Mac's own registry (electron/momo/channels.cjs, over its in-memory storage seam) and its own refusals (electron/remote/momoChannelOps.cjs), over fake chats that make a reply when a message arrives. A channel's chat is made on its first follow or send and hidden from the chat list, as the Mac's is; archived channels keep theirs, deleted ones lose it. `enabled` says whether the Mac has the flag on (the `momo-channels` scenario), and `seed` gives the bench a few channels and a group to look at.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChannels, memoryStorage } = require('../../electron/momo/channels.cjs');
const { refusal } = require('../../electron/remote/momoChannelOps.cjs');
const { RemoteError } = require('../../electron/remote/serviceErrors.cjs');

const OFF = 'Channels are off.';
const GONE = 'That channel isn’t there any more.';

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./fakeApp.mjs').createFakeApp>} o.app
 * @param {() => boolean} o.enabled the Mac has `momo.channels` on
 * @param {(area: 'channels') => void} o.changed tells the phones the list changed
 * @param {() => number} [o.now]
 */
export function createFakeChannels({ app, enabled, changed, now = Date.now }) {
  let n = 0;
  const registry = createChannels({
    storage: memoryStorage(),
    now,
    newId: () => (++n).toString(16).padStart(16, '0'),
  });
  /** A refusal of the registry as the Mac gives it to a phone. */
  const mapped = (/** @type {any} */ error) => refusal({ reason: error.code, error: error.message });
  const on = () => {
    if (!enabled()) throw new RemoteError('forbidden', OFF);
  };
  /** Runs a registry change as the Mac's handler does: refused while off, refusals worded, the phones told. */
  const change = async (/** @type {() => Promise<unknown>} */ run) => {
    on();
    try {
      const out = await run();
      changed('channels');
      return out;
    } catch (error) {
      throw mapped(error);
    }
  };
  const chatOf = (/** @type {string} */ id) => `dev-momo-channel-${id.slice(3)}`;
  /** The channel's chat, made when asked for and not there. */
  const ensureChat = (/** @type {{ id: string, name: string }} */ channel) => {
    const id = chatOf(channel.id);
    if (!app.chats.has(id)) {
      const chat = app.add({ id, title: channel.name, harness: 'claude', at: now(), hidden: true });
      void chat;
    }
    return id;
  };
  return {
    registry,
    /** The journal of a phone's `channelId`, made on its first use when `make`; refused when channels are off or the channel is gone. */
    chatId(/** @type {string} */ channelId, /** @type {boolean} */ make) {
      on();
      const channel = registry.get(channelId);
      if (!channel) throw new RemoteError('gone', GONE);
      if (make) return ensureChat(channel);
      return app.chats.has(chatOf(channelId)) ? chatOf(channelId) : null;
    },
    isChannelChat: (/** @type {string} */ chatId) => enabled() && registry.list().channels.some((c) => chatOf(c.id) === chatId),
    assertChannel(/** @type {string} */ channelId) {
      on();
      if (!registry.get(channelId)) throw new RemoteError('gone', GONE);
    },
    list: async () => (enabled() ? { enabled: true, ...registry.list() } : { enabled: false, channels: [], groups: [], room: 0 }),
    create: (/** @type {string} */ name, /** @type {string | null} */ group) =>
      change(async () => ({ channel: await registry.create(name, group) })),
    rename: (/** @type {string} */ id, /** @type {string} */ name) => change(async () => ({ channel: await registry.rename(id, name) })),
    archive: (/** @type {string} */ id) => change(async () => ({ id: (await registry.archive(id)).id })),
    remove: (/** @type {string} */ id) =>
      change(async () => {
        app.chats.delete(chatOf(id));
        return { id: (await registry.remove(id)).id };
      }),
    move: (/** @type {string} */ id, /** @type {string | null} */ group) =>
      change(async () => ({ channel: await registry.move(id, group) })),
    welcome: (/** @type {string} */ id, /** @type {string} */ answer) =>
      change(async () => ({ channel: await registry.answerWelcome(id, answer) })),
    group: {
      create: (/** @type {string} */ name) => change(async () => ({ group: await registry.createGroup(name) })),
      rename: (/** @type {string} */ id, /** @type {string} */ name) =>
        change(async () => ({ group: await registry.renameGroup(id, name) })),
      remove: (/** @type {string} */ id) => change(async () => ({ removed: await registry.removeGroup(id) })),
    },
    /**
     * A turn in the channel (the first open one, or the one named) that asks "Run this command?" and waits for the answer, as a channel's turn that needs the user does.
     * Resolves the channel's name, id and chat's id, and the card's id once it is up.
     */
    async raiseCard(/** @type {string | undefined} */ name) {
      const channel = registry.list().channels.find((c) => (name ? c.name.toLowerCase() === name.toLowerCase() : true));
      if (!channel) throw new Error(name ? `No channel ${name}.` : 'No channel yet: run momo-channels seed.');
      const chatId = ensureChat(channel);
      const chat = app.chats.get(chatId);
      if ((await app.ops.cardsOf(chatId)).length === 0)
        void app.enqueue(chat, async (/** @type {any} */ t) => {
          await t.say('I will check the repository first.');
          const key = await t.ask({ title: 'Run this command?', detail: 'git status --short' });
          await t.say(key === 'once' ? 'Ran git status --short' : 'Understood, I did not run it.');
        });
      let cardId = '';
      for (let i = 0; i < 100 && !cardId; i++) {
        cardId = String((await app.ops.cardsOf(chatId))[0]?.id ?? '');
        if (!cardId) await new Promise((r) => setTimeout(r, 20));
      }
      changed('channels');
      return { name: channel.name, id: channel.id, chatId, cardId };
    },
    /** Every card waiting in an open channel's chat, naming its channel and chat (the Tasks list lists them beside Main's). */
    async waitingCards() {
      if (!enabled()) return [];
      const out = [];
      for (const channel of registry.list().channels) {
        const chatId = chatOf(channel.id);
        if (!app.chats.has(chatId)) continue;
        for (const c of await app.ops.cardsOf(chatId)) out.push({ ...c, chatId, channel: { id: channel.id, name: channel.name } });
      }
      return out;
    },
    /** A few channels and a group, for the bench to show a picker with something in it. Resolves what was made. */
    async seed() {
      const home = await registry.createGroup('Home');
      const trip = await registry.create('Trip');
      const kitchen = await registry.create('Kitchen', home.id);
      await registry.create('Garden', home.id);
      await registry.createGroup('Work');
      changed('channels');
      return { groups: 2, channels: 3, trip: trip.id, kitchen: kitchen.id };
    },
  };
}
