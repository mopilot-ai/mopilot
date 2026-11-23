// The pure half of MoMo's approval gate: what a request is and what the rules and the run say about it (unprompted work may only read, deny rules, owner ask rules, spend and settings always ask, a chat that holds outside content always asks, ask rules, allow rules, otherwise ask), and the stable text of an action that its digest is made from (logic after rakazo action-approval.ts, Apache-2.0, see NOTICE).
import { type Effect, type GateRule, firstMatch } from './gateRules.ts';

/** Effects that always need a person, even with an allow rule. */
const MANDATORY: readonly Effect[] = ['spend', 'settings'];

/** `chat`: the owner is in the conversation. `task`: the owner started it and it runs in the background, so nobody may be watching. `unprompted`: nobody asked (triage, brief, tidy, a routine). */
export type RunOrigin = 'chat' | 'task' | 'unprompted';
export type Verdict = 'allow' | 'deny' | 'ask';
export type Reason =
  | 'read'
  | 'notes'
  | 'unprompted_read_only'
  | 'rule_deny'
  | 'rule_ask'
  | 'ask_unprompted'
  | 'rule_allow'
  | 'tainted'
  | 'mandatory'
  | 'no_rule'
  | 'repeats_denied'
  | 'unhashable_args'
  | 'audit_unavailable';

export interface ActionRequest {
  tool: string;
  effect: Effect;
  /** What the action touches: a recipient, a calendar id, a folder. */
  scope: string;
  args: Record<string, unknown>;
  origin: RunOrigin;
  chatId?: string;
  /** The chat holds outside content (see turnTaint.ts). Sticky until a compaction or a new session drops it. */
  tainted: boolean;
  /** One line for the card. Never the arguments. */
  summary: string;
  /** For a read: `network` when it sends model-chosen text to a third party (a fetch, a search). In a tainted chat such a read counts as a send. */
  egress?: 'none' | 'network';
  /** An opaque mark the Host puts on the card when it is made (the home's id and lease epoch); the core keeps it and does not bind it. */
  fence?: string;
  /** Labelled details for the card, made by the Host from the arguments (what, where, how much). Shown, never bound, never the arguments themselves. */
  fields?: { label: string; value: string }[];
}

export interface Decision {
  verdict: Verdict;
  reason: Reason;
  ruleId?: string;
}

/** A read that can carry data out, in a chat that holds outside content, is a send: planted text could have chosen what it sends. */
export function effectiveRequest(req: ActionRequest): ActionRequest {
  return req.effect === 'read' && req.tainted && req.egress === 'network' ? { ...req, effect: 'send' } : req;
}

/** The pure part: what the rules and the run say, before any card or audit line. */
export function decide(input: ActionRequest, rules: readonly GateRule[]): Decision {
  const req = effectiveRequest(input);
  const quiet = req.effect === 'read' || req.effect === 'notes';
  // Unprompted work is refused in code before any rule is looked at; a suggestion card is the way out.
  if (req.origin === 'unprompted' && !quiet) return { verdict: 'deny', reason: 'unprompted_read_only' };
  const deny = firstMatch(rules, 'deny', req);
  if (deny) return { verdict: 'deny', reason: 'rule_deny', ruleId: deny.id };
  const ask = firstMatch(rules, 'ask', req);
  // An owner's "always ask" rule gates even a tool that is open by default.
  // Nobody is there to ask when no one asked for the run: such a read is refused, not turned into a card.
  if (quiet && ask && req.origin === 'unprompted') return { verdict: 'deny', reason: 'ask_unprompted', ruleId: ask.id };
  if (quiet)
    return ask
      ? { verdict: 'ask', reason: 'rule_ask', ruleId: ask.id }
      : { verdict: 'allow', reason: req.effect === 'read' ? 'read' : 'notes' };
  if (MANDATORY.includes(req.effect)) return { verdict: 'ask', reason: 'mandatory' };
  if (req.tainted) return { verdict: 'ask', reason: 'tainted' };
  if (ask) return { verdict: 'ask', reason: 'rule_ask', ruleId: ask.id };
  const allow = firstMatch(rules, 'allow', req);
  if (allow) return { verdict: 'allow', reason: 'rule_allow', ruleId: allow.id };
  return { verdict: 'ask', reason: 'no_rule' };
}

const MAX_DEPTH = 24;

/** Stable text of an action: sorted keys. Anything that is not plain JSON (a Date, Map, Set, function, undefined in an array, a cycle) throws, so the gate fails closed. */
export function canonicalJson(value: unknown, depth = 0, seen: object[] = []): string {
  if (depth > MAX_DEPTH) throw new TypeError('too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not a finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`not plain data: ${typeof value}`);
  if (seen.includes(value)) throw new TypeError('cycle');
  const next = [...seen, value];
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1, next)).join(',')}]`;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('not a plain object');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1, next)}`).join(',')}}`;
}
