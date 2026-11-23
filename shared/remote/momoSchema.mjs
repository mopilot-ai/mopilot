// Params of MoMo's phone methods (momo.*, phone only, and only for an account MoMo is allowed for), written as a factory over schema.mjs's helpers so the two modules never import each other. None names a chat: MoMo's main chat (or, with an optional channel id, that channel's journal, A2) is the only one a device can reach, picked by the Mac.
import { MOMO_PROACTIVITY_LIMITS } from '../momoPrefs.mjs';
import { momoChannelParsers } from './momoChannelSchema.mjs';

/**
 * @param {{ bad: (message: string) => Error, queryOf: (p: any) => string, audioStreamOf: (p: any) => { stream: string, mime: string }, MAX_TEXT: number, MAX_FOLLOW_ITEMS: number, DEFAULT_FOLLOW_ITEMS: number }} h
 * @returns {Record<string, (p: any) => any>}
 */
export function momoParsers({ bad, queryOf, audioStreamOf, MAX_TEXT, MAX_FOLLOW_ITEMS, DEFAULT_FOLLOW_ITEMS }) {
  /** A MoMo fact's or routine's id, and the id of a send a phone may retry. */
  const MOMO_ID = /^[\w.:-]{1,128}$/;
  const momoId = (/** @type {unknown} */ v, /** @type {string} */ message) => {
    if (typeof v !== 'string' || !MOMO_ID.test(v)) throw bad(message);
    return v;
  };
  const FACT = "That isn't one of MoMo's memories.";
  const ROUTINE = "That isn't one of MoMo's routines.";
  const routineOf = (/** @type {any} */ p) => ({ id: momoId(p.id, ROUTINE) });
  const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
  /** Quiet hours a phone sets: from start to end (HH:MM, not equal), or null for none. */
  const quietHoursOf = (/** @type {unknown} */ v) => {
    if (v === null) return null;
    const q = /** @type {any} */ (v);
    if (!q || typeof q !== 'object' || !CLOCK.test(q.start) || !CLOCK.test(q.end) || q.start === q.end)
      throw bad('Pick when quiet hours start and end.');
    return { start: q.start, end: q.end };
  };
  /** The settings a phone may change, one per request, each checked here and again where main saves it (shared/momoPrefs.mjs). */
  const MOMO_PREF_PARSERS = {
    paused: (/** @type {unknown} */ v) => {
      if (typeof v !== 'boolean') throw bad('Pause or resume MoMo.');
      return v;
    },
    proactivity: (/** @type {unknown} */ v) => {
      // the levels MoMo's routines enforce (shared/momoPrefs.mjs), so a level added or renamed there is one here too
      if (typeof v !== 'string' || !Object.hasOwn(MOMO_PROACTIVITY_LIMITS, v)) throw bad('Pick how often MoMo reaches out.');
      return v;
    },
    quietHours: quietHoursOf,
  };
  const MOMO_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  /** An effort level's name as the harnesses list them (low, medium, high, xhigh, max, ...). */
  const EFFORT = /^[\w-]{1,32}$/;
  const shortText = (/** @type {unknown} */ v, /** @type {number} */ max, /** @type {string} */ message) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t || t.length > max) throw bad(message);
    return t;
  };
  /** A routine's edit from a phone: its name, what it does, what it reads and when (a time with days, or an RRULE). */
  function routineEditOf(/** @type {unknown} */ v) {
    const e = /** @type {any} */ (v);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('Change something first.');
    /** @type {Record<string, unknown>} */
    const edit = {};
    if (e.name !== undefined) edit.name = shortText(e.name, 80, 'Give the routine a short name.');
    if (e.prompt !== undefined) edit.prompt = shortText(e.prompt, 4000, 'Say what the routine does in a few lines.');
    if (e.sources !== undefined) {
      if (!Array.isArray(e.sources) || e.sources.length > 20 || !e.sources.every((s) => typeof s === 'string' && MOMO_ID.test(s)))
        throw bad('Pick what the routine reads.');
      edit.sources = [...new Set(e.sources)];
    }
    if (e.rrule !== undefined) edit.rrule = shortText(e.rrule, 200, 'That schedule is not valid.');
    if (e.time !== undefined) {
      if (typeof e.time !== 'string' || !CLOCK.test(e.time)) throw bad('Pick a time.');
      edit.time = e.time;
    }
    if (e.days !== undefined) {
      if (!Array.isArray(e.days) || !e.days.every((d) => MOMO_DAYS.includes(d))) throw bad('Pick the days.');
      edit.days = [...new Set(e.days)];
    }
    if (!Object.keys(edit).length) throw bad('Change something first.');
    return edit;
  }

  // channels (A2): the methods on them, and the optional `channelId` the chat methods take (left out: MoMo's main chat)
  const { parsers: channelParsers, channelOf } = momoChannelParsers({ bad });

  return {
    ...channelParsers,
    'momo.chat.follow': (p) => ({
      items: Number.isInteger(p.items) ? Math.max(0, Math.min(MAX_FOLLOW_ITEMS, p.items)) : DEFAULT_FOLLOW_ITEMS,
      ...channelOf(p),
    }),
    'momo.chat.unfollow': (p) => channelOf(p),
    // MoMo's home (the one view and the one intent both clients send, shared/momoHomeApi.mjs): the intent is one object the home reads, of a size a wire frame can hold
    // a phone's Google sign-in steps (it has no browser-less path of its own): the one Host method the phone may reach through the Mac, whose Host answers the op
    'momo.home.google': (p) => {
      if (typeof p.op !== 'string' || !p.op || p.op.length > 40 || JSON.stringify(p).length > 64_000)
        throw bad('That is not a Google step.');
      // no MoMo method names a chat: the Host's own parser reads the rest
      const { chatId: _chat, channelId: _channel, ...step } = p;
      return step;
    },
    'momo.home.view': () => ({}),
    'momo.home.intent': (p) => {
      if (!p.intent || typeof p.intent !== 'object' || Array.isArray(p.intent) || typeof p.intent.kind !== 'string')
        throw bad('That is not something MoMo can do.');
      if (JSON.stringify(p.intent).length > 16_000) throw bad('That is too long for MoMo to take.');
      return { intent: p.intent };
    },
    'momo.chat.send': (p) => {
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) throw bad('Type a message first.');
      if (text.length > MAX_TEXT) throw bad('The message is too long.');
      if (
        p.expectedChatId !== undefined &&
        (typeof p.expectedChatId !== 'string' || !p.expectedChatId.trim() || p.expectedChatId.length > 256)
      )
        throw bad('Read MoMo’s main chat before sending.');
      return {
        id: momoId(p.id, 'Send that again.'),
        text,
        followUp: p.followUp === 'steer' ? 'steer' : 'queue',
        ...(p.expectedChatId === undefined ? {} : { expectedChatId: p.expectedChatId }),
        ...channelOf(p),
      };
    },
    'momo.chat.stop': (p) => channelOf(p),
    'momo.memory.list': () => ({}),
    'momo.memory.search': (p) => {
      const query = queryOf(p);
      if (!query) throw bad('Type what to look for.');
      return { query };
    },
    'momo.memory.edit': (p) => {
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text || text.length > 2000) throw bad('Write the memory in a few lines.');
      return { factId: momoId(p.factId, FACT), text };
    },
    'momo.memory.forget': (p) => ({ factId: momoId(p.factId, FACT) }),
    'momo.memory.docs': () => ({}),
    'momo.memory.changes': () => ({}),
    'momo.memory.undo': (p) => ({ changeId: momoId(p.changeId, 'That change is no longer in the log.') }),
    'momo.memory.past': () => ({}),
    // About you only: MoMo's persona stays on the Mac
    'momo.memory.writeDoc': (p) => {
      if (p.doc !== 'aboutYou') throw bad('Only About you can be edited here.');
      if (typeof p.text !== 'string' || p.text.length > 20000) throw bad('About you is at most 20,000 characters.');
      return { doc: 'aboutYou', text: p.text };
    },
    'momo.loops.list': () => ({}),
    'momo.loops.act': (p) => {
      if (!['done', 'snooze', 'dismiss', 'reopen'].includes(p.action)) throw bad('Pick Done, Snooze, Dismiss or Reopen.');
      if (p.action === 'snooze' && p.snooze !== 'day' && p.snooze !== 'week') throw bad('Snooze for a day or a week.');
      return {
        loopId: momoId(p.loopId, 'That reminder is no longer open.'),
        action: p.action,
        ...(p.action === 'snooze' ? { snooze: p.snooze } : {}),
      };
    },
    // a voice note for MoMo's chat, sent in parts as the coding chat's is (chat.attach, purpose audio): it names no chat, and only text comes back
    'momo.chat.transcribe': (p) => ({ ...audioStreamOf(p), ...channelOf(p) }),
    // the Tasks list (electron/momo/tasks.cjs), derived by the Mac: no params; a task is done through its source's own method
    'momo.tasks.list': () => ({}),
    // the user's mark on a routine run (done, archive, delete, reopen); with an undoToken it takes back what that call did (electron/momo/taskMarks.cjs)
    'momo.tasks.mark': (p) => {
      if (!['done', 'archive', 'delete', 'reopen'].includes(p.mark)) throw bad('Pick Mark as done, Archive, Delete or Reopen.');
      const taskId = momoId(p.taskId, 'That task is gone.');
      if (p.undoToken === undefined) return { taskId, mark: p.mark };
      return { taskId, mark: p.mark, undoToken: momoId(p.undoToken, 'That can’t be undone any more.') };
    },
    // what MoMo suggested for Up next (electron/momo/suggestions.cjs): no params
    'momo.suggestions.list': () => ({}),
    // the user's Add, Start or Hide on one suggestion; Start sends its first step to MoMo's chat as their own message
    'momo.suggestions.act': (p) => {
      if (!['add', 'start', 'hide'].includes(p.action)) throw bad('Pick Add, Start or Hide.');
      return { id: momoId(p.id, 'That suggestion is gone.'), action: p.action };
    },
    // Try again on the morning brief that could not start (electron/momo/briefIpc.cjs): no params
    'momo.brief.runNow': () => ({}),
    'momo.state.get': () => ({}),
    'momo.prefs.get': () => ({}),
    'momo.prefs.set': (p) => {
      // a key that is not one of these is left out, as every method's is; exactly one of these is changed
      const keys = Object.keys(p).filter((k) => Object.hasOwn(MOMO_PREF_PARSERS, k));
      if (keys.length !== 1) throw bad('Change one of MoMo’s settings at a time.');
      const key = /** @type {keyof typeof MOMO_PREF_PARSERS} */ (keys[0]);
      return { [key]: MOMO_PREF_PARSERS[key](p[key]) };
    },
    'momo.routines.list': () => ({}),
    'momo.routines.pause': routineOf,
    'momo.routines.resume': routineOf,
    'momo.routines.run': routineOf,
    'momo.routines.edit': (p) => ({ ...routineOf(p), edit: routineEditOf(p.edit) }),
    'momo.routines.delete': routineOf,
    'momo.routines.approve': (p) => {
      if (!Number.isSafeInteger(p.seen)) throw bad('Approve what was shown: its version is missing.');
      return { ...routineOf(p), seen: p.seen };
    },
    'momo.sources.status': () => ({}),
    'momo.brain.get': () => ({}),
    'momo.brain.set': (p) => {
      if (!p.brain || typeof p.brain !== 'object' || Array.isArray(p.brain)) throw bad('Pick a brain.');
      // effort (#3631): a level name, or null for the model's default; left out, MoMo keeps the one it has
      // (momo/brainEffort.cjs askedEffort), so a phone that doesn't know efforts changes nothing
      const { effort } = p.brain;
      if (effort !== undefined && effort !== null && !(typeof effort === 'string' && EFFORT.test(effort))) throw bad('Pick an effort.');
      return { brain: p.brain };
    },
    // a MoMo card (momoAction) answered by one of the choices the card offered
    'momo.card.answer': (p) => {
      if (typeof p.cardId !== 'string' && !Number.isSafeInteger(p.cardId)) throw bad('Pick one of the choices.');
      if (!Number.isSafeInteger(p.rev)) throw bad('That request was already answered.');
      if (typeof p.key !== 'string' || !p.key) throw bad('Pick one of the choices.');
      return { cardId: p.cardId, rev: p.rev, key: p.key, ...channelOf(p) };
    },
  };
}
