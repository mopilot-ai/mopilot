// window.native.codePair: this Mac's side of pairing by a code (R2b of #5576, behind host.codePair): its own code for another Mac to type, the person's Allow, and the events of a run (electron/app/ipc/codePair.cjs).
const { on } = require('./spec.cjs');

/** Every call carries the calling document's own token (the one Mobile Remote's settings use), so main answers only the page that made the offer. */
const invoke = (channel, count = 0) => ({ kind: 'invoke', channel, params: count, ownerChannel: 'remoteSettings:document' });

module.exports = {
  status: invoke('codePair:status'),
  setup: invoke('codePair:setup'),
  resetApproval: invoke('codePair:resetApproval'),
  offer: invoke('codePair:offer'),
  allow: invoke('codePair:allow', 1),
  deny: invoke('codePair:deny', 1),
  cancel: invoke('codePair:cancel', 1),
  onEvent: on('codePair:event'),
};
