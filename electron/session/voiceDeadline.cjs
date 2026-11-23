// Native voice waits have explicit exits; timing out never proves that the remote writer closed.
const { clock } = require('../platform/ports/clock.cjs');
function voiceDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = clock.setTimeout(
        () => reject(new Error('Native voice did not confirm closure. Restart its connection before trying conversation again.')),
        ms,
      );
    }),
  ]).finally(() => clock.clearTimeout(timer));
}
module.exports = { voiceDeadline };
