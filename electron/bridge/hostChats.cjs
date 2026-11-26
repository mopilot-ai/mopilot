// window.native.hostChats: every machine's chats as its Host lists them, and when they change (electron/host/chatIndex.cjs, electron/app/ipc/host.cjs).
const { call, invoke, on } = require('./spec.cjs');

module.exports = {
  // the chats this window has open: one argument, which the first read of a run keeps bound
  list: invoke('host:chatIndex', 1),
  onChanged: on('host:chatIndex'),
  open: call('host:openChat'),
  release: call('host:releaseChat'),
};
