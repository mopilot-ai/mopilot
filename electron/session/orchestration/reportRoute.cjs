// Where a linked session's turn reports and when it wakes, as Claude Desktop does it: a turn no person took part in
// wakes the session it reports to (the nearest live ancestor), however deep, and a session that waits on the user holds
// that wake for SETTLE_MS before its siblings' notes go up.
const { clock } = require('../../platform/ports/clock.cjs');
const { liveParentOf, stateWord } = require('./family.cjs');

/** How long a session's request to the user counts as work in progress before its parent may wake (CD settledForMs). */
const SETTLE_MS = 10_000;

/**
 * An input main delivers to a linked session (a brief, a family message, a wake-up, a peer's message) starts a turn
 * that is not the user's: the turn's end wakes its parent unless the user wrote into it (ChatController `person`).
 * @param {any} orch the Orchestrator
 * @param {{ chatId: string, kind: string, item: any }} e
 * @param {boolean} human
 */
function noteDriven(orch, { chatId, kind, item }, human) {
  const child = orch.journal.child(chatId);
  if (human || kind !== 'turn' || typeof item?.id !== 'string' || !item.id || !child || child.detached || child.driven.includes(item.id))
    return;
  orch.safely('note an input main gave a linked chat', () => orch.journal.change((d) => d.children[chatId].driven.push(item.id)));
}

/** The chats that report to `parentId` now: its own children, and those whose parent between is archived. */
function reportersOf(orch, parentId) {
  return Object.keys(orch.journal.data.children).filter(
    (id) => !orch.archived(id) && liveParentOf(orch.journal, id, orch.archived)?.parentId === parentId,
  );
}

/** A linked session started waiting on the user: its parent's wake is checked again once the request has settled. */
function awaitingUser(orch, chatId) {
  if (orch.unavailable || !orch.journal.child(chatId) || orch.journal.child(chatId).detached) return;
  orch.awaitingSince.set(chatId, orch.o.now());
  settleIn(orch, chatId, SETTLE_MS);
}

/** Check `chatId`'s parent's wake in `ms`; a timer that fires before the request has settled waits the rest. */
function settleIn(orch, chatId, ms) {
  clock.clearTimeout(orch.settleTimers.get(chatId));
  const timer = clock.setTimeout(() => {
    orch.settleTimers.delete(chatId);
    // timers may fire a little before the clock says the time is up: wait out the rest
    if (unsettled(orch, chatId)) return settleIn(orch, chatId, SETTLE_MS - (orch.o.now() - orch.awaitingSince.get(chatId)));
    const to = liveParentOf(orch.journal, chatId, orch.archived);
    if (to) orch.maybeWake(to.parentId);
  }, ms);
  timer.unref?.();
  orch.settleTimers.set(chatId, timer);
}

/** Whether `id` waits on the user with a request too new to count as settled (it still holds its parent's wake). */
function unsettled(orch, id) {
  const since = orch.awaitingSince.get(id);
  return since !== undefined && orch.o.now() - since < SETTLE_MS;
}

/** What `id` is doing as its parent's wake sees it: a request newer than SETTLE_MS counts as working. */
function wakeWord(orch, id) {
  const word = stateWord(orch.o.controller, orch.journal, id);
  return word === 'needs the user' && unsettled(orch, id) ? 'working' : word;
}

/** A chat is gone: its settle timer goes with it. */
function forgetAwaiting(orch, chatId) {
  clock.clearTimeout(orch.settleTimers.get(chatId));
  orch.settleTimers.delete(chatId);
  orch.awaitingSince.delete(chatId);
}

/**
 * Whether a linked session's finished turn left the user something to answer: a question in its wrap-up, or a request
 * still open after the turn (CD's "and then reported that it was waiting on the user").
 * @param {any} orch @param {string} childId @param {string | null} inputToken
 */
function waitsOnUser(orch, childId, inputToken) {
  const w = orch.journal.data.wrapUps[childId];
  return (!!w?.ask && !!inputToken && w.turn === inputToken) || orch.o.controller.state.get(childId).approvals.length > 0;
}

module.exports = { noteDriven, reportersOf, awaitingUser, unsettled, wakeWord, forgetAwaiting, waitsOnUser, SETTLE_MS };
