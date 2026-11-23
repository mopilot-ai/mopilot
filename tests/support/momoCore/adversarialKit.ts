// Shared helpers for MoMo's adversarial gate suite: a seeded random generator, and a gate world whose card store and hash-chained audit log record one timeline so tests can check what happened before what.
import { createHmac } from 'node:crypto';
import { hashLine } from '../../../shared/host/audit.mjs';
import {
  type ActionRequest,
  type AuditEvent,
  type Card,
  type CardStatus,
  type CardStore,
  createApprovalGate,
} from '../../../shared/momoCore/approvalGate.ts';

/** mulberry32: a tiny seeded generator, so a failing seed replays exactly. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[int(items.length)],
  };
}
export type Rng = ReturnType<typeof rng>;

export const adversarialKey = Object.assign((text: string) => createHmac('sha256', 'adversarial-key').update(text).digest('hex'), {
  keyed: true as const,
});

export type Step =
  | { k: 'audit'; event: AuditEvent['event']; cardId?: string; verdict?: string }
  | { k: 'put'; id: string }
  | { k: 'transition'; id: string; from: CardStatus; to?: CardStatus; applied: boolean };

/** A gate over an in-memory store and a hash-chained audit log, with one timeline of both. `failAudit` makes the next writes fail. */
export function world() {
  let t = 5_000_000;
  let n = 0;
  const cards = new Map<string, Card>();
  const timeline: Step[] = [];
  const lines: string[] = [];
  let prev: string | null = null;
  const state = { failAudit: false };
  const store: CardStore = {
    async get(id) {
      return cards.get(id);
    },
    async put(card) {
      timeline.push({ k: 'put', id: card.id });
      cards.set(card.id, card);
    },
    async list(statuses) {
      return [...cards.values()].filter((c) => !statuses || statuses.includes(c.status));
    },
    async byFingerprint(fingerprint) {
      return [...cards.values()].filter((c) => c.fingerprint === fingerprint).reverse();
    },
    async transition(id, expected, patch) {
      const card = cards.get(id);
      const applied = !!card && card.status === expected;
      timeline.push({ k: 'transition', id, from: expected, to: patch.status, applied });
      if (!card || !applied) return undefined;
      const next = { ...card, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as Record<string, unknown>)[key];
      cards.set(id, next);
      return next;
    },
  };
  const gate = createApprovalGate({
    now: () => t,
    newId: () => `card${++n}`,
    hash: adversarialKey,
    store,
    audit: {
      async append(event) {
        if (state.failAudit) throw new Error('disk full');
        const text = JSON.stringify({ seq: lines.length + 1, prev, ...event });
        lines.push(text);
        prev = hashLine(text);
        timeline.push({ k: 'audit', event: event.event, cardId: event.cardId, verdict: event.verdict });
      },
    },
  });
  return { gate, store, cards, timeline, lines, state, now: () => t, advance: (ms: number) => void (t += ms) };
}

export const requestKey = (r: Pick<ActionRequest, 'tool' | 'effect' | 'scope' | 'args' | 'chatId' | 'origin'>) =>
  JSON.stringify([r.tool, r.effect, r.scope, r.args, r.chatId ?? null, r.origin]);
