// window.native.momoBrief: the morning brief's Try again (A7, electron/momo/briefIpc.cjs): write the brief now, as the user's own request. Refused while MoMo is not allowed or the brief is off.
const { invoke } = require('./spec.cjs');

module.exports = {
  /** write the brief now; a refusal says why in words (nothing to say, already today, paused) */
  runNow: invoke('momoBrief:runNow'),
};
