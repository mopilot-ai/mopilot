// A fake card store and audit log with a fixed clock, and builders for gate rules and requests, shared by the gate tests.
import { createHmac } from 'node:crypto';
import {
  type ActionRequest,
  type AuditEvent,
  type Card,
  type CardStatus,
  type CardStore,
  createApprovalGate,
} from '../../../shared/momoCore/approvalGate.ts';
import type { GateRule } from '../../../shared/momoCore/gateRules.ts';

/** The keyed hash every gate in the tests uses. */
export const testHash = Object.assign((text: string) => createHmac('sha256', 'test-key').update(text).digest('hex'), {
  keyed: true as const,
});

export const rule = (over: Partial<GateRule> = {}): GateRule => ({
  id: 'r1',
  behavior: 'allow',
  tool: 'gmail.*',
  effect: 'send',
  scope: '*@example.com',
  text: 'Send to example.com without asking',
  ...over,
});
export const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  tool: 'gmail.send',
  effect: 'send',
  scope: 'dana@example.com',
  args: { to: 'dana@example.com', body: 'Hi' },
  origin: 'chat',
  chatId: 'c1',
  tainted: false,
  summary: 'Send a mail to Dana',
  ...over,
});

export function harness(opts: { auditFails?: () => boolean; lose?: { transitions: boolean; vanish: boolean } } = {}) {
  let t = 1_000_000;
  let n = 0;
  const cards = new Map<string, Card>();
  const lines: AuditEvent[] = [];
  const store: CardStore = {
    async get(id) {
      return opts.lose?.vanish && cards.get(id)?.status === 'open'
        ? ((opts.lose.vanish = false), cards.get(id))
        : opts.lose?.transitions
          ? undefined
          : cards.get(id);
    },
    async put(card) {
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
      if (!card || card.status !== expected || opts.lose?.transitions) return undefined;
      const next = { ...card, ...patch };
      cards.set(id, next);
      return next;
    },
  };
  const gate = createApprovalGate({
    now: () => t,
    newId: () => `card${++n}`,
    hash: testHash,
    store,
    audit: {
      async append(event) {
        if (opts.auditFails?.()) throw new Error('disk full');
        lines.push(event);
      },
    },
  });
  return {
    gate,
    store,
    cards,
    lines,
    advance: (ms: number) => void (t += ms),
    setStatus: (id: string, status: CardStatus) => cards.set(id, { ...(cards.get(id) as Card), status }),
  };
}
