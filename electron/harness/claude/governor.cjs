// When idle Claude Code CLIs end (#1830, after Claude Desktop's CliGovernor): the idle reaper's limits, a cap on live CLIs
// that the least recently active idle one makes room under, and eviction of idle CLIs under memory pressure. Every rule
// ends only a CLI that may end (harness/claude/sessions.cjs retirable: no turn, card, side chat, background work or wake-up).
const { clock } = require('../../platform/ports/clock.cjs');
const os = require('node:os');

/** A CLI its chat sent to: kept warm this long after its last activity (Claude Desktop keeps it for the app's life). */
const IDLE_MS = 60 * 60_000;
/** A CLI started when its chat was opened that was never sent to (harness/claude/warm.cjs warm). */
const WARM_IDLE_MS = 10 * 60_000;
/**
 * An idle CLI whose Claude in Chrome group still holds the chat's pages is never ended sooner than any other (its group and
 * "for this session" permissions end with it): at least this long (#1403), and no eviction ends it.
 */
const CHROME_IDLE_MS = 30 * 60_000;
/** No CLI used within this long is ended to make room or under pressure (Claude Desktop's minVictimIdleMs). */
const MIN_VICTIM_IDLE_MS = 60_000;
/** Under warning-level pressure, CLIs idle this long end; under critical, every one past MIN_VICTIM_IDLE_MS, pages or not. */
const WARNING_IDLE_MS = 10 * 60_000;
/** CLIs only warmed (never sent to) kept at once: browsing chats starts no more than this many (#1830). */
const WARM_MAX = 2;
/** One sweep per pressure level per minute, as Claude Desktop's. */
const SWEEP_MS = 60_000;

/** Claude Desktop's cap: one CLI per 3 GB of memory, at least 6. */
const capFor = (/** @type {number} */ total) => Math.max(6, Math.floor(total / (3 * 1024 ** 3)));

/**
 * @param {object} o
 * @param {() => Map<string, any>} o.sessions the live CLIs by key
 * @param {(s: any, now: number) => boolean} o.retirable
 * @param {(key: string) => unknown} o.retire ends one gracefully (it leaves `sessions` at once)
 * @param {(s: any) => boolean} o.held whether the CLI carries a Remote Control link its user wants (ending it drops the link)
 * @param {number} [o.totalmem]
 * @param {() => number} [o.now]
 */
function createClaudeGovernor({ sessions, retirable, retire, held, totalmem = os.totalmem(), now = () => clock.now() }) {
  const cap = capFor(totalmem);
  const lastSweep = { warning: 0, critical: 0 };
  /** @type {(() => import('../../platform/memoryPressure.cjs').PressureLevel) | null} */
  let level = null;

  const idleLimit = (s) => (s.chrome?.holdsPages() ? Math.max(IDLE_MS, CHROME_IDLE_MS) : s.warmOnly ? WARM_IDLE_MS : IDLE_MS);

  /**
   * Idle CLIs that may end now, least recently active first. One answering a turn it woke itself for is left be, and so is
   * one whose Chrome group holds the chat's pages (ending it closes them) or that carries a Remote Control link its user
   * wants (ending it takes the link down until the chat is opened again), unless `pages` (critical pressure).
   */
  const victims = (minIdle, t = now(), { pages = false } = {}) =>
    [...sessions().values()]
      .filter((s) => retirable(s, t) && !s.woken && (pages || (!s.chrome?.holdsPages() && !held(s))) && t - s.lastActive >= minIdle)
      .sort((a, b) => a.lastActive - b.lastActive);

  /** The idle reaper's pass (every minute); a CLI with a wanted Remote Control link is never idle for it. */
  function reap(t = now()) {
    for (const s of [...sessions().values()]) if (retirable(s, t) && !held(s) && t - s.lastActive > idleLimit(s)) void retire(s.key);
  }

  /** Before a CLI starts: at the cap, the least recently active idle CLI ends to make room. A start is never refused. */
  function makeRoom() {
    if (sessions().size < cap) return null;
    const v = victims(MIN_VICTIM_IDLE_MS)[0];
    if (v) void retire(v.key);
    return v ? v.key : null;
  }

  /**
   * Whether a start no one waits on (warm on open) may run: no memory pressure, and room under the cap. Past WARM_MAX
   * CLIs only warmed, the least recently opened one ends first.
   */
  function mayWarm() {
    if (level?.()) return false;
    const t = now();
    const warmed = victims(0, t).filter((s) => s.warmOnly);
    for (const s of warmed.slice(0, Math.max(0, warmed.length - WARM_MAX + 1))) void retire(s.key);
    return sessions().size < cap || makeRoom() != null;
  }

  /** A pressure reading: idle CLIs end, least recently active first. @returns {number} how many */
  function onPressure(/** @type {import('../../platform/memoryPressure.cjs').PressureLevel} */ l) {
    if (!l) return 0;
    const t = now();
    if (t - lastSweep[l] < SWEEP_MS) return 0;
    lastSweep[l] = t;
    const ending = l === 'critical' ? victims(MIN_VICTIM_IDLE_MS, t, { pages: true }) : victims(WARNING_IDLE_MS, t);
    for (const s of ending) void retire(s.key);
    return ending.length;
  }

  /** Follow the system's pressure (electron/platform/memoryPressure.cjs). @returns {() => void} */
  function watch(/** @type {{ level: () => any, subscribe: (fn: (l: any) => void) => () => void }} */ pressure) {
    level = () => pressure.level();
    return pressure.subscribe(onPressure);
  }

  return { cap, idleLimit, victims, reap, makeRoom, mayWarm, onPressure, watch };
}

module.exports = { createClaudeGovernor, capFor, IDLE_MS, WARM_IDLE_MS, CHROME_IDLE_MS, MIN_VICTIM_IDLE_MS, WARNING_IDLE_MS, WARM_MAX };
