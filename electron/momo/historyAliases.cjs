// MoMo's search aliases in the background (#2999 P2): every TICK_MS, while MoMo is allowed, the Mac isn't on battery,
// the brain isn't at its limit and the day's alias tokens aren't spent (backgroundBudget.cjs), up to BATCH items without
// aliases go to MoMo's brain on its cheap model: saved facts first (factAliases.cjs, any `sources` given), then the
// newest chunks of the index of past chats, in a fresh data-only background chat (no tool, no memory:
// shared/momoChat.mjs isMomoDataMeta), on any harness; the reply's terms (aliases.cjs, at most 12 an item) are set on
// them and the chat goes. One batch at a time, of one source; new turns come first, then older ones, a batch a tick. An
// item the reply leaves out counts as a try, and one tried MAX_TRIES times is marked with none; a reply with no terms
// at all marks none, and MAX_EMPTY_REPLIES of them in a row stop the batches until start(). Keyword search works
// the same without them, and a reset or MoMo going off drops the batch under way.
const { aliasPrompt, parseAliases } = require('./aliases.cjs');
/**
 * What the writer writes aliases for: items without them (`key` names one), the prompt for a batch, and setting what the
 * reply gave (skipping items gone or changed since; `current()` false: MoMo was reset or went off, set nothing).
 * @typedef {{ key: string }} AliasItem
 * @typedef {{ name: string, available: () => boolean, needing: (n: number) => AliasItem[], prompt: (items: any[]) => string,
 *   set: (list: { item: any, aliases: string }[], current: () => boolean) => number | Promise<number> }} AliasSource
 */
const { estimateTokens } = require('./memoryFacts.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How often a batch may start. */
const TICK_MS = 3 * 60_000;
/** The chunks one call writes aliases for. */
const BATCH = 20;
/** A batch whose chat hasn't answered in this long is given up (the chat goes; its chunks are tried again). */
const STALE_MS = 10 * 60_000;
/** Tries before a chunk is marked as having no aliases. */
const MAX_TRIES = 2;
/** The reply's tokens, estimated before it comes: about this many a turn. */
const REPLY_TOKENS = 40;
/** Replies in a row with no terms at all (a failed turn, a refusal) before no batch starts again until start(). */
const MAX_EMPTY_REPLIES = 3;

/**
 * @param {object} o
 * @param {Pick<InstanceType<typeof import('./historyIndex.cjs').HistoryIndex>, 'available' | 'needingAliases' | 'setAliases'>} o.index
 * @param {() => boolean} o.allowed MoMo is on for the account, not paused and not being reset
 * @param {() => Promise<any>} o.brain the brain on its cheap model
 * @param {(brain: any) => boolean} o.atLimit
 * @param {(brain: any, tag: object) => Promise<string>} o.startChat a fresh data-only MoMo background chat
 * @param {(chatId: string, text: string) => Promise<unknown>} o.send
 * @param {(chatId: string) => Promise<unknown> | unknown} o.discardChat
 * @param {{ spend: (kind: 'aliases', tokens: number) => Promise<void>, left: (kind: 'aliases') => number }} o.budget
 * @param {AliasSource[]} [o.sources] sources before the index of past chats (saved facts)
 * @param {() => boolean} [o.onBattery]
 * @param {number} [o.tickMs] how often a batch may start (TICK_MS)
 * @param {() => number} [o.now]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
 */
function createHistoryAliases(o) {
  const timers = o.timers ?? { setInterval, clearInterval };
  const now = o.now ?? Date.now;
  /** @type {AliasSource} the index of past chats, newest chunks first */
  const history = {
    name: 'history',
    available: () => o.index.available(),
    needing: (n) => o.index.needingAliases(n).map((t) => ({ ...t, key: `${t.chatId}\u0000${t.turnId}` })),
    prompt: aliasPrompt,
    set: (list) => o.index.setAliases(list.map(({ item, aliases }) => ({ chatId: item.chatId, turnId: item.turnId, aliases }))),
  };
  const sources = [...(o.sources ?? []), history];
  /** @type {{ chatId: string, source: AliasSource, items: AliasItem[], at: number, gen: number } | null} */
  let pending = null;
  let starting = false;
  let gen = 0;
  /** @type {Map<string, number>} source and item key → failed tries */
  const tries = new Map();
  /** replies in a row that held no JSON at all */
  let empty = 0;
  /** @type {any} */
  let ticker = null;
  const key = (/** @type {AliasSource} */ src, /** @type {AliasItem} */ t) => `${src.name}\u0000${t.key}`;
  /** The first source with items to alias, and up to BATCH of them; one that fails to say is skipped this tick. */
  const nextBatch = () => {
    for (const source of sources) {
      try {
        if (!source.available()) continue;
        const items = source.needing(BATCH);
        if (items.length) return { source, items };
      } catch (error) {
        noteIgnored(`find ${source.name} needing search aliases`, error);
      }
    }
    return null;
  };

  /** Drops a batch that never answered, so the next tick can start one. */
  async function dropStale() {
    if (!pending || now() - pending.at < STALE_MS) return;
    const chatId = pending.chatId;
    pending = null;
    await o.discardChat(chatId);
  }

  /** Starts one batch when everything allows it; false when none was started. */
  async function tick() {
    // a cancel (MoMo off, Reset) from here on drops what this tick starts
    const mine = gen;
    await dropStale();
    if (mine !== gen || pending || starting || empty >= MAX_EMPTY_REPLIES || !o.allowed() || o.onBattery?.()) return false;
    const batch = nextBatch();
    if (!batch) return false;
    const { source, items } = batch;
    const prompt = source.prompt(items);
    const cost = estimateTokens(prompt) + REPLY_TOKENS * items.length;
    if (o.budget.left('aliases') < cost) return false;
    starting = true;
    try {
      const brain = await o.brain();
      if (mine !== gen || !brain || o.atLimit(brain)) return false;
      const chatId = await o.startChat(brain, { momo: 'aliases' });
      if (!o.allowed() || mine !== gen) {
        await o.discardChat(chatId);
        return false;
      }
      pending = { chatId, source, items, at: now(), gen: mine };
      await o.budget.spend('aliases', estimateTokens(prompt));
      // a reset, MoMo going off or the chat deleted while it was counted: this batch is no longer the one to send
      if (mine !== gen || pending?.chatId !== chatId || !o.allowed()) {
        if (pending?.chatId === chatId) pending = null;
        await o.discardChat(chatId);
        return false;
      }
      try {
        await o.send(chatId, prompt);
      } catch (error) {
        // never sent: the next tick may start another at once
        if (pending?.chatId === chatId) pending = null;
        await o.discardChat(chatId);
        throw error;
      }
      return true;
    } finally {
      starting = false;
    }
  }

  /** The batch's chat answered: its terms go on its chunks (unless MoMo went off or was reset), and the chat goes. */
  async function landed(/** @type {string | null | undefined} */ text) {
    const p = /** @type {NonNullable<typeof pending>} */ (pending);
    pending = null;
    try {
      await o.budget.spend('aliases', estimateTokens(String(text ?? '')));
      if (p.gen !== gen || !o.allowed()) return 0;
      const terms = parseAliases(text, p.items.length);
      // a reply with no terms at all (a failed turn, the brain at its limit) says nothing about these turns: none is
      // marked, and a few in a row stop the batches until MoMo starts them again
      if (terms === null) {
        empty++;
        return 0;
      }
      empty = 0;
      /** @type {{ item: AliasItem, aliases: string }[]} */
      const set = [];
      p.items.forEach((t, i) => {
        const got = terms[i];
        const k = key(p.source, t);
        const tried = (tries.get(k) ?? 0) + 1;
        if (got || tried >= MAX_TRIES) {
          tries.delete(k);
          set.push({ item: t, aliases: got });
        } else tries.set(k, tried);
      });
      // a write that waits (the facts' sealed file) re-checks that this batch's generation is still the current one
      return await p.source.set(set, () => p.gen === gen && o.allowed());
    } finally {
      await o.discardChat(p.chatId);
    }
  }

  return {
    /** A chat's turn ended (the controller's onFinished): the batch's chat lands; any other chat is not this one's. */
    async finished(/** @type {{ chatId: string, text?: string | null }} */ e) {
      if (!pending || pending.chatId !== e.chatId) return null;
      return landed(e.text);
    },
    /** A chat was deleted (Reset deletes MoMo's): the batch it ran is over, and its reply never lands. */
    deleted(/** @type {string} */ chatId) {
      if (pending?.chatId !== chatId) return;
      pending = null;
      gen++;
    },
    /** Starts the ticks (at startup, or MoMo allowed again). */
    start() {
      empty = 0;
      if (ticker !== null) return;
      ticker = timers.setInterval(() => {
        tick().catch((error) => noteIgnored("write search aliases for MoMo's past chats", error));
      }, o.tickMs ?? TICK_MS);
      ticker?.unref?.();
    },
    /** MoMo went off or was reset: no tick runs, and the batch under way never lands. */
    cancelAll() {
      gen++;
      tries.clear();
      if (ticker !== null) timers.clearInterval(ticker);
      ticker = null;
      const chatId = pending?.chatId;
      pending = null;
      if (chatId) Promise.resolve(o.discardChat(chatId)).catch((error) => noteIgnored('discard a search-aliases chat', error));
    },
    tick,
    pending: () => (pending ? pending.items.length : 0),
  };
}

module.exports = { createHistoryAliases, TICK_MS, BATCH, STALE_MS, MAX_TRIES, REPLY_TOKENS, MAX_EMPTY_REPLIES };
