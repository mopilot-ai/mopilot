// Keeps cancellation ownership across an asynchronous startup open until the caller synchronously claims its resource.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @template T
 * @param {AbortSignal} signal startup retirement
 * @param {() => Promise<T>} open
 * @param {() => void} close closes pending as well as open resources
 * @returns {Promise<() => T>} an atomic claim: cancellation remains active across the caller's await
 */
async function startupResource(signal, open, close) {
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', dispose);
    try {
      close();
    } catch (error) {
      noteIgnored('close a cancelled startup resource', error);
    }
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    signal.throwIfAborted();
    const result = await open();
    signal.throwIfAborted();
    return () => {
      signal.throwIfAborted();
      signal.removeEventListener('abort', dispose);
      return result;
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = { startupResource };
