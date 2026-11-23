// window.native.momoMemory: MoMo's Memory tab (#2139): the facts, editing or deleting one, About you and MoMo's persona, and the open loops (electron/momo/memoryIpc.cjs, which refuses every call while MoMo is not allowed).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoMemory:list', 1),
  /** a fact the user typed */
  add: invoke('momoMemory:add', 1),
  update: invoke('momoMemory:update', 2),
  forget: invoke('momoMemory:forget', 1),
  files: invoke('momoMemory:files'),
  writeFile: invoke('momoMemory:writeFile', 2),
  /** the newest changes to the facts, each with whether it can be undone */
  changes: invoke('momoMemory:changes'),
  undo: invoke('momoMemory:undo', 1),
  /** facts a newer one replaced */
  past: invoke('momoMemory:past'),
  /** the background memory pass's caps and today's use */
  background: invoke('momoMemory:background'),
  /** the open loops (#2139 P4): the open ones and the latest closed */
  loops: invoke('momoMemory:loops'),
  /** done, dismiss, snooze or reopen one loop */
  loopAct: invoke('momoMemory:loopAct', 2),
  /** the memory changed (an edit here, or MoMo saving or forgetting): read it again */
  onChanged: on('momoMemory:changed'),
};
