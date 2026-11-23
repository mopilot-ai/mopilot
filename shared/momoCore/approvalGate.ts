// MoMo's approval gate as plain code: unprompted work may only read, then deny rules, reads and own notes, spend and settings always ask, a chat that holds outside content always asks, ask rules, allow rules, otherwise ask; an ask is a card bound to the exact action, arguments, chat, origin and taint, answered once on any device, used once within 5 minutes of the answer, expiring as a deny after 30 minutes when no one started it in chat; the audit line is written before every state change that lets an action run (gate logic after rakazo action-approval.ts and approval-expiry.ts, Apache-2.0, see NOTICE; no Auto checker).
import { type ActionRequest, type Reason, type RunOrigin, type Verdict, canonicalJson, decide, effectiveRequest } from './gateDecide.ts';
import type { Effect, GateRule } from './gateRules.ts';
import { clip, sanitizeLabel } from './text.ts';

export {
  type ActionRequest,
  type Decision,
  type Reason,
  type RunOrigin,
  type Verdict,
  canonicalJson,
  decide,
  effectiveRequest,
} from './gateDecide.ts';

export const UNATTENDED_EXPIRY_MS = 30 * 60_000;
/** An answered card that is not used within this time is void. */
export const ALLOWED_TTL_MS = 5 * 60_000;
/** An unattended repeat of an action the owner denied (or that expired) is refused for this long. */
export const REPEAT_DENIED_MS = 24 * 3_600_000;
/** A card claimed for answering or use that nobody finished is given up after this long. */
export const STALE_CLAIM_MS = 60_000;
/** `deciding` and `using` are claims held while the audit line is written; they never let an action run. */
export type CardStatus = 'open' | 'deciding' | 'allowed' | 'using' | 'denied' | 'expired' | 'used';

export interface Card {
  id: string;
  /** A keyed digest of the exact tool, effect, scope, arguments, chat, origin and taint the card was made for. */
  fingerprint: string;
  /** The same digest without the taint: the action a card may be used for, whatever the chat has read since. */
  bindKey: string;
  /** A keyed digest of the action without its arguments: what an unattended repeat is recognised by. */
  actionKey: string;
  tool: string;
  effect: Effect;
  scope: string;
  summary: string;
  origin: RunOrigin;
  chatId?: string;
  tainted: boolean;
  reason: Reason;
  createdAt: number;
  /** Null for a card started from chat: it waits until answered. A background task's card ends as a deny at this time. */
  expiresAt: number | null;
  status: CardStatus;
  decidedAt?: number;
  /** Set by the Host from the authenticated session of the device that answered; the core never verifies it. */
  decidedBy?: string;
  /** What the answering device is called, for "answered on Dana's iPhone"; never an identifier. */
  decidedName?: string;
  /** An allowed card is void after this time. */
  allowedUntil?: number;
  usedAt?: number;
  /** Why an expired card ended; only an unattended timeout counts as a refusal. */
  expiredWhy?: 'unattended_timeout' | 'allowed_not_used' | 'taint_changed' | 'moved' | 'changed' | 'dropped' | 'superseded';
  /** The card this one replaces: the same question asked again because the chat became tainted after the owner answered. */
  replaces?: string;
  /** The request's `fence`: the Host checks it is still current before it acts on an answer. */
  fence?: string;
  fields?: { label: string; value: string }[];
  /** How the action ended, set by the Host after it ran (the core only knows the card was spent). */
  outcome?: 'completed' | 'failed' | 'uncertain';
  failure?: { cause: string };
}

export interface CardStore {
  get(id: string): Promise<Card | undefined>;
  put(card: Card): Promise<void>;
  /** Cards in any of these statuses (all when omitted). */
  list(statuses?: readonly CardStatus[]): Promise<Card[]>;
  /** Cards made for this fingerprint, newest first, so a check does not scan the whole store. */
  byFingerprint(fingerprint: string): Promise<Card[]>;
  /** Atomic: applies the patch only if the card is in the expected status, and returns the updated card; undefined when it was not. */
  transition(id: string, expected: CardStatus, patch: Partial<Card>): Promise<Card | undefined>;
}

export type AuditEventName =
  | 'action.allowed'
  | 'action.refused'
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.expired'
  | 'approval.consumed'
  | 'approval.policy.changed'
  | 'notes.changed'
  | 'learning.reacted'
  | 'google.changed'
  | 'question.asked'
  | 'question.answered';

/** One metadata-only line for the hash-chained audit log: never message text or arguments. */
export interface AuditEvent {
  event: AuditEventName;
  at: number;
  tool?: string;
  effect?: Effect;
  fingerprint?: string;
  cardId?: string;
  origin?: RunOrigin;
  chatId?: string;
  verdict?: Verdict | 'allowed' | 'denied' | 'expired';
  reason?: Reason | string;
  ruleId?: string;
  by?: string;
}

export interface AuditSink {
  /** Must resolve only once the line is on disk; rejects when it could not be written. */
  append(event: AuditEvent): Promise<void>;
}

/** A digest keyed with a secret (an HMAC), so cards and audit lines never let anyone test a guess at the arguments. Mark it `keyed: true`; the gate refuses to start without it. */
export type KeyedHash = ((text: string) => string) & { keyed: true };

export interface GateDeps {
  now: () => number;
  newId: () => string;
  hash: KeyedHash;
  store: CardStore;
  audit: AuditSink;
  allowedTtlMs?: number;
  staleClaimMs?: number;
}

export type CheckResult =
  | { verdict: 'allow'; reason: Reason; ruleId?: string }
  | { verdict: 'deny'; reason: Reason; ruleId?: string }
  | { verdict: 'ask'; reason: Reason; card: Card };

export type AnswerResult = { won: true; card: Card } | { won: false; status: CardStatus | 'missing' | 'audit_unavailable' };
export type AuthorizeResult =
  | { ok: true; card: Card }
  | {
      ok: false;
      reason: 'missing' | 'not_answered' | 'not_allowed' | 'mismatch' | 'used' | 'expired' | 'policy_denied' | 'audit_unavailable';
    }
  /** The chat became tainted after the owner approved: that approval is void and this fresh card asks the same question again ("Ask again"). */
  | { ok: false; reason: 'reissue'; card: Card };
export interface CardChange {
  cardId: string;
  status: CardStatus;
  /** The device that answered; absent for a new, used or expired card. */
  by?: string;
}

export function createApprovalGate(deps: GateDeps) {
  if ((deps.hash as { keyed?: boolean }).keyed !== true) throw new TypeError('the gate needs a keyed hash');
  const allowedTtl = deps.allowedTtlMs ?? ALLOWED_TTL_MS;
  const staleClaim = deps.staleClaimMs ?? STALE_CLAIM_MS;
  const listeners = new Set<(change: CardChange) => void>();
  const notify = (card: Card) =>
    listeners.forEach((fn) =>
      fn({ cardId: card.id, status: card.status, ...(card.decidedBy && card.status !== 'expired' ? { by: card.decidedBy } : {}) }),
    );
  /** Throws when the arguments are not plain data. */
  const keyOf = (req: ActionRequest, tainted: boolean | null) =>
    deps.hash(
      canonicalJson({
        tool: req.tool,
        effect: req.effect,
        scope: req.scope,
        args: req.args,
        chat: req.chatId ?? null,
        origin: req.origin,
        tainted,
      }),
    );
  const fingerprintOf = (req: ActionRequest) => keyOf(req, req.tainted);
  const bindKeyOf = (req: ActionRequest) => keyOf(req, null);
  const actionKeyOf = (req: ActionRequest) =>
    deps.hash(canonicalJson({ action: [req.tool, req.effect, req.scope, req.chatId ?? null, req.origin] }));
  const record = async (event: Omit<AuditEvent, 'at'>): Promise<boolean> => {
    try {
      await deps.audit.append({ ...event, at: deps.now() });
      return true;
    } catch {
      return false;
    }
  };
  /** Where a card stands now, for the loser of a race. */
  const statusNow = async (id: string): Promise<CardStatus | 'missing'> => (await deps.store.get(id))?.status ?? 'missing';
  const meta = (card: Card) => ({
    cardId: card.id,
    fingerprint: card.fingerprint,
    tool: card.tool,
    effect: card.effect,
    origin: card.origin,
    chatId: card.chatId,
  });

  async function expire(card: Card, from: 'open' | 'allowed', why: NonNullable<Card['expiredWhy']>): Promise<Card | undefined> {
    const done = await deps.store.transition(card.id, from, { status: 'expired', decidedAt: deps.now(), expiredWhy: why });
    if (!done) return undefined;
    // An expiry is a deny; if its line cannot be written the card still ends, and the next sweep has nothing to redo.
    await record({
      ...meta(done),
      event: 'approval.expired',
      verdict: 'expired',
      reason: why,
    });
    notify(done);
    return done;
  }

  /** Makes an open card for a request and writes `approval.requested` first; undefined when the line cannot be written. */
  async function issue(req: ActionRequest, fingerprint: string, reason: Reason, replaces?: string): Promise<Card | undefined> {
    const now = deps.now();
    const card: Card = {
      id: deps.newId(),
      fingerprint,
      bindKey: bindKeyOf(req),
      actionKey: actionKeyOf(req),
      tool: req.tool,
      effect: req.effect,
      scope: req.scope,
      summary: req.summary,
      origin: req.origin,
      ...(req.chatId ? { chatId: req.chatId } : {}),
      tainted: req.tainted,
      reason,
      createdAt: now,
      expiresAt: req.origin === 'chat' ? null : now + UNATTENDED_EXPIRY_MS,
      status: 'open',
      ...(replaces ? { replaces } : {}),
      ...(req.fence ? { fence: req.fence } : {}),
      ...(req.fields?.length
        ? {
            fields: req.fields
              .slice(0, 12)
              .map((f) => ({ label: sanitizeLabel(f.label, 'Detail'), value: clip(f.value.replace(/[\p{Cc}\p{Cf}]/gu, ' '), 1100) })),
          }
        : {}),
    };
    if (
      !(await record({
        ...meta(card),
        event: 'approval.requested',
        verdict: 'ask',
        reason,
        ...(replaces ? { by: `replaces:${replaces}` } : {}),
      }))
    )
      return undefined;
    await deps.store.put(card);
    notify(card);
    return card;
  }

  return {
    /** Decides a request, writes the decision to the audit log first, and for an ask returns the card (the same card when the same action is already waiting or just answered). */
    async check(input: ActionRequest, rules: readonly GateRule[]): Promise<CheckResult> {
      const req = effectiveRequest(input);
      let fingerprint: string;
      try {
        fingerprint = fingerprintOf(req);
      } catch {
        await record({
          event: 'action.refused',
          tool: req.tool,
          effect: req.effect,
          origin: req.origin,
          chatId: req.chatId,
          verdict: 'deny',
          reason: 'unhashable_args',
        });
        return { verdict: 'deny', reason: 'unhashable_args' };
      }
      let decision = decide(req, rules);
      let known: Card[] = [];
      if (decision.verdict === 'ask') {
        known = await deps.store.byFingerprint(fingerprint);
        const now = deps.now();
        // A card still waiting, or answered and not yet void, comes first: it is the answer to this very action.
        const waiting = known.find(
          (c) => c.status === 'open' || c.status === 'deciding' || (c.status === 'allowed' && (c.allowedUntil as number) > now),
        );
        if (waiting) return { verdict: 'ask', reason: decision.reason, card: waiting };
        // An unattended repeat of what the owner denied (or that timed out unanswered) is refused for a day, unless the owner said yes since; the owner asking again in chat always gets a fresh card.
        // It is the same action whatever its arguments: a task that asks again with one word changed is the same ask.
        const key = actionKeyOf(req);
        const sameAction =
          req.origin === 'chat'
            ? []
            : (await deps.store.list(['denied', 'expired', 'allowed', 'using', 'used'])).filter((c) => c.actionKey === key);
        const lastYes = Math.max(
          0,
          ...sameAction.filter((c) => ['allowed', 'using', 'used'].includes(c.status)).map((c) => c.decidedAt as number),
        );
        const refused =
          req.origin !== 'chat' &&
          sameAction.some(
            (c) =>
              (c.status === 'denied' || (c.status === 'expired' && c.expiredWhy === 'unattended_timeout')) &&
              (c.decidedAt as number) > lastYes &&
              now - (c.decidedAt as number) < REPEAT_DENIED_MS,
          );
        if (refused) decision = { verdict: 'deny', reason: 'repeats_denied' };
      }
      const base = {
        tool: req.tool,
        effect: req.effect,
        fingerprint,
        origin: req.origin,
        chatId: req.chatId,
        reason: decision.reason,
        ruleId: decision.ruleId,
      };
      if (decision.verdict === 'ask') {
        const card = await issue(req, fingerprint, decision.reason);
        return card ? { verdict: 'ask', reason: decision.reason, card } : { verdict: 'deny', reason: 'audit_unavailable' };
      }
      const ok = await record({
        ...base,
        event: decision.verdict === 'allow' ? 'action.allowed' : 'action.refused',
        verdict: decision.verdict,
      });
      if (!ok) return { verdict: 'deny', reason: 'audit_unavailable' };
      return { verdict: decision.verdict, reason: decision.reason, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
    },

    /** The first answer from any device wins; the rest see who won. The `approval.decided` line is on disk before the card can be used. */
    async answer(cardId: string, decision: 'allow' | 'deny', by: string, byName?: string): Promise<AnswerResult> {
      const card = await deps.store.get(cardId);
      if (!card) return { won: false, status: 'missing' };
      if (card.status === 'open' && card.expiresAt !== null && deps.now() >= card.expiresAt) {
        await expire(card, 'open', 'unattended_timeout');
        return { won: false, status: 'expired' };
      }
      const claimed = await deps.store.transition(cardId, 'open', {
        status: 'deciding',
        decidedAt: deps.now(),
        decidedBy: by,
        ...(byName ? { decidedName: sanitizeLabel(byName, 'a device') } : {}),
      });
      if (!claimed) return { won: false, status: await statusNow(cardId) };
      const status: CardStatus = decision === 'allow' ? 'allowed' : 'denied';
      if (!(await record({ ...meta(claimed), event: 'approval.decided', verdict: status, by }))) {
        await deps.store.transition(cardId, 'deciding', { status: 'open', decidedAt: undefined, decidedBy: undefined });
        return { won: false, status: 'audit_unavailable' };
      }
      const done = await deps.store.transition(cardId, 'deciding', {
        status,
        ...(decision === 'allow' ? { allowedUntil: deps.now() + allowedTtl } : {}),
      });
      if (!done) return { won: false, status: await statusNow(cardId) };
      notify(done);
      return { won: true, card: done };
    },

    /** Spends an allowed card, once, on the exact action, chat, origin and taint it was made for. The rules are read again: a deny added since, or the unprompted floor, still refuses. */
    async authorize(cardId: string, input: ActionRequest, rules: readonly GateRule[]): Promise<AuthorizeResult> {
      const req = effectiveRequest(input);
      const card = await deps.store.get(cardId);
      if (!card) return { ok: false, reason: 'missing' };
      if (card.status === 'used' || card.status === 'using') return { ok: false, reason: 'used' };
      if (card.status === 'open' || card.status === 'deciding') return { ok: false, reason: 'not_answered' };
      if (card.status !== 'allowed') return { ok: false, reason: 'not_allowed' };
      let bindKey: string | undefined;
      try {
        bindKey = bindKeyOf(req);
      } catch {
        bindKey = undefined;
      }
      if (bindKey !== card.bindKey) return { ok: false, reason: 'mismatch' };
      if (deps.now() >= (card.allowedUntil as number)) {
        await expire(card, 'allowed', 'allowed_not_used');
        return { ok: false, reason: 'expired' };
      }
      if (decide(req, rules).verdict === 'deny') return { ok: false, reason: 'policy_denied' };
      // Approved before the chat read outside content: that approval is void, and the same question comes back as a fresh card.
      if (req.tainted && !card.tainted) {
        const voided = await expire(card, 'allowed', 'taint_changed');
        if (!voided) return { ok: false, reason: 'used' };
        const fresh = await issue(req, fingerprintOf(req), 'tainted', card.id);
        return fresh ? { ok: false, reason: 'reissue', card: fresh } : { ok: false, reason: 'audit_unavailable' };
      }
      const claimed = await deps.store.transition(cardId, 'allowed', { status: 'using', usedAt: deps.now() });
      if (!claimed) return { ok: false, reason: 'used' };
      if (!(await record({ ...meta(claimed), event: 'approval.consumed' }))) {
        await deps.store.transition(cardId, 'using', { status: 'allowed', usedAt: undefined });
        return { ok: false, reason: 'audit_unavailable' };
      }
      const done = await deps.store.transition(cardId, 'using', { status: 'used' });
      if (!done) return { ok: false, reason: 'used' };
      notify(done);
      return { ok: true, card: done };
    },

    /** Ends overdue cards as a deny (open ones past their time, allowed ones never used), gives up claims nobody finished, and returns the cards it expired. The Host runs this on a timer and tells each waiting run nobody answered. */
    async sweep(): Promise<Card[]> {
      const now = deps.now();
      const ended: Card[] = [];
      for (const card of await deps.store.list(['open', 'allowed', 'deciding', 'using'])) {
        if (card.status === 'open' && card.expiresAt !== null && now >= card.expiresAt) {
          const done = await expire(card, 'open', 'unattended_timeout');
          if (done) ended.push(done);
        } else if (card.status === 'allowed' && now >= (card.allowedUntil as number)) {
          const done = await expire(card, 'allowed', 'allowed_not_used');
          if (done) ended.push(done);
        } else if (card.status === 'deciding' && now - (card.decidedAt as number) >= staleClaim) {
          await deps.store.transition(card.id, 'deciding', { status: 'open', decidedAt: undefined, decidedBy: undefined });
        } else if (card.status === 'using' && now - (card.usedAt as number) >= staleClaim) {
          // Interrupted mid-use: the action may or may not have run, so the card is spent and never re-run.
          await deps.store.transition(card.id, 'using', { status: 'used' });
        }
      }
      return ended;
    },

    /** Cards still waiting, for any device that opens the app. */
    async pending(): Promise<Card[]> {
      return deps.store.list(['open', 'deciding']);
    },

    /** Ends a card that was never answered, or answered and not used, because it can no longer be used (the home moved). Counts as no refusal. */
    async voidCard(cardId: string, why: NonNullable<Card['expiredWhy']>): Promise<Card | undefined> {
      const card = await deps.store.get(cardId);
      return card && (card.status === 'open' || card.status === 'allowed') ? expire(card, card.status, why) : undefined;
    },

    /** Writes another change the owner made (notes, a rule from a tap) to the audit log. */
    audit(event: Omit<AuditEvent, 'at'>): Promise<boolean> {
      return record(event);
    },

    /** Writes an owner's change to the rules to the audit log. */
    async policyChanged(ruleId: string, change: 'added' | 'edited' | 'removed', by: string): Promise<boolean> {
      return record({ event: 'approval.policy.changed', ruleId, reason: change, by });
    },

    subscribe(listener: (change: CardChange) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
