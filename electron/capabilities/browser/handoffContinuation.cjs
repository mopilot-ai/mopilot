// Bind a Chrome continuation to main's current segment and route through acceptance, queueing and native dispatch.
const { identityKey } = require('../../../shared/identityKey.mjs');
const { continueMessage } = require('../../../shared/chromeHandoff.mjs');
const { isWebUrl } = require('../../../shared/browser.mjs');
const { guardSend } = require('../../session/contract/inputGuard.cjs');
const { selectPanelTab } = require('./chromePanelTab.cjs');

/** Use the controller's real NativeRef, including kind when a native id has not loaded yet. */
function handoffOwner(controller, chatId) {
  const ref = controller.ref(chatId);
  return identityKey(ref.kind, ref.key, ref.id, ref.instance ?? null);
}

/** `signedIn`: the user went to Chrome to sign in and says they did (only the user's short line differs). */
function handoffContinuation({ controller, controllerPlans }, routeOf, chatId, url, signedIn = false) {
  if (typeof chatId !== 'string' || !chatId || !isWebUrl(url)) throw new Error('Choose a chat and a valid site to continue.');
  const route = routeOf(chatId);
  const snapshot = controllerPlans?.snapshot(chatId);
  if (!snapshot || typeof snapshot.chromeToolName !== 'string')
    throw new Error('Could not read the chat’s current Chrome tools. Try again.');
  const name = snapshot.chromeToolName;
  const message = continueMessage(route, url, name, { signedIn: signedIn === true });
  return { message, precondition: { url, token: identityKey(handoffOwner(controller, chatId), route, name) } };
}

/** Optional on ordinary messages, required and exact on a handoff continuation. */
function checkHandoffContinuation(live, routeOf, chatId, item) {
  const expected = item?.opts?.chromeHandoff;
  if (expected === undefined) return;
  if (!expected || typeof expected.token !== 'string') throw new Error('Invalid Chrome continuation. Try Continue again.');
  const now = handoffContinuation(live, routeOf, chatId, expected.url);
  if (now.precondition.token !== expected.token)
    throw new Error(
      'The chat’s Chrome controller changed. Remove any retained continuation from the queue, then reopen the browser handoff to retry.',
    );
}

/** Every dispatch, including a restored queue item, gets the same live check at the adapters' final send boundary. */
function installHandoffContinuationGuard(live, routeOf) {
  const attached = new WeakSet();
  live.controller.chromeContinuationCheck = ({ chatId, item }) => {
    if (item.opts?.chromeHandoff === undefined && item.opts?.chromePanelTab === undefined) return;
    checkHandoffContinuation(live, routeOf, chatId, item);
    selectPanelTab(live, chatId, item);
    if (!attached.has(item)) {
      guardSend(item, () => {
        checkHandoffContinuation(live, routeOf, chatId, item);
        selectPanelTab(live, chatId, item);
      });
      attached.add(item);
    }
  };
}

module.exports = { handoffOwner, handoffContinuation, checkHandoffContinuation, installHandoffContinuationGuard };
