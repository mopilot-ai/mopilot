// A user-triggered JS CPU profile of one app window's renderer (docs/performance/measurement.md): attaches webContents.debugger, runs the Profiler domain for a fixed time and writes <userData>/perf/profile-<run id>.cpuprofile. Nothing is uploaded.
const fs = require('node:fs');
const path = require('node:path');
const { runId } = require('./probe.cjs');

/** How long the profile records. */
const DURATION_MS = 10_000;
/** Profiler sampling interval in microseconds (1 ms). */
const INTERVAL_US = 1000;

/** A timer that can be cut short: `cancel` resolves `promise` at once. */
function cancellableWait(/** @type {number} */ ms) {
  const { promise, resolve } = /** @type {{ promise: Promise<void>, resolve: () => void }} */ (
    /** @type {any} */ (Promise).withResolvers()
  );
  const t = setTimeout(resolve, ms);
  return { promise, cancel: () => (clearTimeout(t), resolve()) };
}

const messageOf = (/** @type {any} */ error) => String(error?.message ?? error);

/**
 * @typedef {{ ok: true, file: string } | { ok: false, reason: 'busy' | 'no-window' | 'attached' | 'attach-failed' | 'window-closed' | 'failed', message?: string }} CaptureResult
 */

/**
 * One capture at a time per app. Dependencies are injected so the controller runs on a fake debugger.
 * @param {{ dir: () => string, durationMs?: number, wait?: typeof cancellableWait,
 *           write?: (file: string, text: string, o: object) => Promise<unknown>, mkdir?: (dir: string, o: object) => Promise<unknown>,
 *           reveal?: (file: string) => void, id?: () => string, ignored?: (what: string, error: unknown) => void }} deps
 */
function createCpuProfiler({
  dir,
  durationMs = DURATION_MS,
  wait = cancellableWait,
  write = fs.promises.writeFile,
  mkdir = fs.promises.mkdir,
  reveal = () => undefined,
  id = () => runId(),
  ignored = () => undefined,
}) {
  let busy = false;
  return {
    /**
     * Records the window's renderer. Always detaches the debugger it attached before it resolves.
     * @param {Electron.BrowserWindow | null | undefined} win
     * @param {{ onStart?: () => void }} [hooks]
     * @returns {Promise<CaptureResult>}
     */
    async capture(win, { onStart } = {}) {
      if (busy) return { ok: false, reason: 'busy' };
      if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' };
      busy = true;
      const dbg = win.webContents.debugger;
      let attached = false;
      let closed = false;
      /** @type {{ cancel: () => void } | null} */
      let timer = null;
      const onDetach = () => {
        closed = true;
        timer?.cancel();
      };
      /** @returns {Promise<CaptureResult>} never rejects */
      const run = async () => {
        try {
          if (dbg.isAttached()) return { ok: false, reason: 'attached' };
          try {
            dbg.attach('1.3');
            attached = true;
          } catch (error) {
            return { ok: false, reason: 'attach-failed', message: messageOf(error) };
          }
          dbg.on('detach', onDetach);
          await dbg.sendCommand('Profiler.enable');
          await dbg.sendCommand('Profiler.setSamplingInterval', { interval: INTERVAL_US });
          await dbg.sendCommand('Profiler.start');
          onStart?.();
          if (closed) return { ok: false, reason: 'window-closed' };
          const w = wait(durationMs);
          timer = w;
          await w.promise;
          if (closed) return { ok: false, reason: 'window-closed' };
          const { profile } = await dbg.sendCommand('Profiler.stop');
          const folder = dir();
          await mkdir(folder, { recursive: true, mode: 0o700 });
          const file = path.join(folder, `profile-${id()}.cpuprofile`);
          await write(file, JSON.stringify(profile), { mode: 0o600 });
          reveal(file);
          return { ok: true, file };
        } catch (error) {
          // a closed window rejects the commands: that is not a failure of the capture
          if (closed || win.isDestroyed()) return { ok: false, reason: 'window-closed' };
          return { ok: false, reason: 'failed', message: messageOf(error) };
        }
      };
      const result = await run();
      if (attached) {
        try {
          dbg.removeListener('detach', onDetach);
          if (dbg.isAttached()) {
            await dbg.sendCommand('Profiler.disable').catch((error) => ignored('disable the CPU profiler', error));
            dbg.detach();
          }
        } catch (error) {
          ignored('detach the CPU profile debugger', error);
        }
      }
      busy = false;
      return result;
    },
  };
}

module.exports = { createCpuProfiler, DURATION_MS, INTERVAL_US };
