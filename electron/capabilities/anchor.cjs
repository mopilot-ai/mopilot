// Which permission anchor a chat's computer-use and browser tools run under, on every harness: the live chat's mode, else the app default.

const { anchorOf } = require('./contract/policy.cjs');
const { thisMacControl } = require('./contract/thisMacControl.cjs');

/**
 * The anchor of a chat on harness `kind` whose session state is `s`: its reported mode (an ACP mode through its quirks
 * anchors), else `fallback`, the app default a chat starts in until its session reports a mode.
 * @param {string} kind
 * @param {{ permission?: string | null, acp?: any } | null | undefined} s
 * @param {string | null} [fallback]
 */
const sessionAnchorOf = (kind, s, fallback = null) =>
  anchorOf({ harness: kind, permission: s?.permission ?? fallback ?? null, acp: s?.acp ?? null });

/**
 * The chat's anchor, which computer use and the browser both read: the live chat mode before the app default. A remote
 * owner of computer access (#1364, `remote`) runs under its own, which is never above Ask (electron/computerAccess/owners.cjs).
 * @param {string} chatId
 * @param {{ sessions: any, controller: any, prefs?: () => any, remote?: { get(id: string): { anchor: 'readOnly' | 'ask' } | null } | null }} o
 */
function chatAnchorOf(chatId, { sessions, controller, prefs, remote = null }) {
  const owner = remote?.get(chatId);
  if (owner) return owner.anchor;
  const anchor = sessionAnchorOf(controller.ref(chatId).kind, sessions.get(chatId), prefs?.()?.permission);
  return thisMacControl(chatId) && anchor !== 'readOnly' ? 'ask' : anchor;
}

module.exports = { chatAnchorOf, sessionAnchorOf };
