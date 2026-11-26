// The app's side of scheduled tasks a machine fires itself (#2709 phase 2): each machine that keeps schedules is sent the tasks that run there on an agent signed in on it, the Mac stops firing those, and the runs the machine fired while the Mac was away are adopted (their chats listed and followed, their times in the task's history).
const { machineOf, machineHarnessOf } = require('../../shared/scheduleTask.mjs');
const { readJsonRecord, writeAtomic } = require('../platform/fsutil.cjs');

/**
 * @typedef {{ seq: number, taskId: string, scheduledFor: number, status: 'started' | 'failed' | 'skipped' | 'needs-approval', harness: string, cwd: string, chatId?: string, reason?: string, projectId?: string }} HostRun
 * @typedef {{ held: string[], cursor: number, store?: string }} Kept what one machine holds of this app's tasks, and how far its runs were read (in the numbering its store names)
 */

/**
 * @param {object} o
 * @param {string} o.file where what each machine holds and the run cursors are kept
 * @param {() => Promise<any[]>} o.tasks every scheduled task (AutomationStore.list's)
 * @param {(hostId: string) => any} o.hostFor the machine's remote Host (scheduleSync, scheduleRuns, state), or null
 * @param {(hostId: string) => any} o.rowOf the machine's registry row (its harnesses: detected, signedIn), or null
 * @param {(taskId: string) => Promise<number>} o.handled the latest time this Mac already handled for a task (the run ledger's)
 * @param {(hostId: string, run: HostRun) => Promise<void>} o.adopt one run the machine fired: its chat listed and followed, its time recorded
 * @param {() => string} [o.zone] the time zone a task's times are read on (this Mac's)
 * @param {() => number} [o.now]
 * @param {(error: Error) => void} o.report
 */
function createHostSchedules({
  file,
  tasks,
  hostFor,
  rowOf,
  handled,
  adopt,
  zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = Date.now,
  report,
}) {
  /** What each machine holds; a missing or unreadable file holds nothing until the machines are sent their sets again at startup. @type {Record<string, Kept>} */
  const kept = readJsonRecord(file, {});
  const save = () => writeAtomic(file, JSON.stringify(kept));
  /** One sync or read per machine at a time, in order. @type {Map<string, Promise<void>>} */
  const lanes = new Map();
  /** @param {string} hostId @param {() => Promise<void>} fn */
  const inLane = (hostId, fn) => {
    const next = (lanes.get(hostId) ?? Promise.resolve()).then(fn).catch((error) => report(/** @type {Error} */ (error)));
    lanes.set(hostId, next);
    return next;
  };

  /** Whether the machine runs this task itself: an agent signed in there (not one this Mac lends a key), for a machine task with a folder. @param {any} task */
  function eligible(task) {
    const hostId = machineOf(task);
    if (!hostId || !task.cwds?.[0] || !task.rrule) return false;
    const there = rowOf(hostId)?.harnesses?.find((/** @type {any} */ h) => h.id === machineHarnessOf(task));
    return !!there?.detected && there.signedIn === true;
  }

  /** Runs that could not be adopted, by machine and number, with how many times they were tried. @type {Map<string, number>} */
  const tries = new Map();

  /**
   * A task as the machine keeps it; it starts after the times this Mac already handled, and one the machine does not hold yet starts now, since this Mac may
   * be firing a time at this very moment: no time runs on both.
   * @param {any} task @param {Set<string>} held
   */
  async function wireOf(task, held) {
    const floor = held.has(String(task.id)) ? 0 : now();
    const from = Math.max(Number(task.schedule_from) || 0, (await handled(String(task.id))) + 1, floor);
    return {
      id: String(task.id),
      name: String(task.name ?? ''),
      rrule: String(task.rrule),
      zone: zone(),
      prompt: String(task.prompt ?? ''),
      harness: machineHarnessOf(task),
      cwd: String(task.cwds[0]),
      status: task.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
      scheduleFrom: from,
      // how the machine treats a card its run raises with nobody there (the task's own setting, as for a run on this Mac)
      onApproval: task.on_approval === 'skip' ? 'skip' : 'wait',
      ...(task.model ? { model: String(task.model) } : {}),
      ...(task.reasoning_effort ? { effort: String(task.reasoning_effort) } : {}),
      ...(typeof task.project_id === 'string' && task.project_id ? { projectId: task.project_id } : {}),
    };
  }

  /** The machine's runs since its cursor, adopted in order; the cursor moves past each one only once it is adopted. Only for a machine that holds tasks (kept[hostId] is set). @param {string} hostId @param {any} host */
  async function readRuns(hostId, host) {
    for (;;) {
      const at = kept[hostId].cursor;
      const { runs, next, store } = await host.scheduleRuns({ after: at });
      // the machine started a new store (its file was lost or reinstalled): its runs are numbered from the start again
      if (store !== kept[hostId].store) {
        const restart = kept[hostId].store !== undefined && at > 0;
        kept[hostId] = { ...kept[hostId], store, cursor: restart ? 0 : at };
        save();
        if (restart) continue;
      }
      for (const run of runs) {
        if (!(await adoptOnce(hostId, run))) return;
        kept[hostId] = { ...kept[hostId], cursor: run.seq };
        save();
      }
      if (!runs.length || next <= at) return;
    }
  }

  /** Adopt one run; one that keeps failing is reported and passed over after three tries, so it never holds up the runs after it. @param {string} hostId @param {HostRun} run */
  async function adoptOnce(hostId, run) {
    const key = `${hostId}#${run.seq}`;
    try {
      await adopt(hostId, run);
      tries.delete(key);
      return true;
    } catch (error) {
      const n = (tries.get(key) ?? 0) + 1;
      report(/** @type {Error} */ (error));
      if (n < 3) {
        tries.set(key, n);
        return false;
      }
      tries.delete(key);
      return true;
    }
  }

  /** Send the machine its whole set, then adopt what it ran. A machine that is away keeps what it last held (it fires those); one without schedules holds none. @param {string} hostId */
  function syncMachine(hostId) {
    return inLane(hostId, async () => {
      const host = hostFor(hostId);
      if (!host || host.state?.() !== 'online') return;
      const mine = (await tasks()).filter((t) => machineOf(t) === hostId && eligible(t));
      const wasHeld = new Set(kept[hostId]?.held ?? []);
      const wire = await Promise.all(mine.map((t) => wireOf(t, wasHeld)));
      try {
        await host.scheduleSync({ tasks: wire });
      } catch (error) {
        // an older Host keeps no schedules, and a Mac this one only controls (paired by code) keeps none of its tasks: this Mac fires them, as before
        const code = /** @type {any} */ (error)?.code;
        if (code === 'feature_missing' || (code === 'forbidden' && host.controlledByCode)) {
          delete kept[hostId];
          save();
          return;
        }
        throw error;
      }
      kept[hostId] = { ...kept[hostId], held: wire.map((t) => t.id), cursor: kept[hostId]?.cursor ?? 0 };
      save();
      await readRuns(hostId, host);
    });
  }

  return {
    /** Whether the machine fires this task itself (it holds it): the Mac's scheduler leaves it alone. @param {any} task */
    firedByMachine(task) {
      const hostId = machineOf(task);
      // a machine that left the list holds nothing here: this Mac fires the task, and its run says the machine is gone
      return !!hostId && !!kept[hostId]?.held.includes(String(task.id)) && !!rowOf(hostId);
    },
    syncMachine,
    /** Every machine a task runs on, or that holds one of them: after a task was saved, moved or deleted. */
    async syncAll() {
      const ids = new Set(Object.keys(kept));
      for (const t of await tasks()) {
        const hostId = machineOf(t);
        if (hostId) ids.add(hostId);
      }
      await Promise.all([...ids].map((id) => syncMachine(id)));
    },
    /** The runs of every machine that holds tasks, without sending anything (a periodic read while it answers). */
    async readAll() {
      await Promise.all(
        Object.keys(kept).map((hostId) =>
          inLane(hostId, async () => {
            const host = hostFor(hostId);
            if (host && host.state?.() === 'online') await readRuns(hostId, host);
          }),
        ),
      );
    },
  };
}

module.exports = { createHostSchedules };
