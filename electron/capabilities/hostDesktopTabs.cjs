// The pane's tab for a Host chat's desktop (G8 #3903): an agent tab like a Host's browser tabs (electron/capabilities/browser/agentTabs.cjs lists it beside them), so takeover, hand back, Stop and the tab strip work the same. Its key is ["host", hostId, "desktop"] (hostTabKey.cjs); the pane draws it from frames (hostDesktopView.cjs) and says it is that machine's desktop, never the user's own screen.
//
// A chat has this tab once it used its Host's desktop. While the user drives it (`takenOver`) the agent's desktop calls are refused (RemoteHelper), and it goes when the chat ends or moves to another machine.
const { encodeTabKey } = require('./browser/hostTabKey.cjs');

/** The tab's id inside its Host's key. */
const DESKTOP_TAB = 'desktop';

/**
 * @param {object} o
 * @param {(chatId: string) => void} o.onChange the chat's tabs changed: the pane is told
 * @param {(hostId: string) => string} o.nameOf the machine's name
 * @param {(chatId: string) => void} o.hold the user took the desktop over: what the agent has running on the Host stops and what it holds is let go (hostDesktop.cjs)
 * @param {(chatId: string, tabKey: string) => void} o.onOpen the chat has a desktop tab it did not have: windows open it in the pane
 */
function createHostDesktopTabs({ onChange, nameOf, hold, onOpen }) {
  /** chat id -> its desktop tab @type {Map<string, { hostId: string, active: boolean, takenOver: boolean }>} */
  const tabs = new Map();
  return {
    /** The chat used its Host's desktop (it holds the lease now, or let go of it). A chat that moved to another machine has the new one's tab only. @param {string} chatId @param {string} hostId @param {boolean} active */
    note(chatId, hostId, active) {
      const was = tabs.get(chatId);
      if (was && was.hostId === hostId && was.active === active) return;
      tabs.set(chatId, { hostId, active, takenOver: was?.hostId === hostId ? was.takenOver : false });
      onChange(chatId);
      if (was?.hostId !== hostId) onOpen(chatId, String(encodeTabKey(hostId, DESKTOP_TAB)));
    },
    /** @param {string} chatId */
    takenOver: (chatId) => tabs.get(chatId)?.takenOver === true,
    /** The user takes the desktop over or hands it back; false when the chat has no desktop tab. @param {string} chatId @param {boolean} on */
    takeOver(chatId, on) {
      const tab = tabs.get(chatId);
      if (!tab) return false;
      if (tab.takenOver !== on) {
        tab.takenOver = on;
        // whoever takes it over (this pane, another window, browser:takeOver) stops the agent's side first
        if (on) hold(chatId);
        onChange(chatId);
      }
      return true;
    },
    /** The chat's tab as the pane's agent-tab list shows it (agentTabs.cjs tabView): a desktop, not a page. @param {string} chatId */
    list(chatId) {
      const tab = tabs.get(chatId);
      if (!tab) return [];
      return [
        {
          tabId: DESKTOP_TAB,
          tabKey: encodeTabKey(tab.hostId, DESKTOP_TAB),
          hostId: tab.hostId,
          kind: 'tab',
          active: tab.active,
          created: false,
          mark: null,
          takenOver: tab.takenOver,
          result: false,
          origin: '',
          access: null,
          signin: null,
          moved: false,
          device: null,
          desktop: { machine: nameOf(tab.hostId) },
        },
      ];
    },
    /** The Host the chat's tab is on, or null. @param {string} chatId */
    hostOf: (chatId) => tabs.get(chatId)?.hostId ?? null,
    /** The chat's turn ended: its desktop is not in use now (the tab stays) and a takeover ends with the turn, as a browser's does. @param {string} chatId */
    idle(chatId) {
      const tab = tabs.get(chatId);
      if (!tab || (!tab.active && !tab.takenOver)) return;
      tab.active = false;
      tab.takenOver = false;
      onChange(chatId);
    },
    /** A machine dropped its connection: its leases are gone, so no takeover on it goes on. @param {string} hostId */
    hostLost(hostId) {
      for (const [chatId, tab] of tabs)
        if (tab.hostId === hostId && tab.takenOver) {
          tab.takenOver = false;
          onChange(chatId);
        }
    },
    /** A machine went away: the tabs of the chats that used its desktop go with it. @param {string} hostId */
    forgetHost(hostId) {
      for (const [chatId, tab] of [...tabs]) if (tab.hostId === hostId) this.forget(chatId);
    },
    /** Every chat with a desktop tab. */
    chats: () => [...tabs.keys()],
    /** The chat ended, or its machine did. @param {string} chatId */
    forget(chatId) {
      if (tabs.delete(chatId)) onChange(chatId);
    },
  };
}

module.exports = { createHostDesktopTabs, DESKTOP_TAB };
