// Bringing a machine's Host up to this app's build without a click: when a row says its Host is older than the app and the machine is reached over ssh, the same update the row's Update button sends is sent, at most three times per app build (counted on disk, so a restart of the app does not start again), two machines at a time, and only while Host auto-update is on. The Host itself defers the restart until nothing runs.
const { fs } = require('../platform/ports/fs.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { isEnabled } = require('../platform/flags.cjs');
const { writeAtomic } = require('../platform/fsutil.cjs');
const { isLocal } = require('./localHost.cjs');

/** How long to wait before the next try after the 1st, 2nd and 3rd failed one; a 4th is never made for the same app build. */
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
/** How many machines are sent a build at once: each upload is signed and sent over its own ssh. */
const MAX_RUNNING = 2;
/** How long a build another app staged on a Host is waited for before this app sends its own: the Host may stay busy for a long time, and a staged build that never restarts must not hide the row for ever. */
const PENDING_MS = 30 * 60_000;
/** Refusals that come before anything was sent: they do not use up a try. */
const REFUSED = new Set(['busy', 'not_allowed', 'unknown_machine', 'host_newer']);
const GAVE_UP = 'MoPilot stopped trying on its own after 3 tries.';

/** The tries kept in a file of the user's data, so a restart of the app does not give a Host that never takes the update three more. @param {string} file */
function triesFile(file) {
  return {
    load() {
      try {
        const found = JSON.parse(fs.readFileSync(file, 'utf8'));
        return found && typeof found === 'object' ? found : {};
      } catch {
        return {};
      }
    },
    /** @param {Record<string, { build: string, tries: number, next: number }>} tries */
    save(tries) {
      try {
        writeAtomic(file, JSON.stringify(tries));
      } catch (error) {
        noteIgnored('keep the count of automatic Host updates', error);
      }
    },
  };
}

/**
 * @param {object} o
 * @param {{ list: () => { id: string, address: string }[] }} o.registry the machines; one joined by command (a `relay:` address) has no ssh to be sent a build over, and this Mac's own Host is updated by localHost.sync
 * @param {() => { id: string, status: string, hostStale?: boolean, hostDiffers?: boolean, hostNewer?: boolean, update?: string, updateNeedsPair?: boolean }[]} o.rows the rows the app shows
 * @param {() => boolean} o.allowed Host's closed-alpha gate
 * @param {() => boolean} o.on the person's own "Update automatically"
 * @param {() => string} o.appBuild the Host build this app carries (read once per process by the caller); a new one starts the count again
 * @param {(id: string) => Promise<unknown>} o.update the row's Update (machines.updateHost): its state, its refusal of a newer Host and its signing are the button's
 * @param {{ load: () => Record<string, any>, save: (tries: Record<string, any>) => void }} [o.store] where the tries are kept (default: memory)
 */
function createAutoUpdate({ registry, rows, allowed, on, appBuild, update, store }) {
  let holds = 0;
  const sshReachable = (/** @type {string} */ id) => {
    const record = registry.list().find((r) => r.id === id);
    return !!record && !record.address.startsWith('relay:') && !isLocal(record.address);
  };
  /** @type {Map<string, { build: string, tries: number, next: number }> | null} */
  let tried = null;
  const triesOf = () =>
    (tried ??= new Map(Object.entries(store?.load() ?? {}).filter(([, v]) => v && typeof v.build === 'string' && v.tries >= 0)));
  const keep = () => store?.save(Object.fromEntries(triesOf()));
  /** @type {Set<string>} */
  const running = new Set();
  /** @type {any} */
  let timer = null;
  const stopTimer = () => {
    if (timer) clock.clearTimeout(timer);
    timer = null;
  };
  /** Looks again at `ms`: a retry waits for its backoff, and nothing else might change the rows by then. @param {number} ms */
  const later = (ms) => {
    stopTimer();
    timer = clock.setTimeout(
      () => {
        timer = null;
        auto.consider();
      },
      Math.max(1000, ms),
    );
    timer?.unref?.();
  };
  const auto = {
    /**
     * Looks at the rows the app shows and starts the update of each machine that is eligible now, up to the cap; asks again when the next try is due.
     * Eligible: answering, a Host strictly older than the app (not one "that differs", which a developer's build is), no update under way or waiting (here, or staged on the Host by another app), none that failed for a key that needs pairing, and a try left whose time has come.
     */
    consider() {
      stopTimer();
      // a failing setting read must never stop the row change from reaching the windows
      try {
        if (!allowed() || !isEnabled('host.autoUpdate') || !on()) return;
      } catch (error) {
        return noteIgnored('read whether Host updates itself', error);
      }
      if (holds > 0) return later(60_000);
      let due = Infinity;
      for (const m of rows()) {
        if (m.status === 'offline' || !m.hostStale || m.hostDiffers || m.hostNewer) continue;
        if (m.update === 'running' || m.update === 'waiting' || m.updateNeedsPair) continue;
        if (running.has(m.id) || !sshReachable(m.id)) continue;
        const build = appBuild();
        const was = triesOf().get(m.id);
        const mine = was?.build === build ? was : { build, tries: 0, next: 0 };
        if (mine.tries >= BACKOFF_MS.length) continue;
        if (clock.now() < mine.next) {
          due = Math.min(due, mine.next);
          continue;
        }
        if (running.size >= MAX_RUNNING) continue;
        triesOf().set(m.id, { build, tries: mine.tries + 1, next: clock.now() + BACKOFF_MS[mine.tries] });
        keep();
        due = Math.min(due, clock.now() + BACKOFF_MS[mine.tries]);
        running.add(m.id);
        void update(m.id)
          .catch((error) => {
            // refused before anything was sent: the try is not used up
            if (REFUSED.has(error?.code)) {
              if (was) triesOf().set(m.id, was);
              else triesOf().delete(m.id);
              keep();
            }
            noteIgnored('update a machine’s Host with the app', error);
          })
          .finally(() => {
            running.delete(m.id);
            auto.consider();
          });
      }
      if (due !== Infinity) later(due - clock.now());
    },
    /**
     * What the row says beyond its own update state: a build another app staged on the Host means it updates when idle (for up to half an hour, or for ever when it is this app's own build); a failure after the last automatic try says MoPilot stopped trying.
     * @param {{ id: string, hostPending?: { build: string, since: number } | null }} r @param {Record<string, any>} fields what `updates.rowFor` said of the row
     */
    decorate(r, fields) {
      const pending = r.hostPending;
      if (pending && !fields.update && (pending.build === appBuild() || clock.now() - pending.since < PENDING_MS))
        return { ...fields, update: 'waiting' };
      const was = triesOf().get(r.id);
      if (fields.update === 'failed' && was?.build === appBuild() && was.tries >= BACKOFF_MS.length)
        return { ...fields, updateError: [fields.updateError, GAVE_UP].filter(Boolean).join(' ') };
      return fields;
    },
    /**
     * Runs `work` (a rotation of the app's key across the machines) while no machine is updated automatically, and looks again when it ends.
     * @template T @param {() => Promise<T>} work @returns {Promise<T>}
     */
    async whileHeld(work) {
      holds++;
      try {
        return await work();
      } finally {
        holds--;
        auto.consider();
      }
    },
    /** A machine that was removed starts from nothing if it is added again. @param {string} id */
    forget(id) {
      triesOf().delete(id);
      keep();
    },
    dispose: stopTimer,
  };
  return auto;
}

module.exports = { createAutoUpdate, triesFile, BACKOFF_MS, MAX_RUNNING, PENDING_MS, GAVE_UP };
