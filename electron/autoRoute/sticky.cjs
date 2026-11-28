// Auto's cache-aware step between the router's tier and the model a turn runs on: a stronger tier applies at once, a
// cheaper one only when the router asks for it twice in a row, so a chat does not drop its warm prompt cache for one turn.
const TIER_INDEX = { C0: 0, C1: 1, C2: 2, C3: 3 };

/**
 * The tier this turn runs on, and the pending downgrade it leaves for the next one.
 * @param {{ tier: string, down?: { tier: string, count: number } | null } | null} previous what the chat last ran and waits on
 * @param {string} proposed the router's tier for this turn
 * @param {{ failed?: boolean }} [o] failed: the last Auto turn failed or was stopped and sent again
 * @returns {{ tier: string, down: { tier: string, count: number } | null, held: boolean }} held: a cheaper tier waits
 */
function settleTier(previous, proposed, { failed = false } = {}) {
  if (!Object.hasOwn(TIER_INDEX, proposed)) throw new Error(`Unknown router tier ${JSON.stringify(proposed)}.`);
  if (!previous || !Object.hasOwn(TIER_INDEX, previous.tier)) return { tier: proposed, down: null, held: false };
  const before = TIER_INDEX[previous.tier];
  const after = TIER_INDEX[proposed];
  if (after >= before) return { tier: proposed, down: null, held: false };
  // a failed turn never earns a cheaper model for the retry
  if (failed) return { tier: previous.tier, down: null, held: true };
  // two tiers cheaper is a different kind of turn: no wait
  if (before - after >= 2) return { tier: proposed, down: null, held: false };
  const count = previous.down?.tier === proposed ? previous.down.count + 1 : 1;
  if (count >= 2) return { tier: proposed, down: null, held: false };
  return { tier: previous.tier, down: { tier: proposed, count }, held: true };
}

module.exports = { settleTier, TIER_INDEX };
