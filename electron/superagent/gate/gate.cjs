// The Superagent Gate: code-only rules that say whether a request may start work. Tri-state: allow, deny (not admitted), or ask a person.
// Pattern: palantir/policy-bot policy/common/result.go (more than two outcomes, simulation = observe mode) and githubnext/gh-aw
// check_membership.cjs and check_cooldown.cjs (who may trigger, and a cooldown and rate limit per rule).
// "Ask a person" is only for an admitted request the Gate cannot settle in code (a matching rule that hits its cooldown or rate limit);
// a stranger or a bot is deny, never ask. No model is involved: text only feeds the "mentions the bot" test.
const { RULES, HOUR_MS } = require('./config.cjs');

const POLICY_VERSION = 'gate-1';

/** Whether a rule's event is this trigger. `trigger.kind` is the source's event kind. */
const MATCH = {
  explicit: (t, config) => new RegExp(`(^|[^\\w-])@${config.botLogin.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`, 'i').test(t.text),
  bugs: (t) => t.kind === 'issue.opened',
  questions: (t) => t.kind === 'issue.comment' && t.text.includes('?'),
};

/** A bot (GitHub's own type, a [bot] login, or this Superagent's own account) never starts work. */
const isBot = (t, config) =>
  t.actorType === 'Bot' || t.actorLogin.toLowerCase().endsWith('[bot]') || t.actorLogin.toLowerCase() === config.botLogin.toLowerCase();

/**
 * @typedef {{ result: 'allow' | 'deny' | 'ask', rule: string | null, mode: string | null, reason: { code: string, values?: Record<string, string> }, policyVersion: string }} GateDecision
 */

/**
 * Decides one request.
 * @param {object} o
 * @param {{ actorLogin: string, actorType: string, kind: string, text: string, threadKey: string }} o.trigger
 * @param {ReturnType<typeof import('./config.cjs').normalizeConfig>} o.config
 * @param {number} o.now epoch ms
 * @param {(rule: string, threadKey: string) => number | null} o.lastAllowedAt
 * @param {(rule: string, sinceMs: number) => number} o.countAllowedSince
 * @returns {GateDecision}
 */
function decide({ trigger, config, now, lastAllowedAt, countAllowedSince }) {
  const out = (result, rule, reason) => ({
    result,
    rule: rule?.id ?? null,
    mode: rule ? config.rules[rule.id].mode : null,
    reason,
    policyVersion: POLICY_VERSION,
  });
  if (isBot(trigger, config)) return out('deny', null, { code: 'bot' });
  if (!config.allowed.some((l) => l.toLowerCase() === trigger.actorLogin.toLowerCase()))
    return out('deny', null, { code: 'senderNotMember' });

  const matching = RULES.filter((r) => r.available && MATCH[r.id](trigger, config));
  if (!matching.length) return out('deny', null, { code: 'noRuleMatched' });
  const rule = matching.find((r) => config.rules[r.id].mode !== 'off');
  if (!rule) return out('deny', matching[0], { code: 'ruleOff' });

  const { cooldownMs, perHour } = config.rules[rule.id];
  const last = lastAllowedAt(rule.id, trigger.threadKey);
  if (last !== null && now - last < cooldownMs) {
    const minutes = String(Math.max(0, Math.round((now - last) / 60_000)));
    return out('ask', rule, { code: 'cooldown', values: { minutes, limit: String(Math.round(cooldownMs / 60_000)) } });
  }
  if (countAllowedSince(rule.id, now - HOUR_MS) >= perHour)
    return out('ask', rule, { code: 'rateLimit', values: { limit: String(perHour) } });
  return out('allow', rule, { code: 'observed', values: { text: rule.name } });
}

module.exports = { decide, isBot, POLICY_VERSION };
