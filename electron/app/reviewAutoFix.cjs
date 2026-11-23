// Review auto-fix composition: a code review's findings are applied without a click when Settings → General says so, or
// when the chat's PR monitor has Auto-fix on; main's ChatController hooks feed it on every harness, with no window open.
const { ReviewAutoFix } = require('../session/reviewAutoFix.cjs');
const { addHook, addGuard } = require('../session/hookChain.cjs');
const { traitsOf } = require('../harness/family.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { autoApplyReviewFixes } = require('../../shared/reviewAutoFix.mjs');
const { authoredInput } = require('../session/authoredInput.cjs');

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: the controller, chats and sessions
 * @param {{ snapshot: (chatId: string) => { autoFix?: boolean, pr?: { state?: string } | null } | null }} o.monitor PR monitoring
 * @param {(chatId: string) => string | null} o.blocked why the chat can't take an automatic message now (prMonitor's gate)
 * @param {() => { prefs?: Record<string, unknown> } | null | undefined} o.readState the app's saved state, its prefs included
 * @param {(channel: string, payload: unknown) => void} o.broadcastAll to every window
 */
function attachReviewAutoFix({ live, monitor, blocked, readState, broadcastAll }) {
  const controller = live.controller;
  /** a chat whose open PR is monitored with Auto-fix applies its reviews' findings too */
  const prAutoFix = (chatId) => {
    try {
      const s = monitor.snapshot(chatId);
      return !!s?.autoFix && (s.pr?.state ?? 'OPEN') === 'OPEN';
    } catch (error) {
      noteIgnored("read a chat's PR monitor for review auto-fix", error);
      return false;
    }
  };
  const autoFix = new ReviewAutoFix({
    exists: (chatId) => live.chats.records.has(chatId),
    setting: () => autoApplyReviewFixes(readState()?.prefs),
    prAutoFix,
    reportTool: (chatId) => traitsOf(controller.ref(chatId).kind).reportsFindings,
    chatOf: (key) => controller.chatOf(key),
    requestThread: (thread) => controller.requestThread(thread),
    queued: (chatId) => live.sessions.get(chatId)?.queue?.length ?? 0,
    blocked,
    // shown as MoPilot's in every window, never as the user's words: windows read the chat's meta again before the
    // input reaches its transcript
    make: (
      /** @type {string} */ chatId,
      /** @type {string} */ text,
      /** @type {{ by: string, title: string, body?: string | null }} */ show,
    ) => {
      const item = authoredInput(live.chats, chatId, text, show);
      broadcastAll('chats:changed', { id: chatId, chat: live.chats.get(chatId) });
      return item;
    },
    send: (chatId, item) => controller.send(chatId, item, null),
    note: noteIgnored,
  });
  const quietly =
    (what, fn) =>
    (...args) => {
      try {
        fn(...args);
      } catch (error) {
        noteIgnored(what, error);
      }
    };
  // a failure here never holds up a message: the step only notes what is sent
  addGuard(
    controller,
    'beforeDispatch',
    quietly('note a message for review auto-fix', (e) => autoFix.dispatching(e)),
  );
  addHook(
    controller,
    'onLiveEvent',
    quietly("read a chat's review for auto-fix", (family, e) => autoFix.event(family, e)),
  );
  addHook(
    controller,
    'onFinished',
    quietly("apply a review's findings", (e) => autoFix.finished(e)),
  );
  if (live.chatDeletion)
    addHook(
      live.chatDeletion,
      'onDeleted',
      quietly('forget a deleted chat’s review', (receipt) => autoFix.forget(receipt.chatId)),
    );
  return autoFix;
}

module.exports = { attachReviewAutoFix };
