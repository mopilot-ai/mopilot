// MoMo's opt-in push body (A6): which routine's run a chat is, and the one text a push may carry besides its fixed title, the name of that routine when the user approved it and turned the setting on (Settings › MoMo; a Mac-only setting, never a phone's). Everything but the routine's name is left out by shared/momoNotices.mjs momoPushBody (tests/momoPushBody.invariant.test.ts holds the repository to that).
const { momoPushBody } = require('../../shared/momoNotices.mjs');
const { readMomoPrefs } = require('../../shared/momoPrefs.mjs');
const { chatOfKey } = require('./notices.cjs');

/**
 * The routine a chat is the run of, by id, or null: a run's chat carries its routine in its tag, and one whose tag is
 * not written yet is matched by its open run.
 * @param {{ meta: (chatId: string) => any, openRun: (chatId: string) => { taskId?: string } | null }} o
 */
function createRoutineOfChat({ meta, openRun }) {
  return (/** @type {string} */ chatId) => {
    const tag = meta(chatId);
    if (tag?.momo === 'routine') return /** @type {string} */ (tag.routineId);
    return tag ? null : (openRun(chatId)?.taskId ?? null);
  };
}

/**
 * @param {object} o
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => unknown} o.momoPrefs prefs.momo
 * @param {(chatId: string) => string | null} o.routineIdOf
 * @param {(routineId: string) => { name?: unknown, approved?: unknown } | null | undefined} o.routine the routine as stored
 * @returns {{ on: () => boolean, body: (noticeKey: string) => string }}
 */
function createMomoPushBody({ allowed, momoPrefs, routineIdOf, routine }) {
  // read at every push: an opt-out applies to the next notice, and to one that was waiting
  const on = () => allowed() === true && readMomoPrefs(momoPrefs()).notify.pushBody === true;
  return {
    on,
    /** The body of the notice with this key (the banner's chat, notices.cjs keyOf): the name of the routine whose run raised it, or '' (a notice no routine raised has none). */
    body(noticeKey) {
      if (!on()) return '';
      const chatId = chatOfKey(noticeKey);
      const id = chatId ? routineIdOf(chatId) : null;
      return momoPushBody({ optIn: true, routine: id ? routine(id) : null });
    },
  };
}

module.exports = { createMomoPushBody, createRoutineOfChat };
