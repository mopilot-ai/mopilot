// The common gate a receiving chat passes before a peer message is delivered: deleted, archived, running elsewhere, crashed or goal paused.

/**
 * Common receiving-chat gate. Native account, admission and protocol checks belong to adapters.
 * `goalStatus` is main's record of the chat's goal (SessionStore goalStatus), not a window's report of it.
 * `remote` is the controller's route to other machines: a chat it owns runs on another machine, which takes no message from here yet (#4738).
 */
function createPeerGate({ record, state, ref, availability, goalStatus, remote }) {
  return async (id) => {
    const chat = record(id);
    if (!chat) return 'chat_deleted';
    if (chat.meta?.archived != null) return 'chat_archived';
    const live = state(id);
    if (live.runningElsewhere || remote?.owns(id) === true) return 'running_elsewhere';
    if (live.turn === 'crashed') return 'harness_crashed';
    // a window's report of the goal lags, and is missing with no window open (#2759)
    const goal = goalStatus(id);
    if (goal === 'paused' || goal === 'budgetLimited') return 'target_goal_paused';
    const reason = (await availability(ref(id), chat)) ?? null;
    // the kill switch says why in a sentence; the journal keeps a code the windows have a line for (shared/peerReasons.mjs)
    return reason && !/^[a-z]+(?:_[a-z]+)*$/.test(reason) ? 'harness_turned_off' : reason;
  };
}
module.exports = { createPeerGate };
