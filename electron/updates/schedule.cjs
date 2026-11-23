// One updater schedule: jittered minute checks for every release channel, with bounded failure backoff.
function scheduleUpdates(check, { random = Math.random, onError }) {
  const interval = 60_000;
  let stopped = false;
  let failures = 0;
  let timer;
  const schedule = (delay) => {
    timer = setTimeout(tick, delay + Math.floor(random() * 5_000));
  };
  const tick = async () => {
    try {
      const state = await check();
      failures = state.status === 'error' ? failures + 1 : 0;
    } catch (error) {
      failures++;
      onError(error);
    } finally {
      if (!stopped) schedule(Math.min(interval * 2 ** Math.min(failures, 4), 15 * 60_000));
    }
  };
  schedule(10_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
module.exports = { scheduleUpdates };
