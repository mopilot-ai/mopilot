// Runs a step and then its cleanup (closing what it opened) so that a cleanup that fails never replaces the step's own error. @host-portable

/**
 * Cleanup must not replace the error from the operation it follows.
 * @template T @param {() => T} action @param {() => void} cleanup @returns {T}
 */
function withCleanup(action, cleanup) {
  let failed = false;
  let failure;
  let result;
  try {
    result = action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    cleanup();
  } catch (error) {
    if (!failed) throw error;
  }
  if (failed) throw failure;
  return /** @type {T} */ (result);
}

/**
 * Async resource cleanup follows the same error precedence as synchronous filesystem cleanup.
 * @template T @param {() => T | Promise<T>} action @param {() => unknown} cleanup @returns {Promise<T>}
 */
async function withAsyncCleanup(action, cleanup) {
  let failed = false;
  let failure;
  let result;
  try {
    result = await action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!failed) throw error;
  }
  if (failed) throw failure;
  return /** @type {T} */ (result);
}

module.exports = { withCleanup, withAsyncCleanup };
