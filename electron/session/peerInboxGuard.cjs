// Bounds agent-to-agent peer traffic with no per-turn budget: a relay loop is cut, a flood or a repeat is refused (Claude Code's inbox guard limits).

const { clock } = require('../platform/ports/clock.cjs');

/** Claude Code 2.1.311's inbox guard defaults. */
const LIMITS = Object.freeze({
  bucketCapacity: 30,
  refillPerSecond: 0.5,
  dedupWindowMs: 30000,
  maxSelfHops: 10,
  maxChainLength: 28,
  maxTrackedPairs: 256,
});

/**
 * The chats a new message's causal chain has passed through, ending with its sender. The sender's current turn
 * continues the longest chain among the peer messages it took: the one that started it (its input token is
 * `pending-<message id>`) and those steered into it (delivered into the same native turn). Any other turn starts one.
 * @param {any[]} messages the journal
 * @param {string} source the sending chat
 * @param {string | null} turnToken the sender's current turn input token
 * @param {string | null} [turnId] the sender's current native turn id
 */
function hopsFor(messages, source, turnToken, turnId = null) {
  const id = typeof turnToken === 'string' && turnToken.startsWith('pending-') ? turnToken.slice('pending-'.length) : null;
  const chain = (/** @type {any} */ m) => (Array.isArray(m.hops) ? m.hops : [m.sourceChatId]);
  const causes = messages.filter(
    (m) => m.targetChatId === source && (m.id === id || (turnId != null && m.delivery === 'delivered' && m.targetTurnId === turnId)),
  );
  if (!causes.length) return [source];
  return [...causes.map(chain).reduce((a, b) => (b.length > a.length ? b : a)), source];
}

/** Why the chain to `target` is cut as a relay loop, or null. */
function loopReason(hops, target, limits = LIMITS) {
  if (hops.length > limits.maxChainLength) return 'peer_relay_runaway';
  if (hops.filter((id) => id === target).length >= limits.maxSelfHops) return 'peer_loop_cut';
  return null;
}

/** A token bucket and the last body per sender → receiver pair, in memory (a restart forgets a flood, as Claude Code's does). */
function createInboxGuard(limits = LIMITS) {
  const pairs = new Map();
  return {
    /** Why a send from `source` to `target` is refused now, or null; an admitted send spends a token. */
    admit(source, target, body) {
      const now = clock.now();
      const key = JSON.stringify([source, target]);
      let pair = pairs.get(key);
      if (!pair) {
        if (pairs.size >= limits.maxTrackedPairs) pairs.delete(pairs.keys().next().value);
        pair = { tokens: limits.bucketCapacity, refilled: now, body: undefined, bodyAt: 0 };
        pairs.set(key, pair);
      }
      if (pair.body === body && now - pair.bodyAt < limits.dedupWindowMs) return 'duplicate_message';
      pair.tokens = Math.min(limits.bucketCapacity, pair.tokens + ((now - pair.refilled) / 1000) * limits.refillPerSecond);
      pair.refilled = now;
      if (pair.tokens < 1) return 'rate_limited';
      pair.tokens -= 1;
      pair.body = body;
      pair.bodyAt = now;
      return null;
    },
  };
}

module.exports = { LIMITS, hopsFor, loopReason, createInboxGuard };
