// window.native.momoRoutines: Settings › MoMo › Routines (electron/momo/routinesIpc.cjs): the routines MoMo proposed and the ones the user approved, approving a proposal, declining one, pausing, editing or removing a routine, and its changes.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  view: invoke('momoRoutines:view'),
  approve: invoke('momoRoutines:approve', 2),
  edit: invoke('momoRoutines:edit', 2),
  runNow: invoke('momoRoutines:runNow', 1),
  history: invoke('momoRoutines:history', 1),
  remove: invoke('momoRoutines:remove', 1),
  onChanged: on('momoRoutines:changed'),
};
