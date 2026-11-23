// The Gate as the core's Policy port (core/ports.cjs), so S2's engine can ask the same code-only rules whether a Trigger may start work.
// S1 never accepts anything: no rule is in Auto, so `admitsInferred` is false and an allowed trigger is only ever an observation.
const { decide, POLICY_VERSION } = require('./gate.cjs');

/**
 * @param {object} o
 * @param {() => ReturnType<typeof import('./config.cjs').normalizeConfig>} o.getConfig
 * @param {() => number} o.now
 * @param {{ lastAllowedAt: (rule: string, threadKey: string) => number | null, countAllowedSince: (rule: string, sinceMs: number) => number }} o.history
 * @returns {import('../core/ports.cjs').Policy}
 */
function createPolicy({ getConfig, now, history }) {
  const input = (trigger) => ({
    trigger: {
      actorLogin: trigger.actor.id,
      actorType: String(trigger.meta?.actorType ?? (trigger.human ? 'User' : 'Bot')),
      kind: String(trigger.meta?.kind ?? ''),
      text: trigger.text,
      threadKey: `${trigger.threads[0].source}:${trigger.threads[0].id}`,
    },
    config: getConfig(),
    now: now(),
    ...history,
  });
  return {
    version: POLICY_VERSION,
    get paused() {
      const { paused } = getConfig();
      return paused.all || paused.github;
    },
    gate(trigger) {
      const d = decide(input(trigger));
      return d.result === 'allow'
        ? {
            admissible: true,
            strength: 'inferred',
            basis: { via: 'admission', cell: 'listedUnaddressed', observation: { mode: d.mode }, rules: [d.rule] },
          }
        : { admissible: false, reason: d.reason.code };
    },
    revalidate: (mandate) => getConfig().allowed.some((l) => l.toLowerCase() === mandate.actor.id.toLowerCase()),
    admitsInferred: () => false,
    evalTimeoutMs: 30_000,
  };
}

module.exports = { createPolicy };
