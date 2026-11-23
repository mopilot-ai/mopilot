// window.native.momoOutputs: the Outputs section of MoMo's right panel (#2139, electron/momo/outputsIpc.cjs): the files MoMo saved and the user's Open, Show in Finder, Save a copy and Delete.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoOutputs:list'),
  open: invoke('momoOutputs:open', 1),
  reveal: invoke('momoOutputs:reveal', 1),
  saveCopy: invoke('momoOutputs:saveCopy', 1),
  remove: invoke('momoOutputs:remove', 1),
  /** a file was saved or deleted, or MoMo was reset: read the list again */
  onChanged: on('momoOutputs:changed'),
};
