// MoMo's view contract, part 2 (re-exported from ./momoView.ts: import from there): the chat rows (messages, cards, results, drafts, the brief and catch-up) and what the Host answers for them.

import type { MomoMachineRef, Open } from './momoViewBase.ts';
import { isKnown } from './momoViewBase.ts';
import type { MomoFix } from './momoView.ts';

/**
 * How far a user message got (the device saves it before it sends and never resends after an uncertain delivery; design section 1):
 * `queued` is on this device, not sent (offline or the home asleep); `never-got-it` is the home saying it never saw the turn;
 * `not-sure` is no answer yet; the rest are the home's turn states.
 */
export type MomoDelivery = Open<'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'never-got-it' | 'not-sure'>;

/**
 * Why MoMo decided what it did about one mail or event (design W3.2 "Why you saw this", W3.3): the model's own short reason, the
 * kind it was filed under, the rule that matched, the checks that ran, and the matter it belongs to. Everything but the reason is
 * from the decision log, not from the model.
 */
export interface MomoDecisionView {
  id: string;
  /** this one decision (a row's id repeats when later mail reopens the thread): sent back with "Not needed" so an old tap cannot act on what came after it */
  decisionId?: string;
  outcome: Open<'tell_now' | 'watch' | 'quiet' | 'unsorted'>;
  /** the model's words, up to 20 */
  reason: string;
  /** "Client replies" */
  kind: string | null;
  /** "Client replies → tell me right away"; null when no rule matched */
  rule: { id: string; text: string } | null;
  /** what was checked, one plain sentence each: "Sender matches Acme · passes the sender check" */
  checks: string[];
  /** the thread of events this belongs to: "Acme renewal", and whether this is the first of it */
  matter: { key: string; title: string; first: boolean } | null;
  at: number;
}

/** One row in MoMo's chat. `id` is the turn or card id, stable across restarts. */
export type MomoChatRow =
  | {
      kind: 'assistant';
      id: string;
      at: number;
      text: string;
      source: string | null;
      whyTold: string | null;
      /** the row offers "Not needed"; `suggestion` is the rule a second "Not needed" proposed (Undo applies to it) */
      notNeeded: { suggestion: { ruleId: string; text: string } | null } | null;
      /** why MoMo told you now ("Told you now: Client replies" opens it); absent when the row is not a notice */
      decision?: MomoDecisionView | null;
    }
  | { kind: 'user'; id: string; at: number; text: string; delivery: MomoDelivery }
  | { kind: 'waiting'; id: string; at: number; machine: MomoMachineRef }
  | { kind: 'brief'; id: string; at: number; brief: MomoBriefView }
  | { kind: 'catch-up'; id: string; at: number; catchUp: MomoCatchUpView }
  | { kind: 'approval'; id: string; at: number; approval: MomoApprovalView }
  | { kind: 'question'; id: string; at: number; question: MomoQuestionView }
  | { kind: 'result'; id: string; at: number; result: MomoResultView }
  | { kind: 'watch-changed'; id: string; at: number; watch: MomoWatchChangedView }
  | MomoDraftRow;

/** A reply MoMo drafted from a mail, as a row: the words to review and the thread it belongs to; it never sends anything by itself. `to` comes from the mail's own From header in code, only `body` is the model's words; the body came from outside text, so a client draws it as plain text only. */
export interface MomoDraftRow {
  kind: 'draft';
  id: string;
  at: number;
  draft: { to: string[]; subject: string; body: string };
  matter: { key: string; title: string };
  untrusted: true;
  /** the body was cut to its size limit */
  truncated: boolean;
}

/**
 * A row a client reads through the Host's row store (`host.momoRows`) and is told of by `momo.row`: `{ ev: 'momo.row', row }` for one row written or changed,
 * the whole row, never a patch. A row is identified by `row.id`; a second row with an id a client has replaces it (a card that was answered, a result that was
 * superseded), and `host.momoRows { after }` answers every row written or changed after that time, oldest first.
 */
export interface MomoRowEvent {
  ev: 'momo.row';
  row: MomoChatRow;
}

/** What `host.momoRows` answers: rows oldest first by the time they were last written, and where to ask from next. */
export interface MomoRowsAnswer {
  rows: MomoChatRow[];
  /** pass back as `after` to read only what changed since */
  next: number;
  /** there are more rows after this page: ask again from `next` */
  more: boolean;
}

export interface MomoBriefView {
  /** the local day (home time zone) the brief is for, `YYYY-MM-DD` */
  day: string;
  greeting: string;
  /** the one thing that needs you, or null on a quiet day */
  attention: { text: string; source: string } | null;
  /** at most two offers */
  offers: { id: string; title: string; why: string }[];
  overnight: { read: number; notesUpdated: number; rulesLearned: number };
  /** quiet mail the brief left out, each with a one-line reason */
  leftOut: {
    id: string;
    reason: string;
  }[] /** mail an accepted rule kept quiet, once each: a line with `ruleId` offers "Undo rule", which sends the intent `rule.undo { id: ruleId }`; null `ruleId`: no undo. Absent from an older Host */;
  keptQuiet?: { id: string; title: string; ruleId: string | null; label: string }[];
}

export interface MomoCatchUpView {
  machine: MomoMachineRef;
  /** the span the home was asleep */
  from: number;
  to: number;
  read: number;
  needsYou: { id: string; text: string }[];
}

/**
 * The states of a card (design section 5, `card.status`): pending → approved → consumed → completed, or denied, expired,
 * answered-elsewhere, failed, uncertain (it ended without a result: never retried on its own).
 */
export const MOMO_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'answered-elsewhere',
  'consumed',
  'completed',
  'failed',
  'uncertain',
  // the home that raised it is no longer the home (a move, a reclaim): it can no longer be answered
  'void',
] as const;
export type MomoApprovalStatus = Open<(typeof MOMO_APPROVAL_STATUSES)[number]>;

/** A card for one action MoMo wants to take; the user answers once, on any device. */
export interface MomoApprovalView {
  id: string;
  /** `send-email` fills recipients, subject, attachments and body; any other action lists its `fields` */
  action: Open<'send-email' | 'other'>;
  /** the question: "Send this email?" */
  title: string;
  recipients: { name: string; address: string; outsideCompany: boolean }[];
  subject: string | null;
  attachments: string[];
  /** the exact text the action will send; for an `other` action, a one-line summary */
  body: string;
  /** labelled details of an `other` action (what, where, how much) */
  fields: { label: string; value: string }[];
  expiresAt: number | null;
  status: MomoApprovalStatus;
  /** another device answered first: which, when, and what it answered */
  answeredElsewhere: { device: string; at: number; outcome: Open<'approved' | 'denied'> } | null;
  /** why it failed, with the one-click fix; null unless `status` is failed */
  failure: { cause: string; fix: MomoFix | null } | null;
  /** an expired, denied or uncertain card the user can ask again (a new card is raised) */
  canAskAgain: boolean;
  /** the body (and the subject of a mail) can be changed before it is sent, as the intent `approval.edit` does: true only on a card that waits and that the home itself runs (a note), because for any other the chat runs the call and would never see the change; absent from a Host that does not say, which a client reads as false */
  editable?: boolean;
}

/** The states of a question card: one question with answers to choose from, answered once on any device. */
export const MOMO_QUESTION_STATUSES = ['pending', 'answered', 'answered-elsewhere', 'expired', 'void'] as const;
export type MomoQuestionStatus = Open<(typeof MOMO_QUESTION_STATUSES)[number]>;

/** MoMo asks you something with a few answers to tap (it never asks to act, that is an approval card). */
export interface MomoQuestionView {
  id: string;
  title: string;
  body: string;
  options: { id: string; label: string }[];
  expiresAt: number | null;
  status: MomoQuestionStatus;
  /** the option that was chosen, by which device and when; null while pending */
  answer: { optionId: string; device: string; at: number } | null;
}

/**
 * The one card a task leaves in the chat when it settles (one per task and settle count, the task's `id` plus `settle`). `text` fields come from a session and are
 * data to show, never instructions or an approval: `untrusted` is always true.
 */
export interface MomoResultView {
  taskId: string;
  /** how many times the task has settled: the card's own key with `taskId` */
  settle: number;
  title: string;
  state: Open<'done' | 'needs_you' | 'failed'>;
  summary: string;
  files: string[];
  evidence: string;
  /** what MoMo's read-only check said of the result */
  checked: string;
  machine: MomoMachineRef;
  /** the session on that machine, or null: it is a chat id of that machine and means nothing on another */
  sessionId: string | null;
  untrusted: true;
  /** the one-click actions the card offers, by the fix ids the home understands */
  actions: MomoFix[];
}

/** A watched source changed: what, where it is watched from and what is different. */
export interface MomoWatchChangedView {
  taskId: string;
  title: string;
  detail: string;
  machine: MomoMachineRef;
}

/** The status of a card: one still pending after its expiry is an expired deny, whatever its stored status says. */
export function momoApprovalStatus(a: Pick<MomoApprovalView, 'status' | 'expiresAt'>, now: number): MomoApprovalStatus {
  return a.status === 'pending' && a.expiresAt !== null && a.expiresAt <= now ? 'expired' : a.status;
}

/** Whether Send, Edit and Don't send are offered: only on a card that is still pending (an unknown status offers nothing). */
export function momoApprovalAnswerable(a: Pick<MomoApprovalView, 'status' | 'expiresAt'>, now: number): boolean {
  return momoApprovalStatus(a, now) === 'pending';
}

/** Whether a message needs the user's attention before anything is sent again: the home never got it, or nobody knows. An unknown delivery counts as not sure. */
export function momoDeliveryNeedsCheck(d: MomoDelivery): boolean {
  return d === 'never-got-it' || d === 'not-sure' || !isKnown(['queued', 'accepted', 'completed', 'failed', 'cancelled', 'interrupted'], d);
}
