// window.native.dictation: dictation: local speech and the microphone grant (electron/app/ipc/accounts.cjs,
// electron/platform/voice.cjs, electron/platform/micAccess.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  localStatus: invoke('dictation:localStatus', 1),
  localRequest: invoke('dictation:localRequest', 1),
  micAsk: invoke('dictation:micAsk', 0),
  micSettings: invoke('dictation:micSettings', 0),
};
