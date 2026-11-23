// Confirmed quit drains installer-owned processes before general timed cleanup; active recovery controls remain available until then.
const { noteIgnored } = require('../ignored.cjs');

/** Unlike best-effort UI cleanup, process ownership cannot be retired by a timeout. */
function installerQuitHold({ defer = setImmediate } = {}) {
  let state = 'open';
  return (event, runs, registry, quit) => {
    if (state === 'done') return false;
    if (state === 'waiting') {
      event.preventDefault();
      try {
        void Promise.resolve(runs?.close()).catch((error) => noteIgnored('retry installer cleanup before quitting', error));
      } catch (error) {
        noteIgnored('request installer cleanup again before quitting', error);
      }
      return true;
    }
    const pending = (registry?.inflight.size ?? 0) > 0 || (runs?.list() ?? []).some((run) => run.state === 'running' || !run.checked);
    let work;
    try {
      work = Promise.all([registry?.dispose(), runs?.close()]);
    } catch (error) {
      event.preventDefault();
      noteIgnored('start installer cleanup before quitting', error);
      return true;
    }
    if (!pending) {
      state = 'done';
      void work.catch((error) => noteIgnored('finish empty installer cleanup', error));
      return false;
    }
    event.preventDefault();
    state = 'waiting';
    void work.then(
      () => {
        state = 'done';
        defer(quit);
      },
      (error) => {
        state = 'open';
        noteIgnored('finish installer cleanup before quitting', error);
      },
    );
    return true;
  };
}

module.exports = { installerQuitHold };
