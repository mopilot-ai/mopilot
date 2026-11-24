// window.native.perf: the window's performance samples (src/session/perf.ts), to main's probe (electron/app/ipc/perf.cjs).
const { send } = require('./spec.cjs');

module.exports = {
  samples: send('perf:samples', 1),
  record: send('perf:record', 1),
};
