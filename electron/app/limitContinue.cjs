// The limit continuation's composition: a chat whose turn ended on its harness's usage limit goes on by itself, with the
// registry's quotas and the chat controller behind it (session/limitContinue.cjs).
const { LimitContinuation } = require('../session/limitContinue.cjs');
const { chooseHarness, quotaResetOf } = require('../session/orchestration/autoHarness.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { authoredInput } = require('../session/authoredInput.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { resumeAfterQuotaReset, switchHarnessAtLimit } = require('../../shared/limitPolicy.mjs');

/** The harnesses a chat can switch to in place. */
const FIRST_TIER = ['codex', 'claude'];

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: the controller, chats and identity registry
 * @param {any} o.orchestrator what chooseHarness reads (the harnesses that can run now)
 * @param {() => import('../../shared/limitPolicy.mjs').LimitPreferences | null | undefined} o.prefs the independent reset and harness-switch prefs
 * @param {(channel: string, payload: unknown) => void} o.broadcastAll to every window
 */
function attachLimitContinue({ live, orchestrator, prefs, broadcastAll }) {
  const controller = live.controller;
  return new LimitContinuation({
    controller,
    prefs,
    resumeEnabled: () => resumeAfterQuotaReset(prefs()),
    switchEnabled: () => switchHarnessAtLimit(prefs()),
    // ACP has one harness-owned account: its limit event is the evidence. First-tier pools must all be exhausted.
    exhausted: (kind) => !!parseKind(kind)?.basic || orchestrator.o.quota?.(kind)?.limited === true,
    choose: async (chatId, own) => {
      // a MoMo chat stays on its brain's harness (only MoMo's brain moves it): it goes on when that quota is back
      if (isMomoMeta(live.chats?.records?.get(chatId)?.meta)) return null;
      try {
        const others = orchestrator.o.kinds().filter((k) => !FIRST_TIER.includes(k));
        return (await chooseHarness(orchestrator, chatId, { exclude: [own, ...others] })).harness;
      } catch (error) {
        if (error?.code !== 'no_harness') noteIgnored('pick a harness for a chat at its usage limit', error);
        return null;
      }
    },
    resetAt: (kind) => quotaResetOf(live.identity?.instances(parseKind(kind)?.family), kind),
    send: (chatId, item) => controller.send(chatId, item, null, true),
    // shown as MoPilot's in every window, never as the user's words
    make: (chatId, text, show) => {
      const item = authoredInput(live.chats, chatId, text, show);
      broadcastAll('chats:changed', { id: chatId, chat: live.chats.get(chatId) });
      return item;
    },
  });
}

module.exports = { attachLimitContinue };
