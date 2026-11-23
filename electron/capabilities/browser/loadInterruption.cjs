// User Stop interrupts browser load waits without treating a partial document as a successful load.
const { ToolError } = require('../contract/registry.cjs');
const STOP_LOADING = 'mopilot-user-stop-loading';
const interrupted = () =>
  new ToolError('The user stopped this page loading. The tab is still available; ask before retrying the navigation.', 'interrupted');

/** Stop keeps the rendered page. A thrown stop does not claim that the user's request succeeded. */
function stopLoading(wc) {
  wc.stop();
  wc.emit(STOP_LOADING);
}

/** Each wait belongs to this operation only; a later retry starts without the previous Stop. */
async function withLoadInterruption(wc, run) {
  let stopped = false;
  let rejectStop;
  const stoppedPromise = new Promise((_resolve, reject) => {
    rejectStop = reject;
  });
  const onStop = () => {
    stopped = true;
    rejectStop(interrupted());
  };
  const wait = async (promise) => {
    const value = await Promise.race([promise, stoppedPromise]);
    if (stopped) throw interrupted();
    return value;
  };
  wc.on(STOP_LOADING, onStop);
  try {
    return await wait(run(wait));
  } finally {
    wc.removeListener(STOP_LOADING, onStop);
  }
}
module.exports = { STOP_LOADING, stopLoading, withLoadInterruption };
