// window.native.momoSources: Settings › MoMo › Sources (#2139): each source's state, connect and disconnect, its access level, the Files folders and macOS's privacy pane (electron/momo/sources/ipc.cjs, which refuses every call while MoMo is not allowed).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoSources:list'),
  detail: invoke('momoSources:detail', 1),
  connect: invoke('momoSources:connect', 1),
  disconnect: invoke('momoSources:disconnect', 1),
  setLevel: invoke('momoSources:setLevel', 2),
  /** opens main's folder dialog; the folder the user picks is added */
  addFolder: invoke('momoSources:addFolder'),
  removeFolder: invoke('momoSources:removeFolder', 1),
  openPrivacy: invoke('momoSources:openPrivacy', 1),
  /** reads the grant now and connects when the switch went on (the window came back to the front) */
  recheck: invoke('momoSources:recheck', 1),
  /** stops waiting for the user to turn on a macOS switch the connect opened */
  cancelConnect: invoke('momoSources:cancelConnect', 1),
  /** what MoMo wrote to Calendar and Reminders in the last 30 days, newest first */
  writes: invoke('momoSources:writes'),
  /** the user's own Undo of one write (audited, no card) */
  undoWrite: invoke('momoSources:undoWrite', 1),
  /** a source was connected, disconnected or changed: read the list again */
  onChanged: on('momoSources:changed'),
};
