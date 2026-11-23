// window.native.momoTasks: MoMo's Tasks tab (A1, electron/momo/tasksIpc.cjs): the routine runs going, the open loops awake and the approval cards waiting, derived on each read and refused while MoMo is not allowed. A task is done only through its source (the loop's Done, the card's answer).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  /** the tasks, the ones that need the user first */
  list: invoke('momoTasks:list'),
  /** the user's mark on a routine run: (taskId, 'done' | 'archive' | 'delete' | 'reopen', undoToken?); the token takes an earlier mark back (M0a, the Tasks panel) */
  mark: invoke('momoTasks:mark', 3),
  /** a loop changed: read again */
  onChanged: on('momoTasks:changed'),
};
