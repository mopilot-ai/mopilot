// One run-owned completion boundary combines actual closure with verified retirement and allows explicit cleanup retries.
/** @template T
 * @param {{ retire: () => unknown, onComplete: (value: T) => void, onError: (error: any) => void }} o */
function processCompletion({ retire, onComplete, onError }) {
  let closed = false;
  let done = false;
  let pending = false;
  let retired = false;
  let value = /** @type {T} */ (undefined);
  const finish = () => {
    if (done || !closed || !retired) return;
    done = true;
    onComplete(value);
  };
  const request = () => {
    if (pending || retired) return;
    pending = true;
    void Promise.resolve()
      .then(retire)
      .then(
        () => {
          pending = false;
          retired = true;
          finish();
        },
        (error) => {
          pending = false;
          onError(error);
        },
      );
  };
  return {
    request,
    close(result) {
      if (closed) return;
      closed = true;
      value = result;
      request();
      finish();
    },
  };
}

module.exports = { processCompletion };
