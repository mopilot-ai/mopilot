// Which registry tools a chat's owner Host can serve (design 2.9): desktop_* needs `desktop` (the Host's own desktop), computer_* needs `cu` (this Mac's), chrome_* needs `bu`, browser_* needs `iab`. Local browser stores always require a fresh local owner; surface capabilities are read once and kept until its turn ends, so every channel lists the same tools whenever its session starts and a Host's change applies from the next turn.
const { localBrowserData } = require('./localBrowserData.cjs');
const { thisMacControl } = require('./thisMacControl.cjs');

const NEEDS = /** @type {const} */ ([
  // a chat on a Host uses that Host's own desktop (`desktop`, capabilities/hostDesktop.cjs); `cu` is this Mac's and no Host has it
  ['desktop_', 'desktop'],
  // the older computer_* tools act on this Mac only: a chat on a Host that lacks computer use is not offered them (they were ungated, so a Host chat could drive this Mac's screen)
  ['computer_', 'cu'],
  ['chrome_', 'bu'],
  ['browser_', 'iab'],
]);

/** The capability a tool needs, or null when any Host can serve it. @param {string} name */
function toolNeeds(name) {
  if (localBrowserData(name)) return 'localBrowserData';
  return NEEDS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? null;
}

class HostScope {
  /** @param {{ capsOf: (chatId: string) => Record<string, boolean> | null | undefined, onError: (error: unknown) => void }} o capsOf: the owner Host's capabilities; null/undefined: the chat has no remote owner, every tool is served */
  constructor({ capsOf, onError }) {
    this.capsOf = capsOf;
    this.onError = onError;
    /** @type {Map<string, Record<string, boolean> | null>} */
    this.kept = new Map();
  }

  /** The chat's capabilities for this turn; a Host that cannot be read serves nothing it did not declare (fail closed). @param {string} chatId */
  caps(chatId) {
    if (!this.kept.has(chatId)) {
      try {
        this.kept.set(chatId, this.capsOf(chatId) ?? null);
      } catch (error) {
        // unreadable: serve only what needs no declared surface, and read again at the next call rather than keeping the failure
        this.onError(error);
        return {};
      }
    }
    return this.kept.get(chatId) ?? null;
  }

  /** Whether the chat's Host lacks the surface `need` names. @param {string} chatId @param {string | null} need @param {string} [tool] */
  lacks(chatId, need, tool) {
    if (!need || ((need === 'desktop' || need === 'bu') && tool && thisMacControl(chatId, tool))) return false;
    // Local stores never follow a remote chat, even when its surface capabilities are frozen for this turn; nor do the
    // gateway's tools (`thisMac`: the user's MCP servers and their credentials are this Mac's)
    if (need === 'localBrowserData' || need === 'thisMac') {
      try {
        return this.capsOf(chatId) != null;
      } catch (error) {
        this.onError(error);
        return true;
      }
    }
    const caps = this.caps(chatId);
    return caps !== null && caps[need] !== true;
  }

  /** The chat's turn ended: the next read sees the Host as it is then. @param {string} chatId */
  thaw(chatId) {
    this.kept.delete(chatId);
  }
}

module.exports = { HostScope, toolNeeds };
