// Which remote kill switches (electron/platform/flags.cjs) a harness kind answers to, shared by main (refusals,
// admission, caps) so every consumer reads the same keys.
'use strict';
const { parseKind } = require('./harnessKind.mjs');
const { hostFamilyOfHarness } = require('./host/chatIds.mjs');

/** Each family's switches: its own, and for the basic tier the tier's and the harness's. */
const HARNESS_KEYS = {
  codex: () => ['harness.codex.enabled'],
  claude: () => ['harness.claude.enabled'],
  // a chat that runs Claude Code or Codex on a machine is no basic harness of this Mac: it answers to Host's own gate, not to a switch for an agent it is not
  acp: (basic) => (hostFamilyOfHarness(basic) ? [] : ['tier.basic.enabled', `harness.acp.${basic}.enabled`]),
};
/** Each family's tool channel (computer and browser control reach the harness only that way). */
const CHANNEL_KEY = { codex: 'channel.codex.threadConfigMcp', claude: 'channel.claude.sdkMcp', acp: 'channel.acp.sessionMcp' };

/** `codex`, `claude` or `acp:<id>` (a chat's kind, possibly with a thread suffix) → the harness switches that turn it off. */
function harnessKeys(kind) {
  const k = parseKind(kind);
  return k ? HARNESS_KEYS[k.family](k.basic) : [];
}

/** The switch for the harness's tool channel. */
function channelKey(kind) {
  const k = parseKind(kind);
  return k ? CHANNEL_KEY[k.family] : null;
}

/** The first harness switch that is off for `kind` (`isEnabled(key)` is false), or null. */
function harnessOff(kind, isEnabled) {
  return harnessKeys(kind).find((k) => !isEnabled(k)) ?? null;
}

/**
 * Why a harness can't start new chats right now (a switch for it or for its tool channel is off), or null.
 * `needsChannel`: the basic tier is admitted only when it can be given tools, so its channel switch counts too;
 * on the first tier a channel switch only takes the tools away, not the chat.
 */
function killedReason(kind, isEnabled, { needsChannel = false } = {}) {
  if (harnessOff(kind, isEnabled)) return 'Turned off by MoPilot for now';
  const ch = channelKey(kind);
  if (needsChannel && ch && !isEnabled(ch)) return 'Turned off by MoPilot for now (its tool channel is off)';
  return null;
}

/**
 * Why a chat's next turn can't start (ChatController.start's off-switch): its harness switched off remotely (`off`, from
 * killedReason), else the chat held by its owner (MoMo's main chat while its brain is at its limit and its rule is Pause,
 * app/momoBackground.cjs heldChat); null when it can.
 * @param {string | null} off @param {((chatId: string) => string | null) | null | undefined} held @param {string} chatId
 */
const startHold = (off, held, chatId) => off ?? held?.(chatId) ?? null;

module.exports = { harnessKeys, channelKey, harnessOff, killedReason, startHold };
