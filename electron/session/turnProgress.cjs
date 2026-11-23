// When a chat's running turn last made progress, as main sees every harness's events (#1534, #1511): SessionState
// `progressAt`, so a window opened mid-turn (or none at all) measures a quiet turn from the same time as one that
// watched it (src/lib/turnStall.ts). Kept coarse: a streaming reply publishes one patch every few seconds, not per delta.
const { clock } = require('../platform/ports/clock.cjs');

/** progressAt moves at most this often; the quiet-turn notes come at 20 s and 60 s. */
const PROGRESS_STEP_MS = 5000;

/** A Codex app-server notification that is its turn moving: an item or the turn itself. */
const codexProgress = (method) => typeof method === 'string' && (method.startsWith('item/') || method.startsWith('turn/'));

/** A Claude Code message that is its turn moving: anything but the CLI's own retry of a failing request (the retry banner says that). */
const claudeProgress = (m) => !!m && !(m.type === 'system' && m.subtype === 'api_retry');

/**
 * Something about the chat's running turn arrived at `now`. Returns whether progressAt moved.
 * @param {InstanceType<typeof import('./state.cjs').SessionStore>} state
 * @param {string} chatId
 */
function noteTurnProgress(state, chatId, now = clock.now()) {
  if (!state.running(chatId)) return false;
  const prev = state.get(chatId).progressAt;
  // a clock that went back is a new time, not an old one
  if (prev != null && now >= prev && now - prev < PROGRESS_STEP_MS) return false;
  return state.patch(chatId, { progressAt: now });
}

module.exports = { noteTurnProgress, codexProgress, claudeProgress, PROGRESS_STEP_MS };
