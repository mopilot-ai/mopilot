// How a Codex turn's items read in the thread (WP5-5, WP5-7). Pure functions, so the rules can be
// tested without the app: a plan that arrives only as a message, an inline review's result, whether
// a compaction was the user's, background terminals and the threads sub-agents run in.

import { isReReport, type ReviewFinding } from '../../shared/reviewFindings.mjs';
import { internalReply } from '../../shared/modelFraming.mjs';
import { withOptions } from '../../shared/momoOptions.mjs';

/**
 * A turn's item as these rules read it: a ThreadItem, or one Sage's translators built (a status
 * note, a Claude plan). Only the fields read here are named.
 */
export type ItemLike = {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  review?: unknown;
  trigger?: unknown;
  questions?: unknown[] | null;
  tool?: unknown;
  kind?: unknown;
  receiverThreadIds?: unknown;
  agentThreadId?: unknown;
  status?: unknown;
} & Record<string, unknown>;

/** A plan as the plan card reads it; Claude's also names its file and whether it was approved in the turn. */
export type PlanCardItem = {
  id: string;
  type: 'plan';
  text: string;
  planFilePath?: string | null;
  approvedInTurn?: boolean;
  fromMessage?: boolean;
};
/** An inline review's result as the review card reads it. */
export type ReviewCardItem = {
  id: string;
  type: 'exitedReviewMode';
  review: string;
  target?: { type?: string } | null;
  /** Claude Code's typed findings (ReportFindings) and the level the review ran at; Codex's are parsed from `review` */
  findings?: ReviewFinding[];
  level?: string | null;
};

/** The card a turn ends with instead of a plain reply: its plan, or an inline review's result. */
export type TurnCard = { kind: 'plan'; item: PlanCardItem } | { kind: 'review'; item: ReviewCardItem };

const text = (it: ItemLike | null | undefined) => String(it?.text ?? '').trim();

/**
 * Items as the thread shows them.
 * - Review: the result comes as exitedReviewMode and then again as an agentMessage with the same
 *   text (conformance X4); the message is dropped.
 * - Compaction: the app-server doesn't say who started it (X5). One Sage recorded as the user's
 *   carries trigger 'manual'; a turn holding nothing but the compaction is the user's too, since an
 *   automatic one happens inside a normal turn.
 * - MoMo's chats (`momo`): Claude Code's own records ("No response requested.") are no reply of MoMo's and are dropped;
 *   a reply's last `Options: A | B | C` line leaves its text and comes as `options` (the answer chips).
 */
export function presentItems<T extends ItemLike>(items: T[], momo = false): T[] {
  const reviews = new Set(items.filter((i) => i?.type === 'exitedReviewMode').map((i) => String(i.review ?? '').trim()));
  const onlyCompaction = items.length > 0 && items.every((i) => i?.type === 'contextCompaction');
  return items
    .filter((i) => !(i?.type === 'agentMessage' && reviews.size && reviews.has(text(i))))
    .filter((i) => !(momo && i?.type === 'agentMessage' && internalReply(i.text)))
    .map((i) => (momo && i?.type === 'agentMessage' ? (withOptions(i) as T) : i))
    .map((i) => (i?.type === 'contextCompaction' && onlyCompaction && !i.trigger ? { ...i, trigger: 'manual' } : i));
}

/**
 * The card a finished turn ends with. A plan-mode turn shows its plan item; models that write the
 * plan as a plain message instead (the luna models, X3) get their last message as the plan.
 * `planMode`: the turn was sent in plan mode.
 */
export function turnCard(items: (ItemLike | null | undefined)[], planMode: boolean, running: boolean): TurnCard | null {
  // a review's outcomes reported in its own turn (/code-review --fix) leave the review's findings as the card
  let outcomes: TurnCard | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === 'exitedReviewMode' && String(it.review ?? '').trim()) {
      const findings = Array.isArray(it.findings) ? (it.findings as ReviewFinding[]) : null;
      if (!findings || !isReReport(findings)) return { kind: 'review', item: it as ReviewCardItem };
      outcomes ??= { kind: 'review', item: it as ReviewCardItem };
    } else if (it?.type === 'plan' && text(it)) return outcomes ?? { kind: 'plan', item: it as PlanCardItem };
  }
  if (outcomes) return outcomes;
  if (!planMode || running) return null;
  const last = [...items].reverse().find((i) => i?.type === 'agentMessage' && !i.questions?.length && text(i));
  return last ? { kind: 'plan', item: { ...last, type: 'plan', fromMessage: true } as PlanCardItem } : null;
}

/**
 * The card a turn ends with, of the one turnCard found in `items`. A plan approved mid-turn (Claude's ExitPlanMode)
 * is carried out in the same turn: once anything follows it, it isn't the turn's end but stays where it was
 * approved, and the turn ends with its reply. One nothing follows (rejected, or just approved) still ends the turn.
 */
export function endCard(card: TurnCard | null, items: (ItemLike | null | undefined)[]): TurnCard | null {
  if (card?.kind !== 'plan' || !card.item.approvedInTurn) return card;
  const at = items.findIndex((i) => i?.id === card.item.id);
  return at >= 0 && at < items.length - 1 ? null : card;
}

/** What the divider says for a compaction. */
export const compactionLabel = (item: ItemLike | null | undefined) =>
  item?.trigger === 'manual' ? 'Context compacted' : 'Context automatically compacted';

/** A command a chat left running in the background (thread/backgroundTerminals/list, X10). */
export interface BackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  /** the OS pid; the app-server may not know it (null), so stopping goes by processId */
  osPid: number | null;
}
/** A row of thread/backgroundTerminals/list, as far as it is read. */
type TerminalRow = { itemId?: unknown; processId?: unknown; command?: unknown; cwd?: unknown; osPid?: unknown };

export function backgroundTerminals(r: { data?: unknown } | null | undefined): BackgroundTerminal[] {
  return (Array.isArray(r?.data) ? r.data : [])
    .filter((t: TerminalRow | null) => t && t.processId != null)
    .map((t: TerminalRow) => ({
      itemId: String(t.itemId ?? ''),
      processId: String(t.processId),
      command: String(t.command ?? ''),
      cwd: String(t.cwd ?? ''),
      osPid: typeof t.osPid === 'number' ? t.osPid : null,
    }));
}

const commandsOfTurn = new WeakMap<object, string>();

/**
 * The command items of the chat's running turn, joined by newlines (a stable store selection); '' when none runs.
 * Read by a selector on every store commit, so a turn that has not changed is not scanned again.
 */
export function runningTurnCommands(rt: { turns: { id: string; items: unknown[] }[]; activeTurnId: string | null } | undefined): string {
  const turn = rt?.activeTurnId ? rt.turns.find((t) => t.id === rt.activeTurnId) : undefined;
  // a turn record without its items (older data) reads as running no command, as before the cache
  if (!turn || !Array.isArray(turn.items)) return '';
  const known = commandsOfTurn.get(turn.items);
  if (known !== undefined) return known;
  const commands = (turn.items as ItemLike[])
    .filter((i) => i?.type === 'commandExecution')
    .map((i) => String(i.id))
    .join('\n');
  commandsOfTurn.set(turn.items, commands);
  return commands;
}

/**
 * The terminals the chat left in the background. A command the running turn started (`own`, runningTurnCommands) is
 * still that turn's work: its row reads "Running", and Stop ends it with the turn (#1940).
 */
export function leftInBackground(terminals: BackgroundTerminal[], own: string): BackgroundTerminal[] {
  if (!own) return terminals;
  const ids = new Set(own.split('\n'));
  return terminals.filter((t) => !ids.has(t.itemId));
}

/** The threads a spawn started (a collab tool call's receivers, or a sub-agent activity's thread). */
export function spawnedThreads(it: ItemLike): string[] {
  if (!/spawn|started/i.test(String(it?.tool ?? it?.kind ?? ''))) return [];
  if (Array.isArray(it.receiverThreadIds) && it.receiverThreadIds.length) return it.receiverThreadIds.map(String);
  return it?.agentThreadId ? [String(it.agentThreadId)] : [];
}

export interface ChildThread {
  id: string;
  /** "Agent", "Agent 2", … by spawn order */
  title: string;
  status: string | null;
}

/** The child threads Codex's collab calls started, in spawn order and without repeats. */
export function childThreads(items: ItemLike[]): ChildThread[] {
  const seen = new Map<string, ChildThread>();
  for (const it of items) {
    for (const id of spawnedThreads(it)) {
      if (!seen.has(id)) seen.set(id, { id, title: '', status: (it.status as string | null | undefined) ?? null });
    }
  }
  const list = [...seen.values()];
  return list.map((c, i) => ({ ...c, title: list.length > 1 ? `Agent ${i + 1}` : 'Agent' }));
}

/** The message "Implement this plan" sends, in default mode. */
export { IMPLEMENT_PLAN } from '../../shared/planAction.mjs';
