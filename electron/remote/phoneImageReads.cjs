// Bound expensive phone image history reads and native decodes; queued work rechecks the exact paired/following owner before it starts and before its answer publishes.
const { RemoteError } = require('./serviceErrors.cjs');
const readers = new WeakMap();

function createImageReads(limit = 2, capacity = 64) {
  let active = 0;
  const waiting = [];
  function pump() {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      active++;
      void (async () => {
        try {
          job.check();
          const value = await job.read();
          job.check();
          job.resolve(value);
        } catch (error) {
          job.reject(error);
        } finally {
          active--;
          pump();
        }
      })();
    }
  }
  return (check, read) =>
    new Promise((resolve, reject) => {
      if (waiting.length >= capacity) return reject(new RemoteError('failed', 'Pictures are still loading. Tap to try again.'));
      waiting.push({ check, read, resolve, reject });
      pump();
    });
}
function imageRead(service, check, read) {
  if (!readers.has(service)) readers.set(service, createImageReads());
  return readers.get(service)(check, read);
}
module.exports = { createImageReads, imageRead };
