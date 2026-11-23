// What the window knows of Claude Code turns and models: turn ids, merging a read page with live turns, and what can
// be edited. The Rust core does the translating (core/crates/translate), and main hands the window finished items.
import type { TurnState } from '../../shared/model/store';
import type { HarnessModel } from '../../shared/model/harness';

export { LIVE_WINDOW_MS } from '../../shared/claudeItems/liveWindow.mjs';
export type { ClaudeToolInput } from '../../shared/model/requests';

/** The uuid Sage stamped on the prompt that started a turn (ct-<uuid> live, h-<uuid> from the transcript). */
export function promptUuidOf(turnId: string): string | null {
  return /^(?:ct|h)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(turnId)?.[1] ?? null;
}

/** What a Claude turn id names: its prompt's uuid under any of its ids (h-, ct- or pending-), else the id itself. */
export const claudeTurnKey = (id: string) => promptUuidOf(id) ?? /^pending-(.+)$/.exec(id)?.[1] ?? id;

/**
 * A chat's transcript turns with the ones already streaming here. A prompt is one turn under both
 * ids (h-<uuid> read back, ct-<uuid> or pending-<uuid> live): the live copy, which keeps streaming, wins.
 */
export function mergeClaudeTurns(transcript: TurnState[], current: TurnState[]): TurnState[] {
  const live = new Map(current.map((t) => [claudeTurnKey(t.id), t]));
  const turns = transcript.map((t) => {
    const l = live.get(claudeTurnKey(t.id));
    return l && l.id !== t.id ? l : t;
  });
  const have = new Set(turns.map((t) => claudeTurnKey(t.id)));
  return [...turns, ...current.filter((t) => !have.has(claudeTurnKey(t.id)))];
}

/** Why a Claude message can't be edited (rewound), or null when it can. */
export function editBlocked(turnId: string, checkpoints: Record<string, string | null> | undefined): string | null {
  if (!checkpoints) return null;
  const uuid = promptUuidOf(turnId);
  if (!uuid || !(uuid in checkpoints)) return 'Created before checkpoints · Fork from here instead';
  if (!checkpoints[uuid]) return 'This is the first message · Start a new chat instead';
  return null;
}

// these two decide a turn's settings, so main runs them (shared/claudeSettings.mjs)
export { claudePermissionFor, liveControls } from '../../shared/claudeSettings.mjs';

// main answers the side panel's cards with it too (shared/claudeAnswer.mjs)
export { claudeAnswer } from '../../shared/claudeAnswer.mjs';
export type { ApprovalResult, ClaudeAnswer } from '../../shared/model/native';

/** The picker's id for a wire model id: the alias that resolves to it, a pinned version, or its family alias. */
export function claudeModelFor(wire: string, models: HarnessModel[]): string {
  const exact = models.find((m) => m.resolved === wire && !m.more) ?? models.find((m) => m.id === wire || m.resolved === wire);
  if (exact) return exact.id;
  const family = /(opus|sonnet|haiku|fable)/.exec(wire)?.[1];
  return family && models.some((m) => m.id === family) ? family : wire;
}
