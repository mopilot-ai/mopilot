// The main-thread side of the Claude turns worker (claudeTurnsWorkerMain.cjs): one lazily started worker thread, each
// request answered by id. A worker that cannot start or dies fails its requests with `workerDown`, so the caller reads
// them in-process instead; after repeated failures the worker is not tried again.
const path = require('node:path');
const { Worker, SHARE_ENV } = require('node:worker_threads');

/** Consecutive workers lost before reading in-process for good. */
const MAX_LOST = 2;

/** @param {{ makeWorker?: (file: string, options: object) => any }} [o] */
function createTurnsWorker(o = {}) {
  const make = o.makeWorker ?? ((file, options) => new Worker(file, options));
  /** @type {any} */
  let worker = null;
  let lost = 0;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();

  const down = (message) => Object.assign(new Error(message), { workerDown: true });
  function drop(w, message) {
    if (worker !== w) return;
    worker = null;
    lost++;
    for (const p of pending.values()) p.reject(down(message));
    pending.clear();
  }

  function start() {
    // the live environment, so a config folder changed after the start (CLAUDE_CONFIG_DIR) is the one it reads
    const w = make(path.join(__dirname, 'claudeTurnsWorkerMain.cjs'), {
      env: SHARE_ENV,
      workerData: { resourcesPath: process.resourcesPath },
    });
    w.on('message', (m) => {
      if (worker !== w) return;
      if (m.ok) lost = 0;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.page);
      else {
        if (m.code !== undefined) m.error.code = m.code;
        // a thread that could not load the core: the read goes on in main, and it is as good as lost, since each read is parsed twice
        if (m.code === 'CORE_UNAVAILABLE') {
          m.error.workerDown = true;
          if (++lost >= MAX_LOST) {
            drop(w, 'the Claude turns worker has no core');
            w.terminate();
          }
        }
        p.reject(m.error);
      }
    });
    w.on('error', (error) => drop(w, `the Claude turns worker failed: ${error?.message ?? error}`));
    w.on('exit', () => drop(w, 'the Claude turns worker exited'));
    // an idle worker does not keep the app from quitting
    w.unref();
    worker = w;
    return w;
  }

  return {
    /** @returns {Promise<any>} the page of turns */
    read(req) {
      if (lost >= MAX_LOST) return Promise.reject(down('the Claude turns worker is not available'));
      let w;
      try {
        w = worker ?? start();
      } catch (error) {
        lost++;
        return Promise.reject(down(`the Claude turns worker did not start: ${error?.message ?? error}`));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          w.postMessage({ id, req });
        } catch (error) {
          // a request the thread cannot take (not cloneable) fails alone, and is read in this thread
          pending.delete(id);
          reject(down(`the Claude turns worker could not take a request: ${error?.message ?? error}`));
        }
      });
    },
    close() {
      const w = worker;
      worker = null;
      for (const p of pending.values()) p.reject(down('the Claude turns worker was closed'));
      pending.clear();
      w?.terminate();
    },
  };
}

/** The worker the app uses: Electron's main process has threads to spare and the real SDK; plain Node (the unit tests) reads in-process. */
const appTurnsWorker = (versions = process.versions) => (versions.electron ? createTurnsWorker() : null);

module.exports = { createTurnsWorker, appTurnsWorker, MAX_LOST };
