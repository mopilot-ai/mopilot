// Registry package preparation shares the app's install jobs, manager locks, output, cancellation and completion state.
const { shQuote } = require('../../platform/disclaim.cjs');

/** @param {any} runs @param {string} id @param {{ via: string, argv: string[], env?: object, cwd: string, signal: AbortSignal }} spec
 * @returns {Promise<void>} */
function registryPackageRun(runs, id, spec) {
  if (!runs) return Promise.reject(new Error('The harness installer is not ready yet.'));
  spec.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let runId = null;
    const finish = (run) => {
      if (run.id !== runId) return;
      unsubscribe();
      spec.signal.removeEventListener('abort', abort);
      if (run.code === 0 && !run.stopped) resolve();
      else
        reject(
          new Error(
            run.stopped
              ? 'The ACP agent installation was cancelled.'
              : 'The ACP agent package did not install. Check the installation output and retry.',
          ),
        );
    };
    const abort = () => {
      if (runId) runs.stop(runId);
    };
    const unsubscribe = runs.onEnd(finish);
    let result;
    try {
      result = runs.launch({
        kind: `acp:registry-${id}`,
        purpose: 'install',
        via: spec.via,
        argv: spec.argv,
        command: spec.argv.map(shQuote).join(' '),
        env: spec.env,
        cwd: spec.cwd,
        quiet: true,
        timeoutMs: 10 * 60 * 1000,
      });
    } catch (error) {
      unsubscribe();
      reject(error);
      return;
    }
    if (!result.ok) {
      unsubscribe();
      reject(
        new Error(
          result.error === 'busy'
            ? 'Another package installation is running. Retry when it finishes.'
            : (result.message ?? 'The ACP agent installer could not start.'),
        ),
      );
      return;
    }
    runId = result.run.id;
    spec.signal.addEventListener('abort', abort, { once: true });
    if (spec.signal.aborted) abort();
    const current = runs.list().find((run) => run.id === runId);
    if (current?.state === 'exited' && current.checked) finish(current);
  });
}

module.exports = { registryPackageRun };
