// Runs the event source for the S1 watcher: while Superagent is on, a repo is chosen and nothing is paused, one source polls that repo and feeds the intake; otherwise it is stopped.
// The source itself is injected (`createSource({ repo, emit })` returning `{ start(), stop() }`), so this file knows nothing about GitHub or Electron.

/**
 * @param {object} o
 * @param {() => any} o.getStore the open store, or null
 * @param {(store: any) => { repo: string | null, paused: { all: boolean, github: boolean } }} o.getConfig
 * @param {((o: { repo: string, emit: (event: unknown) => void }) => { start: () => void, stop: () => void }) | null} o.createSource null: no source is available in this build
 * @param {(event: unknown) => Promise<unknown>} o.receive the intake
 * @param {(error: unknown) => void} [o.onError] where a failing intake call is shown
 */
function createRunner({ getStore, getConfig, createSource, receive, onError = () => undefined }) {
  /** @type {{ repo: string, source: { stop: () => void } } | null} */
  let running = null;
  /** @type {string | null} the repository a source failed for, until it changes */
  let failed = null;

  const stop = () => {
    running?.source.stop();
    running = null;
  };

  /** What the page can show about the source: not available, stopped (and why) or watching a repo. */
  function status() {
    if (running) return { state: 'watching', repo: running.repo };
    const store = getStore();
    if (!store) return { state: 'stopped', reason: 'off' };
    const config = getConfig(store);
    if (!config.repo) return { state: 'stopped', reason: 'no_repo' };
    if (config.paused.all || config.paused.github) return { state: 'stopped', reason: 'paused' };
    if (failed === config.repo) return { state: 'stopped', reason: 'error' };
    return { state: 'stopped', reason: createSource ? 'idle' : 'no_source' };
  }

  /**
   * Call after anything that can change whether and what to watch: the flag, the repo, a pause. A source that cannot be
   * created or started is reported and not retried until the repository changes, so a broken one never breaks the page.
   */
  function sync() {
    const store = getStore();
    const config = store ? getConfig(store) : null;
    const wanted = config && config.repo && !config.paused.all && !config.paused.github && createSource ? config.repo : null;
    if (failed !== null && failed !== wanted) failed = null;
    if (running && running.repo === wanted) return;
    stop();
    if (!wanted || !createSource || failed === wanted) return;
    /** @type {{ start: () => void, stop: () => void } | undefined} */
    let source;
    try {
      source = createSource({
        repo: wanted,
        emit: (event) => {
          // a source that was stopped and replaced emits nothing more
          if (running?.source === source) receive(event).catch(onError);
        },
      });
      running = { repo: wanted, source };
      source.start();
    } catch (error) {
      failed = wanted;
      stop();
      onError(error);
    }
  }

  return { sync, stop, status };
}

module.exports = { createRunner };
