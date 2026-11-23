// How MoMo learns from what the owner does: each tap (Not needed, dismiss, snooze, Always allow, Deny, a draft edit) is a reaction recorded against a pattern; two in a row that agree propose a rule, a reaction the other way retires the opposed rule at once and starts the count again, silence is never a reaction; a rule that only makes MoMo quieter or asks more turns on at once with Undo, a rule that does more, skips a question or rewrites drafts waits for a tap; every rule is editable text that keeps the reactions that made it, and the pattern is stored as data, so a sender's name never becomes an instruction. Our own design (nod and rakazo have no such learning).
import type { Effect, GateRule } from './gateRules.ts';
import { escapeGlob } from './gateRules.ts';
import { foldQuote, sanitizeLabel } from './text.ts';

/** Reactions in a row that must agree before a rule is proposed. */
export const REACTIONS_NEEDED = 2;
export const RULE_TEXT_MAX = 300;
/** How many suggested rules wait for a tap at once: what is given in words cannot pile up without the owner looking. */
export const SUGGESTED_MAX = 20;
/** How many rules written in words the owner may keep that are on or waiting (turned down and undone ones are forgotten after ENDED_KEEP_MS). */
export const OWNER_RULES_MAX = 100;
/** How long a rule the owner turned down or undid is kept, so it is not suggested again at once. */
export const ENDED_KEEP_MS = 30 * 24 * 3600_000;

/** The rules without the ones turned down or undone long ago. */
const pruned = (state: LearnState, at: number): LearnState => ({
  ...state,
  rules: state.rules.filter((r) => !((r.status === 'declined' || r.status === 'retired') && at - (r.decidedAt as number) > ENDED_KEEP_MS)),
});

export type ReactionKind = 'not_needed' | 'dismiss' | 'snooze' | 'keep' | 'always_allow' | 'deny' | 'draft_edit';
export type Stance = 'quieter' | 'more' | 'skip_question' | 'ask_again' | 'instruction' | `edit:${string}`;
/** `proposed`: made from reactions. `suggested`: made from an order the owner gave in words. Both wait for a tap. */
export type RuleStatus = 'on' | 'proposed' | 'suggested' | 'declined' | 'retired';

export interface ActionShape {
  tool: string;
  effect: Effect;
  scope: string;
}

export interface Reaction {
  id: string;
  at: number;
  /** What the reaction is about, chosen by the caller: `notice:sender:acme.com`, `action:gmail.send:dana@x.com`, `draft:tone`. */
  pattern: string;
  /** The pattern in words ("mail from Acme"), made safe when recorded. */
  label: string;
  kind: ReactionKind;
  /** For a draft edit: the lesson in words ("shorter"), the same words for the same lesson. */
  detail?: string;
  /** For Always allow and Deny: the action the card was for. */
  action?: ActionShape;
}

export interface LearnedRule {
  id: string;
  pattern: string;
  stance: Stance;
  /** The pattern in words, sanitized. The rule's sentence is made from it when shown (`ruleTextOf`). */
  label: string;
  detail?: string;
  /** The owner's own wording, when they rewrote the rule. */
  editedText?: string;
  status: RuleStatus;
  /** The reactions that created it, kept for as long as the rule exists. */
  reactions: Reaction[];
  createdAt: number;
  decidedAt?: number;
  /** For a skip-a-question or ask-again rule: the action it applies to. */
  action?: ActionShape;
  /** For a suggested rule: the owner's words it came from. */
  source?: { sourceId: string; quote: string };
  /** For a rule the owner wrote in words: what they said it should do. Never `dont_ask`: a rule that stops MoMo asking is made from a card's Always allow, which names the action. */
  ownerEffect?: OwnerEffect;
}

export const OWNER_EFFECTS = ['tell_now', 'stay_quiet', 'ask_first'] as const;
export type OwnerEffect = (typeof OWNER_EFFECTS)[number];

export interface LearnState {
  reactions: Reaction[];
  rules: LearnedRule[];
  /** Per pattern: reactions up to this time no longer count (the owner declined or undid a rule). */
  since: Record<string, number>;
}

export const emptyLearning = (): LearnState => ({ reactions: [], rules: [], since: {} });

const KINDS: readonly string[] = ['not_needed', 'dismiss', 'snooze', 'keep', 'always_allow', 'deny', 'draft_edit'];

/** What a reaction asks for. Undefined when it says nothing (a draft edit without a lesson). */
export function stanceOf(kind: ReactionKind, detail?: string): Stance | undefined {
  switch (kind) {
    case 'not_needed':
    case 'dismiss':
    case 'snooze':
      return 'quieter';
    case 'keep':
      return 'more';
    case 'always_allow':
      return 'skip_question';
    case 'deny':
      return 'ask_again';
    case 'draft_edit':
      return detail?.trim() ? `edit:${detail.trim().toLowerCase()}` : undefined;
  }
}

/** The stance a reaction undoes: Not needed against Keep, Always allow against Deny, one draft lesson against another. */
export function opposes(a: Stance, b: Stance): boolean {
  if (a === b) return false;
  const pairs: Array<[Stance, Stance]> = [
    ['quieter', 'more'],
    ['skip_question', 'ask_again'],
  ];
  if (pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return true;
  return a.startsWith('edit:') && b.startsWith('edit:');
}

/** A rule that makes MoMo quieter or asks more is safe to turn on at once; the others change what MoMo does on its own and wait. */
export const turnsOnAtOnce = (stance: Stance): boolean => stance === 'quieter' || stance === 'ask_again';

/** The rule's sentence, made from structured data when shown. */
export function ruleTextOf(rule: Pick<LearnedRule, 'stance' | 'label' | 'detail' | 'editedText'>): string {
  if (rule.editedText) return rule.editedText;
  switch (rule.stance) {
    case 'quieter':
      return `Stay quiet about ${rule.label}.`;
    case 'more':
      return `Tell me more about ${rule.label}.`;
    case 'skip_question':
      return `Don't ask before ${rule.label}.`;
    case 'ask_again':
      return `Always ask before ${rule.label}.`;
    default:
      return `In drafts: ${rule.detail ?? rule.stance.slice(5)} (${rule.label}).`;
  }
}

export interface LearnDeps {
  newId: () => string;
  now: () => number;
}

export type LearnChange =
  | { kind: 'none'; why: 'unknown_reaction' | 'counted' }
  | { kind: 'proposed'; rule: LearnedRule }
  | { kind: 'activated'; rule: LearnedRule };

const sameAction = (a: ActionShape, b?: ActionShape) =>
  b !== undefined && a.tool === b.tool && a.effect === b.effect && a.scope === b.scope;
const live = (r: LearnedRule) => r.status === 'on' || r.status === 'proposed' || r.status === 'suggested';
const actionKey = (r: Reaction) => (r.action ? `${r.action.tool}|${r.action.effect}|${r.action.scope}` : '');
const keyOf = (r: Reaction) => `${stanceOf(r.kind, r.detail)}|${actionKey(r)}`;

/** The reactions at the end of a pattern's history that agree (same stance, same action) and still count. */
export function currentRun(state: LearnState, pattern: string): { stance: Stance; reactions: Reaction[] } | undefined {
  const from = state.since[pattern] ?? -Infinity;
  const own = state.reactions.filter((r) => r.pattern === pattern && r.at > from);
  const last = own.at(-1);
  const stance = last && stanceOf(last.kind, last.detail);
  if (!last || !stance) return undefined;
  const run: Reaction[] = [];
  for (const r of own.slice().reverse()) {
    if (keyOf(r) !== keyOf(last)) break;
    run.unshift(r);
  }
  return { stance, reactions: run };
}

/** Records one reaction. Only a tap is a reaction: anything else (a timeout, silence, an unknown kind) changes nothing. A reaction the other way retires the opposed rules on that pattern at once. */
export function record(
  state: LearnState,
  input: Omit<Reaction, 'id' | 'at'>,
  deps: LearnDeps,
): { state: LearnState; change: LearnChange; retired: LearnedRule[] } {
  const detail = input.detail === undefined ? undefined : sanitizeLabel(input.detail, '');
  const stance = KINDS.includes(input.kind) ? stanceOf(input.kind, detail) : undefined;
  if (!stance || !input.pattern) return { state, change: { kind: 'none', why: 'unknown_reaction' }, retired: [] };
  const at = deps.now();
  const reaction: Reaction = { ...input, ...(detail ? { detail } : {}), label: sanitizeLabel(input.label), id: deps.newId(), at };
  // A reaction undoes the opposed rule on its pattern, and on any pattern for the same action: the owner's latest answer about an action wins.
  const retired = state.rules.filter(
    (r) =>
      live(r) &&
      opposes(r.stance, stance) &&
      (r.pattern === input.pattern || (r.action !== undefined && sameAction(r.action, input.action))),
  );
  const rules = state.rules.map((r) => (retired.includes(r) ? { ...r, status: 'retired' as const, decidedAt: at } : r));
  // The owner's answer about an action ends the count of the opposite answers about it on every other pattern too.
  const since = { ...state.since };
  if (input.action)
    for (const r of state.reactions)
      if (r.pattern !== input.pattern && sameAction(input.action, r.action) && opposes(stance, stanceOf(r.kind, r.detail) as Stance))
        since[r.pattern] = at;
  const next: LearnState = { ...state, rules, since, reactions: [...state.reactions, reaction] };
  const done = retired.map((r) => ({ ...r, status: 'retired' as const, decidedAt: at }));
  const run = currentRun(next, input.pattern);
  if (!run || run.reactions.length < REACTIONS_NEEDED) return { state: next, change: { kind: 'none', why: 'counted' }, retired: done };
  if (rules.some((r) => r.pattern === input.pattern && r.stance === run.stance && live(r)))
    return { state: next, change: { kind: 'none', why: 'counted' }, retired: done };
  const rule: LearnedRule = {
    id: deps.newId(),
    pattern: input.pattern,
    stance: run.stance,
    label: reaction.label,
    ...(reaction.detail ? { detail: reaction.detail } : {}),
    status: turnsOnAtOnce(run.stance) ? 'on' : 'proposed',
    reactions: run.reactions,
    createdAt: at,
    ...(turnsOnAtOnce(run.stance) ? { decidedAt: at } : {}),
    ...(reaction.action ? { action: reaction.action } : {}),
  };
  return {
    state: { ...next, rules: [...rules, rule] },
    change: { kind: rule.status === 'on' ? 'activated' : 'proposed', rule },
    retired: done,
  };
}

function setStatus(state: LearnState, ruleId: string, from: RuleStatus[], status: RuleStatus, at: number): LearnState {
  const rule = state.rules.find((r) => r.id === ruleId);
  if (!rule || !from.includes(rule.status)) return state;
  const latest = Math.max(at, ...state.reactions.filter((r) => r.pattern === rule.pattern).map((r) => r.at));
  return {
    ...state,
    since: { ...state.since, [rule.pattern]: latest },
    rules: state.rules.map((r) => (r === rule ? { ...r, status, decidedAt: at } : r)),
  };
}

/** The owner taps to accept a proposed rule. */
export function confirmRule(state: LearnState, ruleId: string, at: number): LearnState {
  const rule = state.rules.find((r) => r.id === ruleId);
  if (!rule || (rule.status !== 'proposed' && rule.status !== 'suggested')) return state;
  return { ...state, rules: state.rules.map((r) => (r === rule ? { ...r, status: 'on', decidedAt: at } : r)) };
}
/** The owner turns a proposal down; the count for that pattern starts again. */
export const declineRule = (state: LearnState, ruleId: string, at: number): LearnState =>
  setStatus(state, ruleId, ['proposed', 'suggested'], 'declined', at);
/** Undo, or removing a rule later; the count for that pattern starts again. */
export const undoRule = (state: LearnState, ruleId: string, at: number): LearnState =>
  setStatus(state, ruleId, ['on', 'proposed', 'suggested'], 'retired', at);

/** The owner rewrites a rule. It keeps its reactions and its status. */
export function editRule(state: LearnState, ruleId: string, text: string): LearnState {
  const trimmed = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed || trimmed.length > RULE_TEXT_MAX) return state;
  const target = state.rules.find((r) => r.id === ruleId && live(r));
  if (!target) return state;
  return { ...state, rules: state.rules.map((r) => (r === target ? { ...r, editedText: trimmed } : r)) };
}

/** Rules that apply now. */
export const activeRules = (state: LearnState): LearnedRule[] => state.rules.filter((r) => r.status === 'on');

/** The gate rules that active skip-a-question (allow) and ask-again (ask) rules stand for. Values are escaped, so a scope that holds `*` is matched literally. The gate's own limits (unprompted, tainted, mandatory) and its deny rules still come first, and an ask rule beats an allow rule. */
export function toGateRules(state: LearnState): GateRule[] {
  return activeRules(state).flatMap((r) => {
    if (!r.action || (r.stance !== 'skip_question' && r.stance !== 'ask_again')) return [];
    return [
      {
        id: `learned:${r.id}`,
        behavior: r.stance === 'skip_question' ? ('allow' as const) : ('ask' as const),
        tool: escapeGlob(r.action.tool),
        effect: r.action.effect,
        scope: escapeGlob(r.action.scope),
        text: ruleTextOf(r),
      },
    ];
  });
}

/** Turns an owner's order from a chat into a rule that waits for a tap. It is plain text: it never becomes a gate rule by itself, and it does more than MoMo did before, so it is never on until the owner says so. */
export function suggestRule(
  state: LearnState,
  input: { text: string; sourceId: string; quote: string },
  deps: LearnDeps,
): { state: LearnState; rule?: LearnedRule } {
  const text = input.text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > RULE_TEXT_MAX) return { state };
  // the same order again (however it is written: case, spacing, accents) is one suggestion, also one the owner turned down (it is not asked again until the old answer is forgotten), unless they undid it
  const folded = foldQuote(text);
  const same = state.rules.some((r) => r.stance === 'instruction' && r.status !== 'retired' && foldQuote(ruleTextOf(r)) === folded);
  if (same || state.rules.filter((r) => r.status === 'suggested').length >= SUGGESTED_MAX) return { state };
  const id = deps.newId();
  const rule: LearnedRule = {
    id,
    pattern: `instruction:${id}`,
    stance: 'instruction',
    label: '',
    editedText: text,
    status: 'suggested',
    reactions: [],
    createdAt: deps.now(),
    source: { sourceId: input.sourceId, quote: input.quote },
  };
  const kept = pruned(state, deps.now());
  return { state: { ...kept, rules: [...kept.rules, rule] }, rule };
}

/** A rule the owner wrote in words on the Rules page: theirs, on at once, kept as the words they wrote with the effect they chose. It names no action, so it can never become a gate rule (`toGateRules`): it cannot remove a card. */
export function ownerRule(
  state: LearnState,
  input: { text: string; effect: string },
  deps: LearnDeps,
): { state: LearnState; rule?: LearnedRule; reason?: 'invalid' | 'effect' | 'same' | 'full' } {
  const effect = OWNER_EFFECTS.find((e) => e === input.effect);
  if (!effect) return { state, reason: 'effect' };
  const text = input.text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > RULE_TEXT_MAX) return { state, reason: 'invalid' };
  const folded = foldQuote(text);
  if (state.rules.some((r) => r.status !== 'declined' && r.status !== 'retired' && foldQuote(ruleTextOf(r)) === folded))
    return { state, reason: 'same' };
  if (state.rules.filter((r) => r.stance === 'instruction' && ['on', 'proposed', 'suggested'].includes(r.status)).length >= OWNER_RULES_MAX)
    return { state, reason: 'full' };
  const id = deps.newId();
  const at = deps.now();
  const rule: LearnedRule = {
    id,
    pattern: `yours:${id}`,
    stance: 'instruction',
    label: '',
    editedText: text,
    status: 'on',
    reactions: [],
    createdAt: at,
    decidedAt: at,
    ownerEffect: effect,
  };
  const kept = pruned(state, at);
  return { state: { ...kept, rules: [...kept.rules, rule] }, rule };
}

/** The owner turns a rule that was switched off or undone back on: theirs to do, whatever the rule does. */
export function turnOnRule(state: LearnState, ruleId: string, at: number): LearnState {
  const rule = state.rules.find((r) => r.id === ruleId);
  if (!rule) return state;
  // a rule that skips a question removes a card: bringing it back takes the same confirmation as when it was first proposed (it waits for Accept), not one tap
  return setStatus(state, ruleId, ['retired', 'declined'], rule.stance === 'skip_question' ? 'proposed' : 'on', at);
}
