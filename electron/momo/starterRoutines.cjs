// MoMo's starter routines (#2139, #2285): what each one setup suggests (prefs.momo.routines.starter, shared/momoPrefs.mjs) does, when and what it reads, and how the ones the user picked become proposed routines once setup is done: each waits in Settings › MoMo › Routines for the user's Approve, and is proposed once ever (routineStore.cjs keeps which were), so a restart, a later prefs change or a declined one never brings it back. Setup's Start also has MoMo greet in its main chat (createGreeter, #2527). Offers run one at a time, at startup, when MoMo is allowed again and on each prefs change; none while MoMo is paused or being reset (a reset pauses it first, so nothing it erased comes back), and Resume offers again.
const { readMomoPrefs } = require('../../shared/momoPrefs.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { markedText } = require('../../shared/modelFraming.mjs');

/**
 * Each starter routine as proposed. The id `morningFeed` is the one older builds saved for the morning briefing.
 * @type {Record<string, () => { name: string, prompt: string, rrule: string, sources: string[] }>}
 */
const STARTERS = Object.freeze({
  morningFeed: () => ({
    name: 'Morning briefing',
    prompt: 'Give a short briefing for today: the events in Calendar and what is due in Reminders, a line each, the first one first.',
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
    sources: ['calendar', 'reminders'],
  }),
  weekAhead: () => ({
    name: 'Week ahead',
    prompt: 'Look at the coming week in Calendar and Reminders: each day that has something, in a line, and anything that clashes.',
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0;BYSECOND=0',
    sources: ['calendar', 'reminders'],
  }),
  bills: () => ({
    name: 'Bill reminders',
    prompt:
      'Look in Reminders and Calendar for bills or payments due in the next three days: each with its due date. If there are none, say so in a line.',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    sources: ['reminders', 'calendar'],
  }),
});

/**
 * Returns `offer(prefs?)`: once setup is done and while MoMo is allowed and not `held()` (paused, or being reset: read
 * again before each starter), each starter the user picked is proposed, one at a time; resolves to the routines proposed
 * now (none when each was before). A starter that couldn't be proposed is tried again at the next offer.
 * @param {{ routines: { propose: (input: any, o: { starter: string }) => Promise<any> }, prefs: () => any, allowed: () => boolean,
 *   held: () => boolean }} o
 */
function createStarterOffers({ routines, prefs, allowed, held }) {
  /** @type {Promise<any[]>} the last offer: the next one starts after it, whether it resolved or its caller got its failure */
  let chain = Promise.resolve([]);
  const once = async (/** @type {any} */ p) => {
    if (allowed() !== true) return [];
    const momo = readMomoPrefs(p?.momo);
    if (!momo.onboarding.done) return [];
    const out = [];
    for (const id of momo.routines.starter) {
      if (held()) break;
      try {
        // every id setup can save has its starter (tests/momoStarterRoutines.test.ts)
        const routine = await routines.propose(STARTERS[id](), { starter: id });
        if (routine) out.push(routine);
      } catch (error) {
        noteIgnored(`propose MoMo's starter routine ${id}`, error);
      }
    }
    return out;
  };
  return (/** @type {any} */ p = prefs()) => {
    const run = () => once(p);
    chain = chain.then(run, run);
    return chain;
  };
}

/** The error every MoMo call gives while MoMo is off for the account (the window reads its code). */
const notAllowed = () => Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' });

/** What MoMo is asked to do on the user's first visit. */
const GREETING = markedText(
  'Setup',
  'The user just finished setting you up. Greet them in one or two short sentences, by your name, and say in a line what you can do for them (their calendar and reminders if connected, routines that run on a schedule, which wait for their approval in Settings › MoMo › Routines). Ask at most one question.',
);

/**
 * @param {object} o
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => Promise<{ chatId: string }>} o.ensureMainChat the main chat, made when it is the first visit
 * @param {(chatId: string, text: string, show: object) => object} o.authored
 * @param {(chatId: string, item: object) => Promise<unknown>} o.send
 * @returns {() => Promise<boolean>} greet: true when MoMo was asked to say hello now, false when it already was
 */
function createGreeter({ allowed, ensureMainChat, authored, send }) {
  /** @type {Set<string>} the main chats greeted */
  const greeted = new Set();
  return async () => {
    if (!allowed()) throw notAllowed();
    const { chatId } = await ensureMainChat();
    if (greeted.has(chatId)) return false;
    greeted.add(chatId);
    try {
      await send(chatId, authored(chatId, GREETING, { by: 'momo', title: 'Welcome' }));
    } catch (error) {
      // a greeting that didn't go can be tried again
      greeted.delete(chatId);
      throw error;
    }
    return true;
  };
}

module.exports = { createStarterOffers, STARTERS, createGreeter, GREETING };
