// The one clamp every panel sharing a lane with the chat uses, so the conversation keeps a readable width.

/** The chat column never gets narrower than this beside a panel while the lane has room (Claude Desktop keeps ~440-480). */
export const CHAT_MIN_WIDTH = 440;
/** A side pane (browser, changes, files, terminal, side chat) never gets narrower than this while the lane has room. */
export const PANE_MIN_WIDTH = 400;
/** The summary island's footprint beside the chat: --summary-w (src/styles/tokens.css) plus its 8px right margin. */
export const SUMMARY_SLOT_WIDTH = 308;
/** The app's chrome outside the frame card's lanes: none, as the sidebar and the main column fill the window. */
export const SHELL_WIDTH = 0;

/**
 * The size of a panel that shares `lane` with the chat: `want` held within [min, max] and to what leaves the chat
 * `keep`. A lane too small for both minimums is split in proportion to them, so neither collapses to a sliver.
 * An unmeasured lane (zero, negative or not a number) keeps `want`; a `want` that is not a number asks for `min`.
 */
export function clampSplit(want: number, lane: number, { min, keep, max = Infinity }: { min: number; keep: number; max?: number }) {
  const asked = Number.isFinite(want) ? want : min;
  if (!(lane > 0)) return Math.round(asked);
  if (lane < min + keep) return Math.round((lane * min) / (min + keep));
  return Math.round(Math.min(lane - keep, max, Math.max(min, asked)));
}
