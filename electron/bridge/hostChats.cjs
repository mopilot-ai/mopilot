// window.native.hostChats: every machine's chats as its Host lists them, and when they change (electron/host/chatIndex.cjs, electron/app/ipc/host.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('host:chatIndex'),
  onChanged: on('host:chatIndex'),
};
