// The step lines of one add-machine run (electron/host/install.cjs): each starts and ends as an event with the phase it belongs to (1 of 6), the bytes of an upload, and a stalled flag after 30 s without a change; and the cancel that ends the run's ssh commands, which never stops the undo it asks for.
const { clock } = require('../platform/ports/clock.cjs');

/** Nothing moved for this long: the running step says so. */
const STALL_MS = 30_000;
const STALL_CHECK_MS = 5_000;
/** The six phases a person sees (Connecting, Checking sign-in, Copying Node, Copying MoPilot, Starting, Pairing) and the steps of each. */
const PHASES = {
  connect: 1,
  key: 2,
  detect: 2,
  node: 3,
  package: 4,
  prepare: 4,
  upload: 4,
  verify: 4,
  unpack: 4,
  unit: 5,
  trust: 5,
  daemon: 5,
  start: 5,
  linger: 5,
  status: 5,
  pair: 6,
};
const PHASE_COUNT = 6;

/** Steps whose command must run to its end once sent: a cancel waits for them and the run is undone from what they report (an aborted unpack, unit or start leaves the machine half-changed with nothing recorded). */
const UNBREAKABLE = new Set(['key', 'unpack', 'unit', 'trust', 'daemon', 'start', 'linger']);

/** @typedef {import('./install.cjs').Step} Step */

/**
 * @param {{ steps: Step[], listeners: Set<(s: Step) => void>, abort: AbortController, cancelled: boolean, timer: any }} entry the run
 */
function createSteps(entry) {
  const { steps, listeners } = entry;
  /** The running step, and when anything last moved. @type {Step | null} */
  let active = null;
  let lastMoved = clock.now();
  /** True while the run undoes what it made: a cancel must not stop that. */
  let rolling = false;

  /** Something moved: the step is not stalled, and the windows hear it. @param {Step} [step] */
  function moved(step = /** @type {Step} */ (active)) {
    lastMoved = clock.now();
    delete step.stalled;
    for (const fn of [...listeners]) fn({ ...step });
  }
  /** @param {string} stepId @param {string} label */
  const begin = (stepId, label) => {
    const step = /** @type {Step} */ ({ id: stepId, label, state: 'running', output: '' });
    const index = /** @type {Record<string, number>} */ (PHASES)[stepId];
    if (index) Object.assign(step, { index, total: PHASE_COUNT });
    steps.push(step);
    active = step;
    moved();
    return step;
  };
  /** @param {Step} step @param {Step['state']} state @param {string} output */
  const end = (step, state, output) => {
    step.state = state;
    step.output = output;
    moved(step);
  };
  /** What a step's upload reports its bytes to. @param {Step} step */
  const upload = (step) => (/** @type {number} */ done, /** @type {number} */ total) => {
    step.progress = { done, total };
    moved(step);
  };
  const watch = () => {
    entry.timer = clock.setTimeout(() => {
      if (active?.state === 'running' && !active.stalled && clock.now() - lastMoved >= STALL_MS) {
        active.stalled = true;
        for (const fn of [...listeners]) fn({ ...active });
      }
      watch();
    }, STALL_CHECK_MS);
  };
  watch();
  return {
    begin,
    end,
    moved,
    /** The step now running. */
    active: () => active,
    /** What a command is run with: the abort of a cancel, and the step its bytes go to. @param {Step | null} [step] */
    control: (step) =>
      rolling || UNBREAKABLE.has(/** @type {Step} */ (active).id)
        ? {}
        : { signal: entry.abort.signal, ...(step && { onBytes: upload(step) }) },
    /** Whether the run was cancelled and is not yet undoing. */
    cancelled: () => entry.cancelled && !rolling,
    /** From here on a cancel no longer stops commands. */
    rollback: () => {
      rolling = true;
    },
  };
}

module.exports = { createSteps };
