// When Global Auto moves a chat to another harness: on its first turn to the best-scoring one, later only when another
// harness leads by a clear margin for two turns in a row (or the current one keeps failing), and never twice in a row.
/** How far ahead another harness must score before a chat's first turn moves it (advantage over the benchmark average). */
const FIRST_MARGIN = 0.02;
/** How far ahead another harness must score before a running chat moves. */
const SWITCH_MARGIN = 0.06;
/** How many turns in a row that lead must hold. */
const LEAD_TURNS = 2;
/** How many turns a chat stays on a harness Global Auto moved it to before it may move again. */
const COOLDOWN_TURNS = 4;
/** How many failed turns in a row let a chat move on any lead, past the margin. */
const FAILURE_TURNS = 2;

/**
 * @param {object} o
 * @param {number} o.turns the chat's Auto turns so far (0: its first)
 * @param {string} o.current the chat's harness now
 * @param {{ kind: string, score: number }[]} o.scores highest first
 * @param {{ kind: string, count: number } | null} o.lead another harness's lead over the turns before
 * @param {number | null} o.lastSwitch the turn Global Auto last moved the chat on
 * @param {number} [o.failures] failed turns in a row
 * @returns {{ target: string | null, lead: { kind: string, count: number } | null, reason: string }}
 */
function decideHarness({ turns, current, scores, lead, lastSwitch, failures = 0 }) {
  const best = scores[0];
  if (!best) return { target: null, lead: null, reason: 'No harness here has published results to compare.' };
  const mine = scores.find((s) => s.kind === current) ?? null;
  if (best.kind === current) return { target: null, lead: null, reason: `${current} scores best for this request.` };
  const margin = mine ? best.score - mine.score : Number.POSITIVE_INFINITY;
  if (turns === 0)
    return margin >= FIRST_MARGIN
      ? { target: best.kind, lead: null, reason: `${best.kind} scores best for this request.` }
      : { target: null, lead: null, reason: `${current} stays: no harness scores clearly better for this request.` };
  const cooling = lastSwitch != null && turns - lastSwitch < COOLDOWN_TURNS;
  if (failures >= FAILURE_TURNS && margin > 0 && !cooling)
    return { target: best.kind, lead: null, reason: `${current} failed ${failures} turns in a row; ${best.kind} scores higher.` };
  if (margin < SWITCH_MARGIN) return { target: null, lead: null, reason: `${current} stays: no harness leads by a clear margin.` };
  const count = lead?.kind === best.kind ? lead.count + 1 : 1;
  if (count < LEAD_TURNS || cooling)
    return { target: null, lead: { kind: best.kind, count }, reason: `${current} stays: ${best.kind} leads, waiting to confirm.` };
  return { target: best.kind, lead: null, reason: `${best.kind} has scored clearly higher for ${count} turns.` };
}

module.exports = { decideHarness, FIRST_MARGIN, SWITCH_MARGIN, LEAD_TURNS, COOLDOWN_TURNS, FAILURE_TURNS };
