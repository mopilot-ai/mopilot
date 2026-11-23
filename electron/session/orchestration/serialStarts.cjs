// A parent's starts of linked sessions, one at a time (Orchestrator.serialized): each waits for the one before it,
// counts as in flight so the parent's wake waits for it, and the same call in one turn (its `key`) is answered once.
// A start the user clicked runs beside the others (queue: false), still counted in flight: Start all on several
// proposals makes their worktrees and starts their harnesses side by side rather than one after another.

const { rootOf } = require('./family.cjs');
const { cleanupSharedNotes } = require('./childSetup.cjs');

/**
 * Run a start for `parentId` after the ones before it, counted as in flight so the parent's wake waits for it.
 * With a `key`, the same call in one turn returns the first's result; a failed one may be tried again. With `queue`
 * false it starts now, neither waiting for the starts before it nor holding up the ones after it.
 * @param {any} orch the Orchestrator: its `serial`, `starting` and `recent` maps, `o.defer` and `maybeWake`
 * @param {string} parentId
 * @param {string | null} key
 * @param {() => Promise<any>} run
 * @param {{ queue?: boolean }} [opts]
 */
function serialized(orch, parentId, key, run, { queue = true } = {}) {
  const previous = key ? orch.recent.get(key) : null;
  if (previous) return previous;
  const notesRoot = rootOf(orch.journal, parentId);
  orch.starting.set(parentId, (orch.starting.get(parentId) ?? 0) + 1);
  // the next start of this parent waits for this one to settle, whatever its outcome: its caller has that
  const previousTurn = queue ? (orch.serial.get(parentId) ?? Promise.resolve()) : Promise.resolve();
  /** @type {((value?: unknown) => void)[]} */
  const release = [];
  if (queue) orch.serial.set(parentId, new Promise((resolve) => release.push(resolve)));
  const settled = previousTurn.then(run).finally(() => {
    release[0]?.();
    const left = Number(orch.starting.get(parentId)) - 1;
    if (left > 0) orch.starting.set(parentId, left);
    else orch.starting.delete(parentId);
    void cleanupSharedNotes(orch, notesRoot);
    orch.o.defer(() => orch.maybeWake(parentId));
  });
  if (!key) return settled;
  orch.recent.set(key, settled);
  settled.catch(() => orch.recent.delete(key));
  if (orch.recent.size > 200) orch.recent.delete(orch.recent.keys().next().value);
  return settled;
}

module.exports = { serialized };
