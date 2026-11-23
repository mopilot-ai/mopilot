// The wiring of scheduled tasks a machine fires itself (electron/host/hostSchedules.cjs) into the app's scheduler: the machine's Host, row and chat adoption from Host's IPC (live.machineChats), the run ledger, and the windows and notices a run of a machine is shown in like one this Mac started.
const path = require('node:path');
const { createHostSchedules } = require('../host/hostSchedules.cjs');
const { appChatId, isHostFamily } = require('../../shared/host/chatIds.mjs');
const { machineOf } = require('../../shared/scheduleTask.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long changes to tasks or machines settle before the machines are sent their sets again. */
const SETTLE_MS = 2000;
/** How often a machine that holds tasks is asked what it ran. */
const READ_MS = 60_000;

/**
 * @param {object} o
 * @param {any} o.live main's `live`: `machineChats` is set by Host's IPC (unset while Host is not wired)
 * @param {{ list: () => Promise<{ tasks: any[] }> }} o.store the scheduled tasks
 * @param {{ latest: (id: string) => Promise<number>, claim: (id: string, due: number, fields: object) => Promise<object | null>, update: (id: string, due: number, patch: object) => Promise<void> }} o.ledger the run ledger
 * @param {string} o.dir where the app keeps what each machine holds
 * @param {(e: object) => void} o.announce windows learn of a chat a run made (automations.cjs announceRunChat)
 * @param {(chatId: string | null, task: { id: string, name: string }, o?: { error?: string }) => void} o.notify the run's notice
 * @param {(e: { id: string }) => void} o.changed the Scheduled page reads the task again
 */
function wireHostSchedules({ live, store, ledger, dir, announce, notify, changed }) {
  const machines = () => live.machineChats;
  const service = createHostSchedules({
    file: path.join(dir, 'host-schedules.json'),
    tasks: async () => (await store.list()).tasks,
    hostFor: (id) => machines()?.hostFor(id) ?? null,
    // asked only once hostFor gave a machine, so Host is wired
    rowOf: (id) => machines().rowOf(id),
    handled: (id) => ledger.latest(id),
    adopt: async (hostId, run) => {
      // the chat the machine started is listed and followed here like one this Mac started there
      const chatId = run.chatId ? appChatId(run.chatId) : null;
      if (chatId) {
        await machines()?.adopt(chatId, { hostId, folder: run.cwd });
        announce({ harness: 'acp', chatId, cwd: run.cwd, worktreeOf: null, hostId, projectId: run.projectId ?? null });
      }
      const claimed = await ledger.claim(run.taskId, run.scheduledFor, {
        status: run.status,
        harness: isHostFamily(run.harness) ? run.harness : `acp:${run.harness}`,
        by: { machine: hostId },
        ...(run.reason ? { reason: run.reason } : {}),
        ...(chatId ? { chatId } : {}),
      });
      if (!claimed) {
        // the run was recorded when it started; that it stopped at a card that needs a person is told after
        if (run.status === 'needs-approval') {
          await ledger.update(run.taskId, run.scheduledFor, { status: 'needs-approval', reason: 'approval' });
          changed({ id: run.taskId });
        }
        return;
      }
      changed({ id: run.taskId });
      if (run.status === 'skipped') return;
      const task = (await store.list()).tasks.find((t) => String(t.id) === run.taskId);
      notify(
        chatId,
        { id: run.taskId, name: String(task?.name ?? run.taskId) },
        run.status === 'failed' ? { error: String(run.reason ?? '') } : {},
      );
    },
    report: (error) => noteIgnored('keep the scheduled tasks a machine fires', error),
  });
  /** Every machine's set, sent in the background: a failure (the store unreadable) is noted, never thrown at the scheduler. */
  const syncAll = () => service.syncAll().catch((error) => noteIgnored('send the machines their scheduled tasks', error));
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settling = null;
  /** Tasks or machines changed: every machine is sent its set again once the changes settle. */
  const resync = () => {
    if (settling) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = null;
      void syncAll();
    }, SETTLE_MS);
    settling.unref?.();
  };
  let offRows = /** @type {(() => void) | null} */ (null);
  return {
    firedByMachine: service.firedByMachine,
    /** A task's machine and whether that machine fires it while this Mac is away, for a phone (electron/remote/methods/read.cjs gates both on Host). @param {any} task */
    phoneFields: (task) => ({ hostId: machineOf(task) ?? null, firesWhileMacAway: service.firedByMachine(task) }),
    /** A listing with each task its machine fires itself marked (fired_by is listed only, never written: automationStore.cjs DERIVED). @template {{ tasks: any[] }} L @param {L} list @returns {L} */
    marked: (list) => ({ ...list, tasks: list.tasks.map((t) => (service.firedByMachine(t) ? { ...t, fired_by: 'machine' } : t)) }),
    resync,
    /** Sends each machine its set now, follows machine changes, and asks what they ran on an interval; the returned function stops it. */
    start() {
      void syncAll();
      try {
        offRows = machines()?.onRows(resync) ?? null;
      } catch (error) {
        // machine changes then wait for the next task change or read: starting the scheduler never fails on it
        noteIgnored('follow the machines for their scheduled tasks', error);
      }
      const timer = setInterval(() => void service.readAll(), READ_MS);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        offRows?.();
        if (settling) clearTimeout(settling);
      };
    },
  };
}

module.exports = { wireHostSchedules };
