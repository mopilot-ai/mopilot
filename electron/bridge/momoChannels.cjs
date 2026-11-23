// window.native.momoChannels: MoMo's channels and groups (A2, electron/momo/channelsIpc.cjs): the list, a channel's chat (made on the first open), create (a name only), rename, archive, delete, move into a group, its instructions, the answer to its first row, and the group calls; each answers `{ ok, ... }` and is refused while MoMo is not allowed or `momo.channels` is off.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoChannels:list'),
  /** the chat of a channel (id), made on first use */
  chat: invoke('momoChannels:chat', 1),
  create: invoke('momoChannels:create', 2),
  rename: invoke('momoChannels:rename', 2),
  archive: invoke('momoChannels:archive', 1),
  /** undo of an archive */
  restore: invoke('momoChannels:restore', 1),
  delete: invoke('momoChannels:delete', 1),
  /** (channelId, groupId | null) */
  move: invoke('momoChannels:move', 2),
  /** (channelId, 'up' | 'down'): one place among the channels beside it (Mac only) */
  reorder: invoke('momoChannels:reorder', 2),
  getInstructions: invoke('momoChannels:instructions:get', 1),
  setInstructions: invoke('momoChannels:instructions:set', 2),
  /** the answer to a new channel's first row: (channelId, 'yes' | 'no' | 'later') */
  welcome: invoke('momoChannels:welcome', 2),
  /** Everything's rows, newest first: (channelId | 'main')? narrows them to one channel */
  everything: invoke('momoChannels:everything', 1),
  createGroup: invoke('momoChannels:group:create', 1),
  renameGroup: invoke('momoChannels:group:rename', 2),
  deleteGroup: invoke('momoChannels:group:delete', 1),
  /** undo of a group's delete: ({ id, name }, the channel ids that were in it) */
  restoreGroup: invoke('momoChannels:group:restore', 2),
  /** the channels or groups changed: read again */
  onChanged: on('momoChannels:changed'),
};
