// MoMo's Tasks list (A1), derived on every read from data MoMo already keeps and stored nowhere: the routine runs still going (routineStore), the open loops that are awake (openLoops) and the approval cards waiting in MoMo's main chat and in every open channel's chat (A2, #4846: a card raised in a channel waits there, so Tasks lists it, naming the channel). A task's id is its source's id, so it is the same after a Mac restart; a task goes away only when its source ends (a run finishes, the user answers the card, the user marks the loop done, dismisses it or snoozes it): nothing here completes anything.
// (a run's longest time, routineRuns.cjs MAX_RUN_MS, is repeated here so this module imports nothing that writes to disk: tests/momoTasks.test.ts holds the two equal)

/** No more tasks than this are listed, the ones that need the user first. */
const MAX_TASKS = 100;
const MAX_TEXT = 200;
/** A run whose record is older than this and never ended (a quit MoPilot left it open) is no longer shown as running. */
const RUN_SHOWN_MS = 2 * 3600_000;

/**
 * @typedef {{ id: string, kind: 'run' | 'loop' | 'card', state: 'running' | 'needs-you', title: string, detail: string | null,
 *   at: number | null, dueAt: number | null, dueDay: string | null, ref: string, channel: { id: string, name: string } | null, chatId: string | null }} MomoTask
 *   ref: the id the source's own call takes (a loop's id for momo.loops.act, a card's id for momo.card.answer, a run's chat id)
 *   channel: for a card waiting in a channel, that channel (its answer goes to the channel: momo.card.answer with `channelId`); null for main's cards and every other kind
 *   chatId: the chat a card waits in (what the Mac's own windows open), null for any other kind
 */

/** The day a time falls on in the Mac's zone, as YYYY-MM-DD (as the window's day() names it). */
const dayOf = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const clip = (/** @type {unknown} */ v, /** @type {string} */ fallback) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, MAX_TEXT);
};

/**
 * @param {object} o
 * @param {{ chatId: string, taskId: string, startedAt: number, endedAt?: number }[]} o.runs the routine runs the store keeps
 * @param {(taskId: string) => string | null | undefined} o.routineName
 * @param {{ id: string, text: string, quote?: string, state: string, saidAt: number, dueAt?: number, dueDay?: string, snoozedUntil?: number }[]} o.loops every loop the store keeps
 * @param {{ id: string | number, params?: { kind?: string, momo?: { summary?: string, tool?: string, source?: string } }, channel?: { id: string, name: string } | null, chatId?: string }[]} o.cards the momoAction cards waiting in MoMo's main chat and its channels' chats (waitingCards)
 * @param {number} o.now
 * @returns {MomoTask[]}
 */
function deriveTasks({ runs, routineName, loops, cards, now }) {
  /** @type {MomoTask[]} */
  const needs = cards.map((c) => {
    const m = c.params?.momo;
    return {
      id: cardTaskId(c),
      kind: 'card',
      state: 'needs-you',
      title: clip(m?.summary || m?.tool, 'MoMo needs your OK'),
      detail: m?.source ? clip(m.source, '') : null,
      at: null,
      dueAt: null,
      dueDay: null,
      ref: String(c.id),
      channel: c.channel ?? null,
      chatId: c.chatId ?? null,
    };
  });
  const awake = loops
    .filter((l) => l.state === 'open' && !(typeof l.snoozedUntil === 'number' && l.snoozedUntil > now))
    // the soonest due first, then the ones with no date, newest said first
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.saidAt - a.saidAt || a.id.localeCompare(b.id));
  for (const l of awake)
    needs.push({
      id: `loop:${l.id}`,
      kind: 'loop',
      state: 'needs-you',
      title: clip(l.text, 'A reminder'),
      detail: l.quote ? clip(l.quote, '') : null,
      at: l.saidAt,
      dueAt: l.dueAt ?? null,
      dueDay: l.dueDay ?? (l.dueAt === undefined ? null : dayOf(l.dueAt)),
      ref: l.id,
      channel: null,
      chatId: null,
    });
  const running = runs
    .filter((r) => r.endedAt === undefined && now - r.startedAt < RUN_SHOWN_MS)
    .sort((a, b) => b.startedAt - a.startedAt || a.chatId.localeCompare(b.chatId))
    .map(
      (r) =>
        /** @type {MomoTask} */ ({
          id: `run:${r.chatId}`,
          kind: 'run',
          state: 'running',
          title: clip(routineName(r.taskId), 'A routine'),
          detail: null,
          at: r.startedAt,
          dueAt: null,
          dueDay: null,
          ref: r.chatId,
          channel: null,
          chatId: null,
        }),
    );
  return [...needs, ...running].slice(0, MAX_TASKS);
}

/** A card's task id: main's keep `card:<id>`, a channel's name the channel too (card ids are each chat's own, so two chats may hold the same one). */
const cardTaskId = (/** @type {{ id: string | number, channel?: { id: string } | null }} */ c) =>
  c.channel ? `card:${c.channel.id}:${c.id}` : `card:${c.id}`;

/**
 * The momoAction cards waiting in MoMo's main chat, from the session state main holds (none before there is a main chat or a session for it),
 * and in every open channel's chat while channels are on, each of those naming its channel and its chat.
 * @param {any} controller @param {any} mainChat
 * @param {{ enabled: () => boolean, registry: { list: () => { channels: { id: string, name: string }[] }, chatIdOf: (id: string) => string | null } } | null} [channels]
 */
function waitingCards(controller, mainChat, channels = null) {
  const waiting = (/** @type {string | null} */ chatId, /** @type {object} */ extra) =>
    chatId && controller?.state?.has(chatId)
      ? controller.state
          .get(chatId)
          .approvals.filter((/** @type {any} */ a) => a.params?.kind === 'momoAction')
          .map((/** @type {any} */ a) => ({ ...a, chatId, ...extra }))
      : [];
  const main = mainChat.mainChatId();
  const out = waiting(main, { channel: null });
  if (channels?.enabled() === true)
    for (const c of channels.registry.list().channels)
      out.push(...waiting(channels.registry.chatIdOf(c.id), { channel: { id: c.id, name: c.name } }));
  return out;
}

module.exports = { deriveTasks, waitingCards, cardTaskId, dayOf, clip, MAX_TASKS, RUN_SHOWN_MS };
