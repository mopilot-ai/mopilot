// Owns the signed macOS installer process and its single command to activate a prepared bundle.
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const { noteIgnored } = require('../ignored.cjs');

const PREPARE_MS = 10 * 60_000;
const HANDOFF_MS = 5000;

/** @typedef {{ ready: () => boolean, commit: (restart: boolean) => Promise<void>, cancel: () => void }} Stage */

/** EOF abandons the prepared bundle. An explicit command transfers ownership. */
function prepare(
  helper,
  file,
  version,
  signal,
  lost,
  { launch = proc.spawn, kill = process.kill, timeout = PREPARE_MS, grace = HANDOFF_MS } = {},
) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = launch(helper, [file, version], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let ready = false;
    let retired = false;
    let committed = false;
    let reply = '';
    let diagnostics = '';
    let cancelled;
    let cancellationTimer;
    let handoffTimer;
    /** @type {{ resolve: () => void, reject: (error: Error) => void } | null} */
    let handoff = null;
    const stop = () => {
      if (!child.pid) return;
      try {
        kill(-child.pid, 'SIGKILL');
      } catch (error) {
        noteIgnored('stop the macOS update installer', error, ['ESRCH']);
      }
    };
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const cancel = (error = new Error('The prepared update was retired.')) => {
      if (retired || committed) return;
      retired = true;
      cancelled = error;
      done();
      child.stdin.end();
      cancellationTimer = setTimeout(stop, grace);
      cancellationTimer.unref?.();
    };
    const rejectHandoff = (error, terminate = true) => {
      if (!handoff) return;
      clearTimeout(handoffTimer);
      const { reject } = handoff;
      handoff = null;
      if (terminate) child.kill('SIGKILL');
      reject(error);
    };
    const stopped = (error) => {
      if (retired || committed) return;
      retired = true;
      done();
      if (ready) lost(stage, error);
      else reject(error);
    };
    const abort = () => cancel(signal.reason);
    const timer = setTimeout(() => cancel(new Error('Preparing the app update timed out. Check for updates to try again.')), timeout);
    timer.unref?.();
    /** @type {Stage} */
    const stage = {
      ready: () => ready && !retired && !committed && !child.stdin.destroyed && child.exitCode === null,
      async commit(restart) {
        if (!stage.ready()) throw new Error('The prepared update is no longer available. Check for updates to try again.');
        committed = true;
        await new Promise((resolve, reject) => {
          reply = '';
          handoff = { resolve: () => resolve(undefined), reject };
          handoffTimer = setTimeout(() => rejectHandoff(new Error('The helper did not acknowledge activation.')), grace);
          handoffTimer.unref?.();
          child.stdin.write(restart ? 'restart\n' : 'quit\n', (error) => {
            child.stdin.end();
            if (error) rejectHandoff(error);
          });
        });
        child.unref();
      },
      cancel,
    };
    child.stdout.on('data', (chunk) => {
      if (retired || (ready && !handoff)) return;
      reply += chunk;
      const expected = handoff ? 'accepted\n' : 'ready\n';
      if (!expected.startsWith(reply)) {
        const error = new Error('The update installer sent an invalid result.');
        if (handoff) return rejectHandoff(error);
        return cancel(error);
      }
      if (reply !== expected) return;
      if (handoff) {
        clearTimeout(handoffTimer);
        const { resolve } = handoff;
        handoff = null;
        return resolve();
      }
      ready = true;
      done();
      resolve(stage);
    });
    child.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-2000);
    });
    child.on('error', (error) => (handoff ? rejectHandoff(error) : stopped(error)));
    child.stdin.on('error', (error) => (handoff ? rejectHandoff(error) : cancel(error)));
    child.on('close', () => {
      clearTimeout(cancellationTimer);
      if (diagnostics) noteIgnored('run the macOS update installer', new Error(diagnostics.trim()));
      const error = new Error('The update installer stopped. Check for updates to try again.');
      if (handoff) return rejectHandoff(error, false);
      // The next download can reuse the zip path only once the obsolete extractor has released it.
      if (cancelled && !ready) return reject(cancelled);
      stopped(error);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Use the staged installer for replaceable installations. Other copies use the stock updater. */
function macInstaller(app, { platform = process.platform, disk = fs } = {}) {
  if (platform !== 'darwin') return null;
  const executable = app.getPath('exe');
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) return null;
  const bundle = path.resolve(executable, '../../..');
  const parent = path.dirname(bundle);
  if (parent !== '/Applications' || path.extname(bundle) !== '.app') return null;
  const helper = path.join(bundle, 'Contents', 'Helpers', 'update-install');
  try {
    if (disk.realpathSync(bundle) !== bundle) return null;
    disk.accessSync(parent, disk.constants.W_OK);
    disk.accessSync(helper, disk.constants.X_OK);
    return { prepare: (file, version, signal, lost) => prepare(helper, file, version, signal, lost) };
  } catch (error) {
    noteIgnored('check if the staged macOS installer is available', error, ['EACCES', 'ENOENT', 'EPERM']);
    return null;
  }
}

module.exports = { macInstaller, prepare };
