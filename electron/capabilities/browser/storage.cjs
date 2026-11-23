// The built-in browser's storage partitions (IAB-08), harness-neutral: the shared persistent profile,
// and with Settings → Browser → Storage set to "This chat only" an in-memory partition per chat.
//
// - The pane names a tab's partition (shared/browserStorage.mjs); main's will-attach-webview passes it
//   through partition(), which accepts only the shared profile or a chat's own in-memory partition and
//   sets a chat's session up (downloads, sign-in) the first time it is used.
// - sessions() is every session a panel tab may be in: assertCdpTarget (cdp.cjs) and popups check it,
//   so browser_* tools drive a chat's own partition exactly as they drive the shared one.
// - endChat() clears and lets go of a chat's partition when the chat ends (archived); in-memory
//   partitions are gone when the app quits anyway.
const { noteIgnored } = require('../../ignored.cjs');
const { clearBrowsingData } = require('./clearData.cjs');
const { SHARED_PARTITION, browserPartition, isChatPartition } = require('../../../shared/browserStorage.mjs');

/** Clears data and live tab history; chat cleanup tolerates failure, explicit user requests reject.
 * @param {{ clearStorageData(): Promise<void>, clearCache(): Promise<void>, clearHistory?: () => Promise<void> }} ses
 * @param {import('electron').WebContents[]} [pages]
 * @param {boolean} [strict]
 */
async function clearSession(ses, pages = [], strict = false) {
  try {
    await clearBrowsingData(ses, pages);
    await ses.clearHistory?.();
  } catch (error) {
    if (strict) throw error;
    // Chat teardown is best effort; the in-memory partition disappears at exit.
  }
}

class BrowserStorage {
  /**
   * @param {{ fromPartition: (partition: string) => any, configure?: (ses: any) => void, clearHistory?: () => void }} o
   *   fromPartition: Electron's session.fromPartition
   *   configure: sets up a chat's new session as the shared one is (downloads, passkey account picker)
   *   clearHistory: empties the browser's own history store (Clear browsing data)
   */
  constructor(o) {
    this.o = o;
    /** partition -> session, for the chats' own partitions in use */
    this.chats = new Map();
    /** sessions configure() already ran on (a partition used again after its chat ended) */
    this.configured = new WeakSet();
  }

  /** The shared persistent profile. */
  get shared() {
    return this.o.fromPartition(SHARED_PARTITION);
  }

  /**
   * The partition a new panel tab gets for the one it asked for: a chat's own in-memory partition, else
   * the shared profile. A chat's partition is set up the first time it is used.
   */
  partition(requested) {
    if (!isChatPartition(requested)) return SHARED_PARTITION;
    if (!this.chats.has(requested)) {
      const ses = this.o.fromPartition(requested);
      this.chats.set(requested, ses);
      if (!this.configured.has(ses)) {
        this.configured.add(ses);
        try {
          this.o.configure?.(ses);
        } catch (error) {
          // auth/download setup is optional; the partition remains usable
          noteIgnored("set up a chat's browser partition (auth, downloads)", error);
        }
      }
    }
    return requested;
  }

  /** Every session a panel tab may be in: the shared profile and the chats' own partitions in use. */
  sessions() {
    return [this.shared, ...this.chats.values()];
  }

  /** The chat ended: its own partition is cleared and no longer a panel session. False when it had none. */
  async endChat(chatId) {
    const partition = browserPartition('session', chatId);
    const ses = this.chats.get(partition);
    if (!ses) return false;
    this.chats.delete(partition);
    await clearSession(ses);
    return true;
  }

  /** "Clear browsing data": the shared profile and every chat's own partition. */
  /** @param {import('electron').WebContents[]} [pages] */
  async clearAll(pages = []) {
    await Promise.all(this.sessions().map((ses) => clearSession(ses, pages, true)));
    this.o.clearHistory?.();
  }
}

module.exports = { BrowserStorage, clearSession, SHARED_PARTITION };
