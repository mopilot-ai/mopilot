// A Codex Stop the turn has not acted on. The app-server either answers `turn/interrupt` and goes on (a turn whose model run has not begun takes it) or refuses it with "no active turn to interrupt" (a live Host trace: the Host sent it 9 ms after the turn was named, the app-server refused it, the model began streaming 2.2 s later and the turn ran to its end). Either way the Stop is not over: it is repeated, a little apart, while that turn is still the chat's running one, and said when it is given up.
const { clock } = require('../platform/ports/clock.cjs');
const { messageOf, noteIgnored } = require('../ignored.cjs');

/** How far apart a Stop the turn has not acted on is repeated, and how many times at most (about 20 s). */
const INTERRUPT_REPEAT_MS = 500;
const INTERRUPT_REPEATS = 40;

/** @typedef {{ state?: { get: (chatId: string) => { activeTurn?: { id?: unknown } | null } }, chatOf: (threadId: string) => string, stopLog: (line: string) => void, emit: (e: object, target?: string) => unknown, stopChains?: Set<string> }} Watched */

/**
 * Repeat `turn/interrupt` until the turn ends, is replaced by the next turn, or the repeats run out; at the end of them the Stop is said (the log, and a toast where a window shows one). One chain per turn: a second Stop while one is pending adds none.
 * @param {Watched} adapter
 * @param {{ threadId: string, turnId: string }} params
 * @param {() => Promise<unknown>} send one interrupt
 */
function repeatInterrupt(adapter, params, send) {
  const key = `${params.threadId}\n${params.turnId}`;
  const chains = (adapter.stopChains ??= new Set());
  if (chains.has(key)) return;
  chains.add(key);
  const at = `[codex-stop] chat=${adapter.chatOf(params.threadId)} thread=${params.threadId} turn=${params.turnId}`;
  const running = () => adapter.state?.get(adapter.chatOf(params.threadId))?.activeTurn?.id === params.turnId;
  const step = (/** @type {number} */ left) => {
    const timer = clock.setTimeout(() => {
      const repeats = INTERRUPT_REPEATS - left;
      if (!running()) {
        chains.delete(key);
        return adapter.stopLog(`${at} is no longer the running turn (ended or replaced) after ${repeats} repeat(s)`);
      }
      void (async () => {
        /** @type {string | null} */
        let refused = null;
        try {
          adapter.stopLog(`${at} repeat ${repeats + 1} sent`);
          await send();
          adapter.stopLog(`${at} repeat ${repeats + 1} answered`);
        } catch (e) {
          refused = messageOf(e).slice(0, 120);
          adapter.stopLog(`${at} repeat ${repeats + 1} refused: ${refused}`);
          noteIgnored('repeat a Codex Stop the turn has not acted on', e);
        }
        if (left > 1) return step(left - 1);
        chains.delete(key);
        if (!running()) return;
        adapter.stopLog(
          `${at} still running after ${INTERRUPT_REPEATS} repeats: giving up${refused ? ` (the last answer: ${refused})` : ''}`,
        );
        adapter.emit({ kind: 'toast', level: 'error', text: `Couldn't stop the turn${refused ? `: ${refused}` : ''}` }, 'any');
      })();
    }, INTERRUPT_REPEAT_MS);
    timer.unref?.();
  };
  step(INTERRUPT_REPEATS);
}

/**
 * One interrupt, logged, and then watched: whether the app-server answers it or refuses it, a turn that is still running is interrupted again. A refusal is rethrown to the caller.
 * @template T
 * @param {Watched} adapter @param {{ threadId: string, turnId: string }} params @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
async function interruptAndWatch(adapter, params, send) {
  const at = `[codex-stop] chat=${adapter.chatOf(params.threadId)} thread=${params.threadId} turn=${params.turnId}`;
  adapter.stopLog(`${at} interrupt sent`);
  try {
    const result = await send();
    adapter.stopLog(`${at} interrupt answered by the app-server`);
    repeatInterrupt(adapter, params, send);
    return result;
  } catch (e) {
    adapter.stopLog(`${at} interrupt refused: ${messageOf(e).slice(0, 120)}`);
    repeatInterrupt(adapter, params, send);
    throw e;
  }
}

module.exports = { interruptAndWatch, repeatInterrupt, INTERRUPT_REPEAT_MS, INTERRUPT_REPEATS };
