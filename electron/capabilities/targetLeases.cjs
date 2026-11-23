// TargetLeases (docs/control-plane/design.md): every target an agent holds is a lease keyed by the MoPilot chat id - the
// in-app browser's pane tabs, Your Chrome's tab group, the user's Chrome tabs over MoPilot's extension or relay
// (chromeTab), the desktop lock and app locks - whichever harness (Claude Code,
// Codex native or managed, ACP) or segment took it. Agent-opened tabs are temporary and the user's persistent; a mark
// given during the turn (handoff, deliverable) decides at the turn end whether a tab is kept, released or closed
// (leaseOutcome); Chrome's chat-lifetime group instead keeps every tab and releases control. The turn end sweeps each surface
// and bounded, so one that hangs neither holds the others nor the chat's later turn ends; a switch's handoff record
// lists what the chat holds (held), so the next harness knows about it.
const { noteIgnored } = require('../ignored.cjs');

/**
 * How long one surface may take to let go at a turn end before the turn end stops waiting for it. Longer than each
 * surface's own bound (the pane's TURN_END_MS, the desktop's two seconds), so a chat's turn ends still run one after
 * another and the bound only cuts off a surface that hangs.
 */
const RELEASE_MS = 6_000;

/**
 * @typedef {{ surface: 'iab' | 'chrome' | 'chromeTab' | 'desktop' | 'app', id: string, origin: 'agent' | 'user',
 *             openedBy?: 'agent' | 'user', mark?: 'handoff' | 'deliverable' | null, takenOver?: boolean,
 *             userTook?: boolean, held?: boolean, site?: string | null, label?: string, popup?: boolean, hostId?: string }} Lease
 *   one target the chat holds: `origin` whether it is the agent's this turn (the turn end decides by it) and
 *   `openedBy` who opened it in any turn, `takenOver` the user took it over this turn and `userTook` has it now,
 *   `held` whether the agent controls it right now, `site` a tab's origin (never its path or query), `label` an app's name
 */

/**
 * What a turn end does with a target: 'keep' a hand-off (it stays the chat's, for the user to continue in),
 * 'release' a deliverable, the user's own target or one the user took over (it stays open, no longer
 * controlled), 'close' one the agent opened and nobody marked.
 * @param {{ origin: 'agent' | 'user', mark?: string | null, takenOver?: boolean }} lease
 * @returns {'keep' | 'release' | 'close'}
 */
function leaseOutcome({ origin, mark = null, takenOver = false }) {
  if (mark === 'handoff') return 'keep';
  if (mark === 'deliverable' || takenOver || origin !== 'agent') return 'release';
  return 'close';
}

/**
 * Resolves once `work` settles or after `ms`, whichever is first; never rejects.
 * @param {() => unknown} work
 * @param {number} ms
 * @param {string} what for the note when it fails or times out
 */
function bounded(work, ms, what) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      noteIgnored(what, new Error(`still letting go after ${ms} ms`));
      resolve(undefined);
    }, ms);
    timer.unref?.();
  });
  const done = Promise.resolve()
    .then(work)
    .catch((error) => noteIgnored(what, error));
  return Promise.race([done, late]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {{ name: string, leases?: (chatId: string) => Lease[] | null | undefined,
 *             turnEnded?: (chatId: string) => unknown }} Surface
 */
class TargetLeases {
  /**
   * @param {{ surfaces: Surface[], releaseMs?: number }} o each surface reads its own leases of a chat and lets go of
   *   them at the chat's turn end (closing, keeping or releasing each by leaseOutcome)
   */
  constructor({ surfaces, releaseMs = RELEASE_MS }) {
    this.surfaces = surfaces;
    this.releaseMs = releaseMs;
    /** The turn-end steps (turnEnd.cjs turnLedger): one per surface, each bounded and isolated from the others. */
    this.steps = surfaces.map(
      (s) => (/** @type {string} */ chatId) =>
        bounded(() => s.turnEnded?.(chatId), this.releaseMs, `let go of ${s.name} at the end of a turn`),
    );
  }

  /**
   * Every target the chat holds, on every surface. A surface that cannot say lists nothing.
   * @param {string | null | undefined} chatId
   * @returns {Lease[]}
   */
  held(chatId) {
    if (!chatId) return [];
    return this.surfaces.flatMap((s) => {
      try {
        return s.leases?.(chatId) ?? [];
      } catch (error) {
        noteIgnored(`list the ${s.name} targets a chat holds`, error);
        return [];
      }
    });
  }
}

module.exports = { TargetLeases, leaseOutcome, RELEASE_MS };
