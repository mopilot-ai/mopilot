// How a MoMo routine's run reaches the user (#2139): its result, or why it didn't finish, goes to MoMo's main chat as a message no human wrote (session/authoredInput.cjs: the chat shows it as MoMo's, a card with the routine's name and its paragraph, never the text the model is sent). Such a message can't start anything (requireUserTurn) and tells the model to say it in a line or two. Nothing is sent while MoMo isn't allowed, is paused or is being reset; a message that can't be sent (or that the main chat's harness refused to start) is noted, never the run's failure. A run Pause stopped says nothing: the user just paused.
const { authoredOr } = require('../session/authoredInput.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { routineReportText } = require('../../shared/modelFraming.mjs');

/** What the model is sent for a routine's run: the outcome as data, and what to do with it (shared/modelFraming.mjs, which every client reads back). */
function reportText(/** @type {string} */ name, /** @type {boolean} */ completed, /** @type {string} */ text) {
  return routineReportText(name, completed, text);
}

/**
 * @param {object} o
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => boolean} o.held MoMo is paused or being reset: nothing is sent
 * @param {() => Promise<string | null>} o.mainChatId MoMo's main chat (made when there is none yet), or null when there is none
 * @param {(chatId: string, item: object) => Promise<any>} o.send through the ChatController
 * @param {(chatId: string, text: string, show: { by: string, title: string, body?: string | null }) => object} [o.authored]
 *   the input to send that no human wrote, with how windows show it
 * @returns {(r: { name: string, completed: boolean, text: string }) => Promise<boolean>} whether the main chat was told
 */
function createRoutineReporter({ allowed, held, mainChatId, send, authored }) {
  return async ({ name, completed, text }) => {
    if (allowed() !== true || held()) return false;
    try {
      const main = await mainChatId();
      if (!main) return false;
      const item = authoredOr(authored, main, reportText(name, completed, text), {
        by: 'momo',
        title: `“${name}” ${completed ? 'finished' : 'didn’t finish'}`,
        body: text,
      });
      const sent = /** @type {any} */ (await send(main, item));
      // a message the chat held (its brain is at its limit) goes later; one that couldn't start is lost
      if (sent?.started === false && !sent.held && !sent.discarded)
        throw new Error(`The message didn’t start: ${sent.error ?? 'the harness refused it'}`);
      return true;
    } catch (error) {
      noteIgnored("tell MoMo's main chat of a routine's result", error);
      return false;
    }
  };
}

module.exports = { createRoutineReporter, reportText };
