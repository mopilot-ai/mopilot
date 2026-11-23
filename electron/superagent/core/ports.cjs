// The Policy port of the Superagent core: versioned rules that decide who may originate work, and a check that a Policy implements it.
// Ported to CommonJS from deepseek-ai/dsh-superagent-prototype src/core/ports.ts (MIT, Copyright (c) 2026 DeepSeek Harness Team; see NOTICE).
// Only the Policy port is ported; the Assessor, Executor and Outbox ports of the prototype belong to S2.

/**
 * @typedef {{ admissible: false, reason: string } | { admissible: true, strength: import('./model.cjs').Strength, basis: Record<string, unknown> }} GateResult
 *   The gate's answer: inadmissible with a reason code, or admissible with strength and basis.
 */
/**
 * @typedef {object} Policy Versioned rules; `gate` decides who may originate work.
 * @property {string} version
 * @property {boolean} paused
 * @property {(trigger: import('./model.cjs').Trigger, thread: import('./model.cjs').Thread, tickets: import('./model.cjs').Ticket[]) => GateResult} gate
 * @property {(mandate: import('./model.cjs').Mandate) => boolean} revalidate re-check a mandate's gate-layer basis under this policy
 * @property {(rules: readonly string[]) => boolean} admitsInferred whether an inferred candidate may be accepted on the rules it matched
 * @property {number} evalTimeoutMs
 */

/** The members a Policy must have, with their types. */
const POLICY_SHAPE = Object.freeze({
  version: 'string',
  paused: 'boolean',
  gate: 'function',
  revalidate: 'function',
  admitsInferred: 'function',
  evalTimeoutMs: 'number',
});

/**
 * The members a candidate lacks or has of the wrong type; empty when it implements the Policy port.
 * @param {unknown} candidate
 * @returns {string[]}
 */
function policyProblems(candidate) {
  const o = candidate && typeof candidate === 'object' ? candidate : {};
  return Object.entries(POLICY_SHAPE)
    .filter(([name, type]) => typeof o[name] !== type)
    .map(([name, type]) => `${name} must be a ${type}`);
}

module.exports = { POLICY_SHAPE, policyProblems };
