// The scheduled tasks this Host keeps and fires itself (#2709 phase 2): the app sends its whole set for this machine (`host.scheduleSync`), each task's latest due time runs once here, on the agent's own sign-in, whether or not any app is connected, and every run is recorded for the app to adopt when it is back (`host.scheduleRuns`).
import crypto from 'node:crypto';
import path from 'node:path';
import { createMapFile } from './mapFile.mjs';
import { CATCH_UP_MS } from '../../shared/schedule.mjs';
import { MAX_RUNS } from '../../shared/host/hostSchedules.mjs';
import { appIdPrefix, hostChatId } from '../../shared/host/chatIds.mjs';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';

/** How many runs the Host keeps for an app that is away. */
const KEPT_RUNS = 500;
/** How often due times are checked. */
const TICK_MS = 30_000;

/**
 * @typedef {import('../../shared/host/hostSchedules.mjs').WireTask} WireTask
 * @typedef {{ seq: number, taskId: string, scheduledFor: number, status: 'started' | 'failed' | 'skipped' | 'needs-approval', harness: string, cwd: string, at: number, chatId?: string, reason?: string, projectId?: string }} Run
 */

/**
 * @param {object} o
 * @param {string} o.file where the tasks, the times already handled and the runs are kept
 * @param {{ lastRun: (rule: string, at: number, zone?: string) => number | null, nextRun: (rule: string, after?: Date, zone?: string) => Date | null }} o.rules the rule reader (shared/schedule.mjs scheduleRules)
 * @param {(p: { chatId: string, task: WireTask }) => Promise<unknown>} o.start starts the run's chat here with the task's prompt (the protocol's chat.start)
 * @param {(harness: string) => Promise<{ ok: true } | { ok: false, reason: string }>} o.ready whether the agent can run here on its own sign-in, and why not
 * @param {(chatId: string) => boolean} [o.busy] whether a chat still has a turn running (the task's previous run)
 * @param {(chatId: string) => string} [o.mintChatId] a new chat id on this Host for the agent (tests pass their own)
 * @param {() => number} [o.now]
 * @param {(problem: string) => void} o.report
 * @param {{ note: (e: any) => void }} [o.audit] a run's start, failure or skip is noted (the audit record's `schedule.run`)
 */
export function createHostSchedules({ file, rules, start, ready, busy = () => false, mintChatId, now = Date.now, report, audit }) {
  const store = createMapFile(file, {
    valid: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
    kind: 'schedules',
    unreadable: (f) => new Error(`The schedules file ${f} could not be read.`),
    report,
  });
  /**
   * `store` names this file's run numbering (a new one when it starts empty), so an app that read runs of an earlier file reads this one from the start;
   * `pending` is the run being started now, saved with its claim, so a Host that stops mid-start records it as interrupted when it is back.
   * @type {{ tasks: WireTask[], fired: Record<string, number>, runs: Run[], seq: number, last: Record<string, string>, store: string, pending: (Omit<Run, 'seq' | 'at' | 'status'> & { chatId: string }) | null }}
   */
  let state = { tasks: [], fired: {}, runs: [], seq: 0, last: {}, store: crypto.randomUUID(), pending: null };
  try {
    const m = store.load();
    state = {
      tasks: Array.isArray(m.get('tasks')) ? m.get('tasks') : [],
      fired: m.get('fired') ?? {},
      runs: Array.isArray(m.get('runs')) ? m.get('runs') : [],
      seq: Number.isSafeInteger(m.get('seq')) ? m.get('seq') : 0,
      last: m.get('last') ?? {},
      store: typeof m.get('store') === 'string' ? m.get('store') : crypto.randomUUID(),
      pending: m.get('pending') ?? null,
    };
  } catch (error) {
    // an unreadable file keeps nothing: the app sends its set again when it connects
    report(String(/** @type {Error} */ (error).message));
  }
  const save = () => store.save(new Map(Object.entries(state)));
  /** Chats a `skip` run stopped at an approval before the run was recorded as started. @type {Set<string>} */
  const wants = new Set();
  // a run whose start this Host did not see finish (it stopped mid-start): its chat may exist there, so it is told, never lost
  if (state.pending) {
    const { pending } = state;
    state.pending = null;
    record({ ...pending, status: 'failed', reason: 'The machine restarted while starting this run.' });
  }

  /** @param {Omit<Run, 'seq' | 'at'>} run */
  function record(run) {
    state.seq += 1;
    state.runs.push({ ...run, seq: state.seq, at: now() });
    if (state.runs.length > KEPT_RUNS) state.runs.splice(0, state.runs.length - KEPT_RUNS);
    if (run.chatId) state.last[run.taskId] = run.chatId;
    audit?.note({ kind: 'schedule.run', chat: run.chatId, harness: run.harness, what: { status: run.status, taskId: run.taskId } });
    save();
  }

  /** One task at one check: its latest due time runs once, unless it is too old, the previous run still works, or the agent can't run here. @param {WireTask} task @param {number} at */
  async function consider(task, at) {
    if (task.status !== 'ACTIVE') return;
    const due = rules.lastRun(task.rrule, at, task.zone);
    const before = state.fired[task.id];
    if (due === null || due < task.scheduleFrom || due <= (before ?? 0)) return;
    // claimed before anything runs, so a time runs at most once, across a restart too
    state.fired[task.id] = due;
    save();
    // the folder and project travel with the run: the app that adopts its chat lists it where the task's chats go
    const base = {
      taskId: task.id,
      scheduledFor: due,
      harness: task.harness,
      cwd: task.cwd,
      ...(task.projectId ? { projectId: task.projectId } : {}),
    };
    if (at - due > CATCH_UP_MS) return record({ ...base, status: 'skipped', reason: 'missed' });
    const previous = state.last[task.id];
    if (previous && busy(previous)) return record({ ...base, status: 'skipped', reason: 'previous-running' });
    const can = await ready(task.harness);
    // the app's set may have changed while readiness was checked: only the same, still active task starts; one removed, paused or revised gives its claim
    // back, so the task as it is now (checked next, after the sync that changed it) can still run this time
    const current = state.tasks.find((t) => t.id === task.id);
    if (!sameTask(current, task)) {
      // checks run one at a time (tick), so nothing else claimed this task's time meanwhile
      if (before === undefined) delete state.fired[task.id];
      else state.fired[task.id] = before;
      save();
      return;
    }
    if (!can.ok) return record({ ...base, status: 'failed', reason: can.reason });
    const chatId = (mintChatId ?? defaultChatId)(task.harness);
    state.pending = { ...base, chatId };
    save();
    try {
      await start({ chatId, task });
      state.pending = null;
      record({ ...base, status: 'started', chatId });
      // a card the run raised before its start was recorded: the run still ends as needing approval
      if (wants.delete(chatId)) record({ ...base, status: 'needs-approval', chatId });
    } catch (error) {
      state.pending = null;
      record({ ...base, status: 'failed', chatId, reason: String(/** @type {Error} */ (error)?.message ?? error) });
    }
  }

  let checking = Promise.resolve();
  /** Every task's due time, one check at a time (a check never overlaps another). */
  function tick() {
    checking = checking.then(async () => {
      const at = now();
      for (const { id } of [...state.tasks]) {
        // each task as it is when its turn comes: an earlier task's wait may have let a sync replace it
        const task = state.tasks.find((t) => t.id === id);
        if (!task) continue;
        try {
          await consider(task, at);
        } catch (error) {
          report(`scheduled task ${task.id}: ${String(/** @type {Error} */ (error)?.message ?? error)}`);
        }
      }
    });
    return checking;
  }

  return {
    /** The app's whole set for this machine replaces what was kept; a time already handled stays handled, also for a task that leaves and comes back. @param {WireTask[]} tasks */
    sync(tasks) {
      state.tasks = tasks;
      save();
      void tick();
      return { held: tasks.length };
    },
    /** The runs after cursor `after`, oldest first, and the cursor to ask from next. @param {number} after */
    runs(after) {
      const runs = state.runs.filter((r) => r.seq > after).slice(0, MAX_RUNS);
      return { runs, next: runs.at(-1)?.seq ?? Math.max(after, state.seq), store: state.store };
    },
    /**
     * A `skip` run stopped at a card that needs a person: its run ends as `needs-approval`, and the app shows that in the task's history.
     * @param {string} chatId
     */
    needsApproval(chatId) {
      const run = state.runs.findLast((r) => r.chatId === chatId && r.status === 'started');
      if (!run) return void wants.add(chatId);
      const { seq: _seq, at: _at, status: _status, ...base } = run;
      record({ ...base, status: 'needs-approval' });
    },
    tick,
    /** When the next task is due, or null: a cloud machine does not stop itself just before one. */
    nextAt() {
      const at = new Date(now());
      const times = state.tasks.map((t) => rules.nextRun(t.rrule, at, t.zone)?.getTime() ?? null).filter((t) => t !== null);
      return times.length ? Math.min(...times) : null;
    },
    /** Checks now and on an interval until stopped; the interval never keeps the process alive. @returns {() => void} */
    start() {
      void tick();
      const timer = setInterval(() => void tick(), TICK_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** Whether a task is still the revision a check started with (wire tasks are built in one field order: shared/host/hostSchedules.mjs wireTaskOf). @param {WireTask | undefined} now @param {WireTask} was */
const sameTask = (now, was) => !!now && JSON.stringify(now) === JSON.stringify(was);

/** A new chat id on this Host for the agent, as the app would mint it and the Host names it (shared/host/chatIds.mjs). @param {string} harness */
const defaultChatId = (harness) => hostChatId(`${appIdPrefix(harness)}${crypto.randomUUID()}`);

/**
 * Whether an agent can run a fired task here on its own sign-in: installed and signed in on this machine. A key the app lent lives only while the app lends
 * it, so a run nobody is there for never counts on one.
 * @param {() => Promise<{ id: string, detected: boolean, signedIn: boolean }[]>} harnesses what this Host reports (its own sign-ins)
 */
export function readyOnOwnSignIn(harnesses) {
  return async (/** @type {string} */ id) => {
    const h = (await harnesses()).find((x) => x.id === id);
    if (!h?.detected) return { ok: /** @type {const} */ (false), reason: `${agentLabel(id)} isn't installed on this machine.` };
    if (!h.signedIn) return { ok: /** @type {const} */ (false), reason: `${agentLabel(id)} isn't signed in on this machine.` };
    return { ok: /** @type {const} */ (true) };
  };
}

/**
 * This Host's scheduled tasks as the CLI makes them: kept in its data folder, read on rrule's rules, started through the protocol, run on each agent's own sign-in,
 * and a task's previous run counted as working while its chat's turn runs.
 * @param {object} o
 * @param {string} o.dataDir
 * @param {{ lastRun: (rule: string, at: number, zone?: string) => number | null, nextRun: (rule: string, after?: Date, zone?: string) => Date | null }} o.rules
 * @param {{ startScheduled: (p: { chatId: string, task: WireTask }) => unknown, awaiting?: (chatId: string) => boolean }} o.protocol
 * @param {() => Promise<{ id: string, detected: boolean, signedIn: boolean }[]>} o.harnesses
 * @param {{ has: (id: string) => boolean, get: (id: string) => { turn?: string } }} o.state the sessions' state
 * @param {(problem: string) => void} o.report
 * @param {{ note: (e: any) => void }} [o.audit]
 */
export function hostSchedulesFor({ dataDir, rules, protocol, harnesses, state, report, audit }) {
  return createHostSchedules({
    file: path.join(dataDir, 'schedules.json'),
    rules,
    start: async (p) => protocol.startScheduled(p),
    ready: readyOnOwnSignIn(harnesses),
    // a run stopped on a card is still working (its turn waits for a person), so the next due time does not start another beside it
    busy: (chatId) =>
      (state.has(chatId) && ['running', 'awaitingUser'].includes(state.get(chatId).turn ?? '')) || protocol.awaiting?.(chatId) === true,
    report,
    audit,
  });
}
