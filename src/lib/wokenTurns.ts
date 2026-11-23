// Turns no one typed (a monitor's event, a scheduled check-in, a background task settling, linked sessions reporting)
// that only said where things stand, folded into one row of the thread, on every harness.
import type { SideSessionDelivery } from '../../shared/orchestration';
import type { StatusNoteItem, TurnState } from '../../shared/model/store';
import { hasAsyncQuestions } from './asyncQuestions';
import { artifactCall } from './designToolCall';
import { formatDuration } from './format';
import { turnProposals } from './sessionToolCall';

/** What woke a turn: the watch it came from (`key`), as the folded row names it, and whether it reported a failure. */
export type TurnWake = { key: string; label: string; failed: boolean };
/** A turn of the thread as it shows: on its own, or among woken turns folded into one row. */
export type ThreadEntry = { kind: 'turn'; turn: TurnState } | { kind: 'woken'; turns: TurnState[]; wakes: TurnWake[] };
/** What main delivered a thread item as (src/lib/sideSessions.ts sideSessionForItem), or null for a person's input. */
export type DeliveryOf = (item: { id?: string; clientId?: string | null }) => SideSessionDelivery | null;

/** Fewer folded turns than this stay as they are: a row for one turn saves nothing. */
export const MIN_FOLDED_TURNS = 2;
/** A reply longer than this says more than where things stand: its turn shows. */
export const MAX_QUIET_CHARS = 400;

/**
 * What woke a turn, read from what heads it: a wake note (a monitor's event, a scheduled check-in), a background task's
 * card, or a wake-up main delivered when linked sessions reported. Null when a person's words (or a brief, another
 * session's message) started it, or when nothing says what did.
 */
export function turnWake(turn: TurnState, deliveryOf: DeliveryOf): TurnWake | null {
  let wake: TurnWake | null = null;
  for (const item of turn.items as (TurnState['items'][number] | StatusNoteItem)[]) {
    if (item.type === 'userMessage') {
      if (deliveryOf(item)?.kind !== 'wake') return null;
      wake ??= { key: 'sessions', label: 'Linked sessions', failed: false };
    } else if (item.type === 'statusNote') {
      if (item.kind === 'peer') return null;
      if (item.kind === 'wake' && item.wake)
        wake ??= {
          key: `${item.wake.by}:${item.wake.key}`,
          label: item.wake.by === 'monitor' ? `Monitor · ${item.wake.label}` : 'Scheduled check-ins',
          failed: item.wake.failed,
        };
      else if (item.kind === 'task' && item.task)
        wake ??= { key: 'tasks', label: 'Background tasks', failed: item.task.status === 'failed' };
    }
  }
  return wake;
}

/** The notes a woken turn may carry and still be quiet: what woke it (a wake note, a task's card). */
const QUIET_NOTES = new Set(['wake', 'task']);
/** quietTurn's answer per turn: a settled turn keeps its object, so a streamed delta reads none of them again. */
const quietness = new WeakMap<TurnState, boolean>();

/** Items that say more than where things stand: an edit, a plan, a review, an image, a compaction. */
const LOUD = new Set(['fileChange', 'plan', 'enteredReviewMode', 'exitedReviewMode', 'imageGeneration', 'imageView', 'contextCompaction']);

/**
 * A finished turn that only said where things stand: it ended well, changed no file, asked nothing, proposed no session,
 * published no page, and every reply is short with no code block.
 */
export function quietTurn(turn: TurnState): boolean {
  let quiet = quietness.get(turn);
  if (quiet === undefined) quietness.set(turn, (quiet = readQuiet(turn)));
  return quiet;
}

function readQuiet(turn: TurnState): boolean {
  if (turn.status !== 'completed' || turn.error) return false;
  if (turnProposals(turn.items).length) return false;
  return turn.items.every((item) => {
    // a question asked is a message too: it waits on the user, so it shows
    if (LOUD.has(item.type) || hasAsyncQuestions(item) || artifactCall(item)) return false;
    // any other note (a harness switch, a usage limit, an app refused) says something of its own
    if ((item as { type: string }).type === 'statusNote') return QUIET_NOTES.has((item as unknown as StatusNoteItem).kind);
    if (item.type !== 'agentMessage') return true;
    const text = (item.text ?? '').trim();
    return text.length <= MAX_QUIET_CHARS && !text.includes('```');
  });
}

/**
 * The thread's turns with each run of quiet woken turns folded into one entry. The latest word on the watch stays open:
 * the run's last turn, unless a woken turn that is not quiet (or the running one) follows it and says it instead. The
 * running turn never folds.
 */
export function foldWokenTurns(turns: TurnState[], o: { liveId: string | null; deliveryOf: DeliveryOf }): ThreadEntry[] {
  const wakes = turns.map((t) => turnWake(t, o.deliveryOf));
  const folds = (i: number) => i < turns.length && !!wakes[i] && turns[i].id !== o.liveId && quietTurn(turns[i]);
  const out: ThreadEntry[] = [];
  for (let i = 0; i < turns.length; ) {
    let j = i;
    while (folds(j)) j++;
    if (j === i) {
      out.push({ kind: 'turn', turn: turns[i++] });
      continue;
    }
    const end = j < turns.length && wakes[j] ? j : j - 1;
    if (end - i >= MIN_FOLDED_TURNS) out.push({ kind: 'woken', turns: turns.slice(i, end), wakes: wakes.slice(i, end) as TurnWake[] });
    for (let k = end - i >= MIN_FOLDED_TURNS ? end : i; k < j; k++) out.push({ kind: 'turn', turn: turns[k] });
    i = j;
  }
  return out;
}

/** The turn each turn id shows in: its own, or the first of the folded run holding it (the run's slot). */
export function entrySlots(entries: ThreadEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries)
    if (e.kind === 'turn') out.set(e.turn.id, e.turn.id);
    else for (const t of e.turns) out.set(t.id, e.turns[0].id);
  return out;
}

/** "Monitor · CI run", "Woke 5 times over 12m" and how many wakes reported a failure, for a folded run. */
export function wokenSummary(entry: Extract<ThreadEntry, { kind: 'woken' }>): { label: string; text: string; failed: number } {
  const keys = new Set(entry.wakes.map((w) => w.key));
  const label = keys.size === 1 ? entry.wakes[0].label : 'Background events';
  const first = entry.turns[0];
  const last = entry.turns[entry.turns.length - 1];
  const end = last.completedAt ?? last.startedAt;
  const span = first.startedAt != null && end != null ? formatDuration((end - first.startedAt) * 1000) : '';
  return {
    label,
    text: `Woke ${entry.turns.length} times${span ? ` over ${span}` : ''}`,
    failed: entry.wakes.filter((w) => w.failed).length,
  };
}
