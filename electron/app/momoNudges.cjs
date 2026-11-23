// MoMo's nudges in main (#2139 P4), over the services app/momo.cjs made: the nudge check (momo/nudges.cjs) on the open loops, its state sealed in <momo dir>/nudges.json (reset with the memory), its decline check a data-only, unattended MoMo background chat on the brain's cheap model (any harness) within the day's background budget, Calendar's next day read through the sources hub (decided and audited, as MoMo's main chat) only when Calendar is connected. A nudge MoMo sends is a note in its main chat (meta.notes, kind 'nudge'): it shows as MoMo's, never as the user's, starts no model turn, and is never read back as the user's words; the lock screen shows only "MoMo needs you".
const path = require('node:path');
const { createNudges, stateShape } = require('../momo/nudges.cjs');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { cheapBrain } = require('../momo/cheapBrain.cjs');
const { UNATTENDED, ISOLATION } = require('../momo/routines.cjs');
const { roleBrain, isMomoPaused } = require('../../shared/momoPrefs.mjs');
const { routineSettings } = require('../../shared/momoRoutine.mjs');
const { momoResetting } = require('../momo/stores.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a nudge stays in MoMo's turn context, and how many do. */
const RECENT_MS = 3 * 86_400_000;
const RECENT_MAX = 5;

/**
 * The nudges MoMo showed in a chat lately, one line each for its turn context (contract/context.cjs): when, the loop,
 * and what MoMo said, newest last.
 * @param {unknown} notes the chat's meta.notes @param {number} now
 */
function recentNudges(notes, now) {
  return (Array.isArray(notes) ? notes : [])
    .filter((/** @type {any} */ n) => n?.kind === 'nudge' && n.nudge && typeof n.at === 'number' && n.at > now - RECENT_MS)
    .slice(-RECENT_MAX)
    .map(
      (/** @type {any} */ n) =>
        `- ${new Date(n.at).toISOString().slice(0, 16).replace('T', ' ')} UTC, about ${JSON.stringify(String(n.nudge.title))}: ${JSON.stringify(String(n.text))}`,
    );
}

/** About what one decline check spends (prompt and reply): it waits while the day's nudge budget has less. */
const CHECK_TOKENS = 1_500;

/**
 * The note a nudge is in MoMo's main chat: MoMo's line, and why (the user's words, when they said them, the trigger).
 * @param {{ loop: any, trigger: any, text: string, why: string }} n @param {number} at
 */
function nudgeNote(n, at) {
  return {
    id: `nudge-${at}-${n.loop.id}`,
    kind: 'nudge',
    text: n.text,
    // after the chat's latest turn (shared/chatNotes.mjs)
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at,
    nudge: { loopId: n.loop.id, title: n.loop.text, quote: n.loop.quote, saidAt: n.loop.saidAt, trigger: n.trigger.trigger, why: n.why },
  };
}

/**
 * @param {{ core: any, live: any, allowed: () => boolean, safeStorage: any, startChat: (brain: any, tag: object) => Promise<string>,
 *   send: (chatId: string, item: object) => Promise<unknown>, authored: (chatId: string, text: string, show: object) => object,
 *   discardChat: (chatId: string) => unknown, limitOf: (brain: any) => object, momoPrefs: () => any, prefs: () => any,
 *   budget: ReturnType<typeof import('../momo/backgroundBudget.cjs').createBackgroundBudget>, notices: { needsYou: (t: { kind: 'chat', chatId: string }) => boolean },
 *   broadcastAll: (channel: string, payload?: unknown) => void, now?: () => number }} d
 */
function openMomoNudges({
  core,
  live,
  allowed,
  safeStorage,
  startChat,
  send,
  authored,
  discardChat,
  limitOf,
  momoPrefs,
  prefs,
  budget,
  notices,
  broadcastAll,
  now = Date.now,
}) {
  const on = () => allowed() === true && !isMomoPaused(momoPrefs()) && !momoResetting();
  const state = new SealedJson({ file: path.join(core.dir, 'nudges.json'), safeStorage, shape: stateShape, now });
  const calendarOn = () =>
    core.sources?.hub?.list().some((/** @type {any} */ s) => s.id === 'calendar' && s.connected && !s.needsGrant) === true;
  const nudges = createNudges({
    loops: core.loops,
    state,
    allowed: on,
    settings: () => routineSettings(prefs()),
    tz: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    events: async (from, to) => {
      const main = core.mainChat.current();
      if (!main || !calendarOn()) return [];
      const r = await core.sources.calendar.events({ start: from, end: to, limit: 50 }, main);
      return (r?.events ?? []).map((/** @type {any} */ e) => ({ title: String(e.title ?? ''), start: Number(e.start) }));
    },
    brain: async () => cheapBrain(roleBrain(momoPrefs()), async () => live.codex?.modelList()),
    atLimit: (/** @type {any} */ brain) => 'held' in limitOf(brain),
    startChat: async (/** @type {any} */ brain, /** @type {object} */ tag) => {
      const chatId = await startChat(brain, { ...tag, isolation: ISOLATION });
      live.sessions?.patch(chatId, { scheduled: UNATTENDED });
      return chatId;
    },
    send: (/** @type {string} */ chatId, /** @type {string} */ text) =>
      send(chatId, authored(chatId, text, { by: 'momo', title: 'Nudges' })),
    discardChat,
    deliver: async (n) => {
      if (!on()) return false;
      const main = (await core.mainChat.ensureMainChat()).chatId;
      const at = now();
      const rec = live.chats.record(main);
      // patchMeta-changes: the nudge note is new, so the notes always change
      if (!rec || !live.chats.patchMeta(main, { notes: [...(rec.meta?.notes ?? []), nudgeNote(n, at)] })) return false;
      broadcastAll('chats:changed', { id: main, chat: live.chats.get(main) });
      // the lock screen: the fixed title alone, never the loop
      notices.needsYou({ kind: 'chat', chatId: main });
      return true;
    },
    spent: (tokens) => void budget.spend('nudges', tokens).catch((error) => noteIgnored("count MoMo's nudge tokens", error)),
    canSpend: () => budget.left('nudges') >= CHECK_TOKENS,
    now,
  });
  return { nudges, state };
}

module.exports = { openMomoNudges, nudgeNote, recentNudges, CHECK_TOKENS, RECENT_MS, RECENT_MAX };
