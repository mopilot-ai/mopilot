// window.native.ledger: the request ledger's last lines, its usage and cost summary, importing outside sessions' usage, and its folder (electron/app/ipc/ledger.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  recent: invoke('ledger:recent', 1),
  summary: invoke('ledger:summary', 1),
  importOutside: invoke('ledger:importOutside'),
  reveal: invoke('ledger:reveal'),
};
