// Superagent reason codes and their English templates, for decisions and filtered triggers.
// Ported to CommonJS from deepseek-ai/dsh-superagent-prototype src/core/reasons.ts (MIT, Copyright (c) 2026 DeepSeek Harness Team; see NOTICE).

/** Only the codes S0 and S1 use; the rest of the prototype's table arrives with the phases that need it. */
const REASONS = Object.freeze({
  said: '{text}',
  noAdmissible: 'No admissible trigger',
  senderNotMember: "The sender is not on the Source's list",
  noRuleMatched: 'No enabled admission rule matched',
  observed: 'Observe mode: would accept ({text})',
  ignoredObserved: 'Observe mode: would ignore ({text})',
  bot: 'The sender is a bot',
  ruleOff: 'The rule that matches is off',
  cooldown: 'This rule allowed something on this thread {minutes} min ago (cooldown {limit} min)',
  rateLimit: 'This rule reached its limit of {limit} an hour',
});

/** @typedef {{ code: string, values?: Record<string, string>, triggerId?: string }} Reason */

/** @param {string} text @returns {Reason} */
const said = (text) => ({ code: 'said', values: { text } });

/**
 * Formats reasons in English (prefixed by `triggerId` when present).
 * @param {Reason | readonly Reason[] | undefined} reasons
 */
function reasonText(reasons) {
  return [reasons ?? []]
    .flat()
    .map((reason) => {
      const template = REASONS[reason.code] ?? reason.code;
      const text = template.replace(/\{(\w+)\}/g, (match, name) => reason.values?.[name] ?? match);
      return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
    })
    .join('; ');
}

module.exports = { REASONS, said, reasonText };
