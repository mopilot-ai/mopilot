// Repeated checks of one command or tool with waits between them, folded into one row of a turn's work.
import { shownToolName } from '../../../lib/ownToolLines';
import { formatDuration } from '../../../lib/format';
import { commandAfterWait, itemSteps, stepsWaited, type DisplayItem, type WorkBlock } from './stepModel';

/** One check of a poll: its step group, and the status message the agent wrote after it (none after the last). */
export type PollCheck = { items: DisplayItem[]; message: DisplayItem | null };
/** What a poll checks each time: one command (after its leading sleep) or one tool call with the same arguments. */
export type PollTarget = { key: string; kind: 'command' | 'tool'; text: string };
export type PollBlock = { kind: 'poll'; checks: PollCheck[]; target: PollTarget };
/** A turn's work as it shows: work blocks, with each poll folded into one. */
export type ShownBlock = WorkBlock | PollBlock;

/** Fewer checks than this stay as they are: folding two would save one row and hide a message. */
export const MIN_POLL_CHECKS = 3;
/** A message longer than this says more than "still waiting": it ends the poll, and shows. */
export const MAX_STATUS_CHARS = 400;

/**
 * What a step group checks, when it is one check of a poll: it waited (a wait step or a leading sleep) and did exactly
 * one other thing, a command or a tool call (thoughts aside). Null for any other group.
 */
export function pollTarget(items: DisplayItem[]): PollTarget | null {
  const steps = items.flatMap(itemSteps).filter((s) => s.kind !== 'reasoning');
  const acts = steps.filter((s) => s.kind !== 'wait');
  if (acts.length !== 1 || !stepsWaited(steps)) return null;
  const act = acts[0];
  if (act.kind === 'command') {
    const text = commandAfterWait(act);
    return { key: `command:${text}`, kind: 'command', text };
  }
  if (act.kind === 'tool') {
    const it = act.item as { server?: unknown; tool?: unknown; arguments?: unknown };
    return {
      key: `tool:${String(it.server)}/${String(it.tool)}:${JSON.stringify(it.arguments ?? null)}`,
      kind: 'tool',
      text: shownToolName(it),
    };
  }
  return null;
}

/** A short message between two checks: the agent saying where things stand. */
function statusMessage(b: WorkBlock | undefined): DisplayItem | null {
  if (b?.kind !== 'block' || b.item.type !== 'agentMessage') return null;
  const text = (b.item.text ?? '').trim();
  return text && text.length <= MAX_STATUS_CHARS && !text.includes('```') ? b.item : null;
}

/**
 * The blocks with each poll folded: MIN_POLL_CHECKS or more step groups checking the same target, each but the last
 * followed by a short status message. The message after the last check stays out, as the latest word on the poll.
 * `liveLast`: the last block is the turn's running group, which stays out so its live line keeps its place.
 */
export function foldPolls(blocks: WorkBlock[], liveLast = false): ShownBlock[] {
  const targetAt = (i: number) => {
    const b = blocks[i];
    return b?.kind === 'steps' && !(liveLast && i === blocks.length - 1) ? pollTarget(b.items) : null;
  };
  const out: ShownBlock[] = [];
  for (let i = 0; i < blocks.length; ) {
    const target = targetAt(i);
    let end = i;
    while (target && statusMessage(blocks[end + 1]) && targetAt(end + 2)?.key === target.key) end += 2;
    if (!target || (end - i) / 2 + 1 < MIN_POLL_CHECKS) {
      out.push(blocks[i++]);
      continue;
    }
    const checks: PollCheck[] = [];
    for (let j = i; j <= end; j += 2)
      checks.push({
        items: (blocks[j] as Extract<WorkBlock, { kind: 'steps' }>).items,
        message: j < end ? (blocks[j + 1] as Extract<WorkBlock, { kind: 'block' }>).item : null,
      });
    out.push({ kind: 'poll', checks, target });
    i = end + 1;
  }
  return out;
}

/** A check whose command exited badly or whose tool call failed: the folded row still counts it. */
const checkFailed = (c: PollCheck) =>
  c.items.some((i) => {
    const it = i as { status?: string | null; exitCode?: number | null };
    return it.status === 'failed' || it.status === 'declined' || (it.exitCode != null && it.exitCode !== 0);
  });

/**
 * "Ran the same command 4 times, waited 3m 20s", what it ran ("gh api …") and how many checks failed, in the words a
 * step group's summary uses, so a folded row still shows a failure.
 */
export function pollSummary(block: PollBlock): { text: string; target: string; failed: number } {
  const n = block.checks.length;
  const waited = stepsWaited(block.checks.flatMap((c) => c.items.flatMap(itemSteps)))?.ms;
  const did = block.target.kind === 'command' ? `Ran the same command ${n} times` : `Called the same tool ${n} times`;
  return {
    text: `${did}, ${waited ? `waited ${formatDuration(waited)}` : 'waited'}`,
    target: block.target.text,
    failed: block.checks.filter(checkFailed).length,
  };
}

/** Whether a poll shows the same: the turn folds again on every delta, but a settled check holds the same items. */
export const samePoll = (a: PollBlock, b: PollBlock) =>
  a.target.key === b.target.key &&
  a.checks.length === b.checks.length &&
  a.checks.every(
    (c, i) =>
      c.message === b.checks[i].message &&
      c.items.length === b.checks[i].items.length &&
      c.items.every((it, j) => it === b.checks[i].items[j]),
  );
