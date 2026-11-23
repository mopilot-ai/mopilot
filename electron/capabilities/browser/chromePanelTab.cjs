// Hands a side-panel message's exact Chrome tab to its stable chat before sending the message, or reports a visible degraded outcome without reopening its URL.
const { messageOf } = require('../../ignored.cjs');
const { browserHandoffMessage } = require('../../../shared/chromeHandoff.mjs');

/** A tab handoff carries only trusted extension metadata; page titles never become instructions. */
function panelTabOf(tab) {
  if (!tab || typeof tab !== 'object') return null;
  if (!Number.isSafeInteger(tab.id) || tab.id < 0 || typeof tab.grant !== 'string' || !/^[\da-f-]{36}$/.test(tab.grant)) return null;
  return { id: tab.id, grant: tab.grant };
}

/** Keep the tab marker last so the transcript can display it separately from the user's words. */
function withNote(text, note) {
  return browserHandoffMessage(note, text);
}

/**
 * @param {any} live main's current controller plans and Chrome service
 * @param {string} chatId stable MoPilot chat id @param {string} text composed panel message @param {any} tab
 */
async function preparePanelTab(live, chatId, text, tab, deadline = Infinity) {
  if (!tab) return { text, warning: null };
  const target = panelTabOf(tab);
  const service = live.chromeRelay;
  const snapshot = () => live.controllerPlans?.snapshot(chatId);
  try {
    const plan = snapshot();
    const key = plan?.key;
    if (!target) throw new Error('Update the MoPilot Chrome extension, then send again from this page.');
    if (service?.kind !== 'extension' || plan?.plan?.bu !== 'mopilot-chrome')
      throw new Error('This chat uses a different Chrome connection. Its own tools must request access to this existing tab.');
    if (tab.owner && tab.owner !== chatId && live.sessions?.running(tab.owner))
      throw new Error('Another chat is working in this tab. Stop it before moving the tab.');
    const link = await service.relay.connect(chatId);
    if (live.chromeRelay !== service || snapshot()?.key !== key || snapshot()?.plan?.bu !== 'mopilot-chrome')
      throw new Error('The chat changed its browser connection while the page was being connected.');
    if (tab.owner && tab.owner !== chatId && live.sessions?.running(tab.owner))
      throw new Error('Another chat is working in this tab. Stop it before moving the tab.');
    // Expire native effects before the transport can report a timeout to the model and person.
    const wait = Math.max(1, Math.floor(link.commandMs - Math.min(1000, link.commandMs / 10)));
    const expires = Math.min(Date.now() + wait, deadline);
    if (expires <= Date.now()) throw new Error('This message took too long to prepare. Send it again from this page.');
    const owned = await link.send('session.adopt', [{ ...target, deadline: expires }]);
    const hostTab =
      typeof owned?.membership === 'string' && owned.membership
        ? service.tabs.list(chatId).find((t) => t.backend.tabId === target.id && t.backend.membership === owned.membership)
        : null;
    if (
      !hostTab ||
      live.chromeRelay !== service ||
      service.relay.link(chatId) !== link ||
      snapshot()?.key !== key ||
      snapshot()?.plan?.bu !== 'mopilot-chrome'
    )
      throw new Error('The page left this chat while it was being connected.');
    return {
      text: withNote(
        text,
        `[Use the existing Chrome tab ${target.id} with Chrome tools. With the Browser plugin, find the existing tabs.list entry whose providerTabId is ${JSON.stringify(hostTab.id)} and use that entry's plugin id. Preserve its page state; do not open its URL in another tab.]`,
      ),
      warning: null,
      target: { tabId: target.id, hostId: hostTab.id, membership: owned.membership },
    };
  } catch (error) {
    const original = messageOf(error).replace(/^Chrome refused session\.adopt: /, '');
    const reason = /session\.adopt.*not a command/.test(original)
      ? 'Update the MoPilot Chrome extension, then send again from this page.'
      : original;
    const warning = `The page could not be connected to this chat. ${reason}`;
    return {
      text: withNote(
        text,
        `[Chrome tab handoff failed: ${reason} Do not reopen this URL or substitute a new tab. Explain what needs to change before you can use this existing page.]`,
      ),
      warning,
    };
  }
}

/** A queued message changes selection only when its own native dispatch begins, never during the preceding turn. */
function selectPanelTab(live, chatId, item) {
  const target = item?.opts?.chromePanelTab;
  if (target === undefined) return;
  const service = live.chromeRelay;
  const tab = service?.tabs
    ?.list(chatId)
    .find((t) => t.id === target?.hostId && t.backend.tabId === target?.tabId && t.backend.membership === target?.membership);
  if (!tab || !target?.membership || service.kind !== 'extension' || live.controllerPlans?.snapshot(chatId)?.plan?.bu !== 'mopilot-chrome')
    throw new Error(
      'This page is no longer available to this chat. Remove this retained message from the queue and send again from that page’s side panel.',
    );
  service.tabs.select(chatId, tab.id);
}

module.exports = { preparePanelTab, panelTabOf, withNote, selectPanelTab };
