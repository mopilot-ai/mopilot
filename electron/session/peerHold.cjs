// The receiving chat's hold on a peer message from a chat in a stricter permission mode, like Claude Code's cross-session hold.

const { clock } = require('../platform/ports/clock.cjs');
const { effectivePermission, reportedPermission } = require('../../shared/effectivePermission.mjs');

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

/** How long a held message waits for the receiving user's Allow before it expires undelivered. */
const HOLD_MS = 10 * 60 * 1000;

/**
 * Claude Code's two permission classes: a chat that runs every action without asking ('unattended': Full access)
 * and one where something still asks or refuses ('prompting'); null when the mode is not known.
 * @param {string | null | undefined} mode an app permission (shared/permissionMenu.mjs PERMISSION_ORDER, or 'plan')
 */
function permissionClass(mode) {
  if (typeof mode !== 'string' || !mode) return null;
  return mode === 'full-access' ? 'unattended' : 'prompting';
}

/**
 * Why a message from `sourceMode` to `targetMode` waits for the receiving user, or null to deliver it.
 * Only a receiver that runs without asking holds: its own prompts protect a prompting one.
 */
function holdReason(sourceMode, targetMode) {
  if (permissionClass(targetMode) !== 'unattended') return null;
  const source = permissionClass(sourceMode);
  if (source === 'unattended') return null;
  return source ? 'held_mode_mismatch' : 'held_mode_unknown';
}

/**
 * A chat's permission as its composer shows it: the harness's reported mode first (an ACP chat's from its mode
 * anchors), else the chat's saved choice, else the app default.
 * @param {{ config?: any, prefs?: any, session?: any }} o
 */
function chatPermission({ config, prefs, session }) {
  const basic = session?.acp ? reportedPermission(session, true) : null;
  return basic ?? effectivePermission(config, prefs?.permission, session?.acp ? null : session);
}

/**
 * The receiving user's Allow on a held message: it is delivered as any other, without asking again.
 * @param {any} service PeerMessageService
 */
async function approveHeld(service, chatId, id) {
  const m = service.get(chatId, id);
  if (m.targetChatId !== chatId || m.delivery !== 'held') fail('cannot_approve');
  return service.enqueue(service.update(id, { allowedByUser: true }));
}

/** The receiving user's Decline: the message ends undelivered. */
function declineHeld(service, chatId, id) {
  const m = service.get(chatId, id);
  if (m.targetChatId !== chatId || m.delivery !== 'held') fail('cannot_decline');
  return service.update(id, { delivery: 'declined', errorCode: null });
}

/** Expires held messages past their time, and delivers those whose two chats' modes now match. */
async function sweepHeld(service) {
  const ids = service.data.messages.filter((/** @type {any} */ x) => x.delivery === 'held').map((/** @type {any} */ x) => x.id);
  for (const id of ids) {
    // an earlier release awaited: the user may have answered this one meanwhile
    const m = service.data.messages.find((/** @type {any} */ x) => x.id === id);
    // an Allow in progress (awaiting its gate) is the user's answer: it is not expired under them
    if (m?.delivery !== 'held' || m.allowedByUser) continue;
    if (!(clock.now() < m.heldUntil)) service.update(m.id, { delivery: 'expired', errorCode: 'hold_expired' });
    else if (!service.holdFor(m)) await service.enqueue(m);
  }
}

module.exports = { HOLD_MS, permissionClass, holdReason, chatPermission, approveHeld, declineHeld, sweepHeld };
