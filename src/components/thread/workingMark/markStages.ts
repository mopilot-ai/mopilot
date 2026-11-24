// The working mark's stage machine, as Claude Code's Code tab runs it: each activity enters, loops and leaves,
// and a new activity takes over only where the playing loop allows it.
import { MARK_SHEETS, type MarkSheet } from './markSheets';
import type { MarkActivity } from '../../../session/activityWords';

export type { MarkActivity };

/** One stage of the mark. `tail` plays the last frames of a loop to wind it down early. */
export type MarkStage = { kind: 'grow' } | { kind: 'in' | 'loop' | 'out' | 'tail'; body: MarkActivity };

/** How many loop frames a tail plays. */
export const TAIL_FRAMES = 20;
/** A seam must be at least this far ahead of the playhead to be taken. */
export const SEAM_LEAD_MS = 50;
/** A loop with no more than this left plays out instead of being cut short. */
export const TAIL_THRESHOLD_MS = 1500;
/** The new stage fades in over the frame it cut away from. */
export const CROSSFADE_MS = 300;

/** The sheet a stage plays. */
export function sheetKey(stage: MarkStage): string {
  return stage.kind === 'grow' ? 'grow' : `${stage.body}.${stage.kind === 'tail' ? 'loop' : stage.kind}`;
}

export function sheetOf(stage: MarkStage): MarkSheet {
  return MARK_SHEETS[sheetKey(stage)];
}

/** The frames a stage plays, as [first, end): a tail is the loop's last frames, any other stage its whole sheet. */
export function stageRange(stage: MarkStage): [number, number] {
  const { frames } = sheetOf(stage);
  return stage.kind === 'tail' ? [Math.max(0, frames - TAIL_FRAMES), frames] : [0, frames];
}

/** How long a stage plays, in ms. */
export function stageDuration(stage: MarkStage): number {
  const [from, to] = stageRange(stage);
  return (to - from) * sheetOf(stage).speed;
}

/** What follows a stage once it has played, given the activity wanted now. */
export function nextStage(stage: MarkStage, wanted: MarkActivity): MarkStage {
  switch (stage.kind) {
    case 'grow':
      return { kind: 'in', body: wanted };
    case 'tail':
      return stage.body === wanted ? { kind: 'loop', body: stage.body } : { kind: 'out', body: stage.body };
    case 'in':
      return { kind: 'loop', body: stage.body };
    case 'loop':
      return stage.body === wanted ? stage : { kind: 'out', body: stage.body };
    case 'out':
      return { kind: 'in', body: wanted };
  }
}

/** The frame the mark holds when motion is reduced: the loop's rest frame, or a third of the way in. */
export function restFrame(body: MarkActivity): number {
  const sheet = MARK_SHEETS[`${body}.loop`];
  return sheet.rest ?? Math.floor(sheet.frames / 3);
}

/**
 * When a playing loop may hand over to a newly wanted activity, as ms into the loop, or null to let it play out.
 * Between two animated activities the loop leaves at its next seam (after `SEAM_LEAD_MS`). A switch to or from
 * default or blocked (or from default) winds the loop down at once with a tail when more than `TAIL_THRESHOLD_MS` of
 * it is left. Claude's own code also names a two-second minimum here, but it never applies (a shadowed variable).
 */
export function earlyExit(stage: MarkStage, wanted: MarkActivity, playedMs: number): { atMs: number; to: MarkStage } | null {
  if (stage.kind !== 'loop' || stage.body === wanted) return null;
  const sheet = sheetOf(stage);
  const plain = wanted === 'blocked' || stage.body === 'blocked' || stage.body === 'default';
  if (!plain) {
    const seam = sheet.seams?.map((f) => f * sheet.speed).find((ms) => ms > playedMs + SEAM_LEAD_MS);
    return seam === undefined ? null : { atMs: seam, to: { kind: 'out', body: stage.body } };
  }
  if (sheet.frames * sheet.speed - playedMs <= TAIL_THRESHOLD_MS) return null;
  return { atMs: playedMs, to: { kind: 'tail', body: stage.body } };
}
