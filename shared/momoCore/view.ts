// What the clients draw from the core's records (the contract of shared/momoView.ts, #5482): an approval card, a note with its lines and history, a rule and the early signals one reaction short of a rule. Pure: the Host passes in what it knows (the viewing device, undo entries, how often a rule was used).
import type { MomoApprovalView, MomoNoteView, MomoRuleSignalView, MomoRuleView } from '../momoView.ts';
import type { Card } from './approvalGate.ts';
import type { JournalEntry } from './noteOps.ts';
import { type NotesTree, statusOf } from './notes.ts';
import { type LearnState, type LearnedRule, currentRun, ruleTextOf, turnsOnAtOnce } from './learning.ts';

const APPROVAL: Record<Card['status'], MomoApprovalView['status']> = {
  open: 'pending',
  deciding: 'pending',
  allowed: 'approved',
  denied: 'denied',
  expired: 'expired',
  using: 'consumed',
  used: 'consumed',
};

const DECIDED: ReadonlySet<Card['status']> = new Set(['allowed', 'denied', 'using', 'used']);

export interface ApprovalViewInput {
  /** The Host itself runs what the card is for, and it still waits: Edit is offered. */
  editable?: boolean;
  /** The device asking; an answer from another device shows as answered elsewhere. */
  device: string;
  /** How the action ended, reported by the Host (the core only knows the card was spent). */
  outcome?: 'completed' | 'failed' | 'uncertain';
  failure?: { cause: string; fix: { id: string; label: string } | null };
}

export function approvalView(card: Card, input: ApprovalViewInput): MomoApprovalView {
  const outcome = input.outcome ?? card.outcome;
  // a status a newer Host made up is passed on as it is: the client shows it as unknown and offers nothing
  // a card of a home that is no longer the home is `void`: it can no longer be answered, and asking again is not offered on it
  const voided = card.status === 'expired' && ['moved', 'changed', 'dropped', 'superseded'].includes(card.expiredWhy ?? '');
  const status = outcome ?? (voided ? 'void' : (APPROVAL[card.status] ?? card.status));
  const decided = card.decidedBy !== undefined && DECIDED.has(card.status);
  const elsewhere = decided && card.decidedBy !== input.device;
  return {
    id: card.id,
    action: 'other',
    title: card.summary,
    recipients: [],
    subject: null,
    attachments: [],
    body: card.summary,
    fields: [{ label: 'Action', value: card.tool }, { label: 'Touches', value: card.scope }, ...(card.fields ?? [])],
    expiresAt: card.expiresAt,
    status: elsewhere && status === 'denied' ? 'answered-elsewhere' : status,
    answeredElsewhere: elsewhere
      ? {
          device: card.decidedName ?? 'another device',
          at: card.decidedAt as number,
          outcome: card.status === 'denied' ? 'denied' : 'approved',
        }
      : null,
    failure:
      voided && card.expiredWhy === 'changed'
        ? { cause: 'The note changed after you were asked, so nothing was applied.', fix: null }
        : voided && card.expiredWhy === 'superseded'
          ? { cause: card.failure?.cause ?? 'You changed this card: the new one replaces it.', fix: null }
          : outcome === 'failed' && (input.failure ?? card.failure)
            ? ((input.failure ?? { cause: (card.failure as { cause: string }).cause, fix: null }) as MomoApprovalView['failure'])
            : null,
    canAskAgain: (card.status === 'expired' && !voided) || card.status === 'denied' || outcome === 'uncertain',
    editable: !!input.editable && card.status === 'open',
  };
}

export interface NoteViewInput {
  journal: readonly JournalEntry[];
  /** Journal entries that still have an undo entry. */
  undoable: ReadonlySet<string>;
}

const when = (iso: string) => Date.parse(iso);
const SOURCE_LABEL = { mail: 'Mail', event: 'Calendar', chat: 'Chat' } as const;

export function noteViews(tree: NotesTree, input: NoteViewInput): MomoNoteView[] {
  const changes = input.journal.map((j) => ({
    id: j.id,
    at: when(j.at),
    summary: j.summary.join(' '),
    undoable: input.undoable.has(j.id),
    trigger: j.trigger,
  }));
  const view = (line: NotesTree['notes'][number]['lines'][number], archived: boolean) => ({
    id: line.id,
    text: line.text,
    at: when(line.updated),
    status: ({ 'Mentioned once': 'mentioned-once', Learned: 'learned', Confirmed: 'confirmed', 'Let go': 'let-go' } as const)[
      statusOf(line, archived)
    ],
    quote: line.quote || null,
    sources: line.sources.map((s) => ({
      id: s.sourceId,
      kind: s.kind,
      label: SOURCE_LABEL[s.kind] ?? 'Source',
      at: when(s.at),
      gone: false,
    })),
  });
  return tree.notes.map((note) => {
    const own = input.journal.filter((j) => j.ops.some((o) => o.noteId === note.id));
    const history = own.map((j) => changes.find((c) => c.id === j.id) as (typeof changes)[number]).map(({ trigger: _t, ...rest }) => rest);
    const nightly = own.filter((j) => j.trigger === 'nightly').at(-1);
    return {
      id: note.id,
      title: note.title,
      kind: note.kind,
      updatedAt: when(note.updated),
      lastChange: nightly ? (history.find((h) => h.id === nightly.id) as MomoNoteView['lastChange']) : null,
      lines: [...note.lines.map((l) => view(l, false)), ...tree.archive.filter((a) => a.noteId === note.id).map((a) => view(a, true))],
      history,
    };
  });
}

const EFFECT: Record<string, string> = { quieter: 'stay_quiet', more: 'tell_now', skip_question: 'dont_ask', ask_again: 'ask_first' };
const STATE = { on: 'on', proposed: 'suggested', suggested: 'suggested', declined: 'off', retired: 'undone' } as const;

/**
 * `instructionsApplied`: whether something already reads the owner's rules in words (the notice judge and the brain's turn). Until it does, such a rule that is on is `saved`, never `on`: the page must not show it as active while nothing applies it.
 */
export function ruleView(rule: LearnedRule, uses: number, instructionsApplied = true): MomoRuleView {
  return {
    id: rule.id,
    text: ruleTextOf(rule),
    kind: turnsOnAtOnce(rule.stance) || rule.ownerEffect === 'stay_quiet' || rule.ownerEffect === 'ask_first' ? 'quieter' : 'does-more',
    effect: EFFECT[rule.stance] ?? rule.ownerEffect ?? (rule.stance === 'instruction' ? 'instruction' : 'draft_style'),
    origin: rule.reactions.length ? 'learned' : 'yours',
    state: rule.stance === 'instruction' && rule.status === 'on' && !instructionsApplied ? 'saved' : (STATE[rule.status] ?? rule.status),
    appliesTo: rule.label,
    evidence: rule.reactions.map((r) => ({ at: r.at, reaction: r.kind, item: r.label })),
    useCount: uses,
    inBrief: rule.stance === 'quieter',
  };
}

export const ruleViews = (state: LearnState, uses: Readonly<Record<string, number>> = {}, instructionsApplied = true): MomoRuleView[] =>
  state.rules.map((r) => ruleView(r, uses[r.id] ?? 0, instructionsApplied));

/** Patterns with one reaction that counts and no rule yet: "Make it a rule" or "Ignore". */
export function signalViews(state: LearnState): MomoRuleSignalView[] {
  const patterns = [...new Set(state.reactions.map((r) => r.pattern))];
  return patterns.flatMap((pattern) => {
    const run = currentRun(state, pattern);
    if (run?.reactions.length !== 1) return [];
    return [{ id: pattern, text: `You tapped once on ${run.reactions[0].label}.` }];
  });
}
