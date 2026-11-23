// A chat's assistant replies: turns cut to their agentMessage items, as a prose-only reader (a PR badge) needs them.

/**
 * Every turn kept (so per-segment turn counts still slice a switched chat's history), with only its agentMessage items.
 * @param {readonly any[]} turns a chat's turns
 * @returns {any[]}
 */
export function proseTurns(turns) {
  return turns.map((turn) => ({
    ...turn,
    items: (Array.isArray(turn.items) ? turn.items : []).filter((item) => item?.type === 'agentMessage'),
  }));
}

/**
 * The finished turns' replies.
 * @param {readonly any[]} turns
 * @returns {any[]}
 */
export const assistantReplies = (turns) => proseTurns(turns.filter((turn) => turn.status === 'completed'));
