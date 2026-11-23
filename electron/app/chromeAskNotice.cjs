// The Chrome extension channel's signals and requests to the rest of the app (#1632, #1986): its state changed (Settings and the models' notes), "Allow Chrome to connect?" as a notification through the app's one notifier, the extension's page asking to open something (Try it), and a page's Review opening its chat.
//
// Try it opens a new chat with a sample task drafted, never sent: the extension names only what to open, and the text
// is main's, so a page can't put words in the user's composer.
//
// The extension asks right after the user turns it on in Chrome, so MoPilot is usually behind Chrome then: the
// in-app dialog alone would go unseen, and so would a notification the user turned off. The window comes forward with
// the question (the extension's page says "click Allow in MoPilot", so that is where the user has to be). The
// notification is an approval (it needs the user), so the Notifications setting and its switches apply as for a
// chat's; a click opens Settings → Browser, under the dialog, whose row also has Allow (computerAccess.cjs
// notificationTarget), and it goes when the question does.

const { noteIgnored } = require('../ignored.cjs');

/** The notifier's id for the question: not a chat, but where its click goes. */
const CHROME_NOTICE = 'settings:browser';
/** The window comes forward with a question at most this often: a stale or untaken question raised again, or Chrome started again, must not take focus again and again. */
const FORWARD_MS = 10 * 60_000;
const TITLE = 'Allow Chrome to connect?';
const BODY = 'The MoPilot extension asked.';
/** The sample task the install page's Try it drafts in a new chat. */
const TRY_PROMPT = 'Open news.ycombinator.com in my Chrome and tell me the top three stories.';

/**
 * @param {{ changed: () => void, notifier: () => { notify: (kind: string, id: string, o: object) => unknown, retract: (id: string) => void } | null | undefined,
 *           appWindows?: { commandMainWindow: (cmd: string, ...args: unknown[]) => Promise<unknown>, showMainWindow: () => unknown },
 *           now?: () => number }} o
 *   changed: the capability-health record changed; notifier: the app's notifier (platform/notify.cjs), once registered;
 *   appWindows: where Try it's chat opens, and the chat whose "Waiting for your OK" pill's Review was clicked (agentControlFrame.cjs)
 */
function chromeRelayNotices({ changed, notifier, appWindows, now = Date.now }) {
  /** when the window last came forward with the question */
  let forwardedAt = -Infinity;
  return {
    /** @param {unknown} what @returns {boolean} whether it opened */
    onOpen: (what) => {
      if (!appWindows) return false;
      // "Open MoPilot" from Chrome: the window comes forward (the native host started the app when it wasn't running)
      if (what === 'app') {
        appWindows.showMainWindow();
        return true;
      }
      if (what !== 'try') return false;
      void appWindows.commandMainWindow('new-chat-draft', TRY_PROMPT).catch((error) => noteIgnored('open a sample chat for Chrome', error));
      return true;
    },
    /** @param {string} chatId */
    openChat: (chatId) => {
      void appWindows?.commandMainWindow('open-chat', chatId).catch((error) => noteIgnored('open a chat from Chrome', error));
    },
    onStatus: () => changed(),
    /** @param {boolean} asking */
    onAsk: (asking) => {
      const n = notifier();
      if (asking) {
        n?.notify('approval', CHROME_NOTICE, { title: TITLE, body: BODY, group: 'chrome' });
        // Chrome is in front when the extension asks, and its page says to click Allow here: the dialog has to be seen
        // (a notification isn't, with Notifications off or a Focus mode on). Once per question (PairOffers raises it on
        // the change only, and Not now holds it), and not again within FORWARD_MS.
        if (appWindows && now() - forwardedAt >= FORWARD_MS) {
          forwardedAt = now();
          appWindows.showMainWindow();
        }
      } else n?.retract(CHROME_NOTICE);
    },
  };
}

module.exports = { chromeRelayNotices, CHROME_NOTICE, TITLE, BODY, TRY_PROMPT };
