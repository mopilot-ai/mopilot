// The browser tabs a machine's chats use (design/host/index.html, package 2.6): main's late-bound `live.remoteBrowserTabs`, which hostTabsWiring.cjs asks for one RemoteTabs per Host.
const { remoteBrowserTabs } = require('../capabilities/browser/remoteHost.cjs');
const { createRemoteBrowserTransport } = require('../host/remoteBrowser.cjs');

/**
 * RemoteTabs for a Host over that machine's connected remote Host (`live.connectedHostFor`). While the machine is not connected there are
 * none: the call that wanted them is refused and the next one tries again (the connection is begun at the first ask).
 * @param {object} o
 * @param {any} o.live main's late-bound services
 * @param {{ createFromBuffer: (buf: Buffer) => any }} o.nativeImage Electron's, which decodes the screenshots
 * @param {(kind: string, record: unknown, prefs: unknown) => string | null} o.chatModel the chat's current model (it sizes the screenshots)
 * @param {() => unknown} o.uiPrefs
 * @param {any} o.hang the pages that stopped responding (browser/pageHang.cjs)
 * @param {(wc: null, command: string, arg: unknown) => boolean} o.tell an app:command to the focused (or main) window; false when there is none
 * @param {() => { webContents: { send: (channel: string, ...args: unknown[]) => void } }[]} o.windows every app window
 * @returns {(hostId: string, o: { onChange: (chatId: string) => void }) => ReturnType<typeof remoteBrowserTabs> | null}
 */
function remoteBrowserFactory({ live, nativeImage, chatModel, uiPrefs, hang, tell, windows }) {
  // the window's pane tab for a tab on a Host: opened and shown in the window the user is in, closed in every window
  const pane = {
    open: (/** @type {unknown} */ req) => tell(null, 'open-agent-browser-tab', req),
    select: (/** @type {unknown} */ req) => tell(null, 'select-agent-browser-tab', req),
    close: (/** @type {unknown} */ req) => {
      for (const w of windows()) w.webContents.send('app:command', 'close-agent-browser-tab', req);
    },
  };
  return (hostId, { onChange }) => {
    const host = live.connectedHostFor?.(hostId);
    if (!host) return null;
    const transport = createRemoteBrowserTransport({ host });
    const tabs = remoteBrowserTabs({
      hostId,
      transport,
      images: { fromBuffer: (buf) => nativeImage.createFromBuffer(buf) },
      modelOf: (chatId) => chatModel(live.controller.ref(chatId).kind, live.chats.record?.(chatId), uiPrefs()),
      onChange,
      hang,
      pane,
      onAbort: (fn) => live.capabilities.onAbort(fn),
    });
    const dispose = tabs.dispose;
    // the machine left: the tabs stop following its Host, and so does the transport
    tabs.dispose = () => {
      dispose();
      transport.dispose();
    };
    return tabs;
  };
}

module.exports = { remoteBrowserFactory };
