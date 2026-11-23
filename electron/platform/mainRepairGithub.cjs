// Runs the synchronous GitHub CAS protocol off Electron's main thread; lost workers leave durable operations uncertain.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { clock } = require('./ports/clock.cjs');
const shellEnv = require('./env.cjs');
const REQUEST_MS = 120_000;
function createRepairGithub({ makeWorker = (file, options) => new Worker(file, options), environment = () => shellEnv.childEnv() } = {}) {
  const active = new Map();
  let closed = false;
  return {
    request(op, payload) {
      if (closed) return Promise.reject(new Error('Main repair coordinator is closed'));
      return new Promise((resolve, reject) => {
        let worker;
        try {
          worker = makeWorker(path.join(__dirname, 'mainRepairGithubWorker.cjs'), {
            workerData: { op, payload, environment: environment() },
          });
        } catch (error) {
          reject(error);
          return;
        }
        const finish = (error, result) => {
          if (!active.has(worker)) return;
          active.delete(worker);
          clock.clearTimeout(timer);
          void worker.terminate();
          if (error) reject(error);
          else resolve(result);
        };
        const timer = clock.setTimeout(() => finish(new Error('Main repair GitHub request timed out; outcome is unknown')), REQUEST_MS);
        active.set(worker, finish);
        worker.once('message', (message) => finish(message.ok ? null : new Error(message.error), message.result));
        worker.once('error', (error) => finish(error));
        worker.once('exit', () => finish(new Error('Main repair GitHub worker exited; outcome is unknown')));
        worker.unref();
      });
    },
    close() {
      closed = true;
      for (const finish of active.values()) finish(new Error('Main repair coordinator is closed'));
    },
  };
}
module.exports = { createRepairGithub, REQUEST_MS };
