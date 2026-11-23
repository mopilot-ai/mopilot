// A fake event source for fake E2E specs and local checks: emits the events listed in a JSON file once when started, for the repo it was started on. It reaches nothing.
// Used only when MOPILOT_SUPERAGENT_FAKE_EVENTS names a file (electron/app/ipc/superagent.cjs); the real GitHub source takes its place in the same slot.

/**
 * @param {object} o
 * @param {string} o.repo
 * @param {(event: unknown) => void} o.emit
 * @param {() => string} o.readEvents the file's text
 * @param {(error: unknown) => void} o.onError
 */
function createFakeSource({ repo, emit, readEvents, onError }) {
  let stopped = false;
  return {
    start() {
      try {
        const events = JSON.parse(readEvents());
        for (const event of Array.isArray(events) ? events : []) {
          if (stopped) return;
          if (String(event?.repo?.fullName).toLowerCase() === repo.toLowerCase()) emit(event);
        }
      } catch (error) {
        onError(error);
      }
    },
    stop() {
      stopped = true;
    },
  };
}

module.exports = { createFakeSource };
