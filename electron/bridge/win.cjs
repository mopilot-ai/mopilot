// window.native.win: this window: focus, chrome, Quick Chat and Mini (electron/app/ipc/window.cjs, electron/app/ipc/quickChat.cjs).
const { invoke, send, on } = require('./spec.cjs');

module.exports = {
  isFocused: invoke('window:isFocused'),
  toggleMaximize: invoke('window:toggleMaximize'),
  setTitleBarOverlay: invoke('window:titleBarOverlay', 2),
  open: invoke('window:open', 1),
  mini: invoke('window:mini'),
  miniShortcut: invoke('mini:shortcut', 1),
  quickChatRead: invoke('quick-chat:read'),
  quickChatSave: invoke('quick-chat:save', 1),
  quickChatOpen: invoke('quick-chat:open', 1),
  quickChatSettings: invoke('quick-chat:settings', 1),
  rendererReady: send('window:ready'),
  miniHide: invoke('mini:hide'),
  onMiniShown: on('mini:shown'),
  onFocus: on('window:focus'),
  onFullscreen: on('window:fullscreen'),
};
