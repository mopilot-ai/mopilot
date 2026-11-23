// A Codex thread before its first user message (#2276): Codex keeps nothing of it on disk (no rollout) until a
// turn/start records that message, so before then it has no turns to list, takes no memory mode, and is gone once
// unloaded. The adapter tracks the threads it started that no turn has recorded yet (CodexAdapter.unrecorded).

/** Codex's answer for a thread it hasn't recorded: "… is not materialized yet …" or "no rollout found for thread id …". */
const UNRECORDED = /\bnot materialized yet\b|\bno rollout found\b/i;
/**
 * thread/turns/list's answer before the first user message, or for an ephemeral thread (a side chat: Codex keeps no turns of it to list, so a
 * phone that follows one is shown an empty chat, #5202); a missing rollout alone is a lost thread, not an empty one.
 */
const NOT_MATERIALIZED = /\bnot materialized yet\b|\bephemeral threads do not support thread\/turns\/list\b/i;

const text = (e) => String(e?.message ?? e);

/** The error says Codex hasn't recorded the thread yet. */
const unrecordedError = (e) => UNRECORDED.test(text(e));

/** A thread/turns/list page for a thread with no user message yet, or an ephemeral one: no turns, and nothing before or after them. */
const emptyTurns = () => ({ data: [], nextCursor: null, backwardsCursor: null });

/**
 * A page of a thread's turns: an empty one when Codex says the thread has no user message yet or is ephemeral, which is a chat's empty
 * state, never an error. Any other failure stands.
 * @param {Promise<any>} listing the thread/turns/list request
 */
const turnsOrEmpty = (listing) =>
  listing.catch((e) => {
    if (NOT_MATERIALIZED.test(text(e))) return emptyTurns();
    throw e;
  });

module.exports = { unrecordedError, turnsOrEmpty };
