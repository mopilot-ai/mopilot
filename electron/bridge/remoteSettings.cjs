// window.native.remoteSettings: document-owned local pairing and phone controls.
const invoke = (channel, count = 0) => ({ kind: 'invoke', channel, params: count, ownerChannel: 'remoteSettings:document' });
module.exports = {
  state: invoke('remoteSettings:state'),
  setEnabled: invoke('remoteSettings:setEnabled', 1),
  begin: invoke('remoteSettings:begin'),
  cancel: invoke('remoteSettings:cancel'),
  answer: invoke('remoteSettings:answer', 1),
  revoke: invoke('remoteSettings:revoke', 2),
  setMirrors: invoke('remoteSettings:setMirrors', 3),
  rename: invoke('remoteSettings:rename', 3),
};
