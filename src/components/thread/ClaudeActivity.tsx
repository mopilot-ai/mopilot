// The running line of a chat, in every harness: the working mark, what the step is doing, the clock (Claude Desktop's
// running step group row).

import { type ReactNode, useState } from 'react';
import { Collapse } from '../ui/Presence';
import { ChevronRight } from '../ui/icons';
import { formatDuration } from '../../lib/format';
import { TurnTokens } from './turnTokens';
import { WorkingMark } from './workingMark/WorkingMark';
import { ShimmerSpan } from '../ui/ShimmerBand';
import type { MarkActivity } from './workingMark/markStages';

/** The status line's clock and token count join once the turn has run this long, as the Code tab's status line. */
export const CLOCK_AFTER_MS = 2000;
/** A running group's row shows its clock from five seconds, as Claude Desktop's running row does. */
export const ROW_CLOCK_AFTER_MS = 5000;

/** Claude Desktop's words on a running group's row while the model thinks before the group's first step (later, the last step's). */
export const THINKING_WORD = 'Thinking…';

/** The status line's thinking word, which grows with how long this stretch of thinking has run so a long one never looks stuck (the Code tab's). */
export function thinkingWord(ms: number): string {
  if (ms >= 60_000) return 'Almost done thinking…';
  if (ms >= 45_000) return 'Thinking some more…';
  if (ms >= 30_000) return 'Thinking more…';
  if (ms >= 15_000) return 'Still thinking…';
  return THINKING_WORD;
}

/**
 * The running line of a chat: the working mark for the kind of work, the step's words (shimmering) and how long the turn
 * has run. As a running group's `row` (Claude Desktop's): "Thinking…" in the words' place while the model thinks before
 * the group's first step (the caller holds the last step's words after it), the clock from five seconds, and a chevron
 * when there is something to open, with what follows the row (a live link) beside it. As the status line: the clock and
 * tokens from two seconds, then a thinking word that grows with the thinking.
 */
export function ClaudeActivity({
  label,
  activity,
  thinking = false,
  elapsedMs,
  open,
  onToggle,
  trailing,
  row = false,
  children,
}: {
  label?: ReactNode;
  activity: MarkActivity;
  /** the model is thinking: the line says so when the step has no words */
  thinking?: boolean;
  elapsedMs: number | null;
  /** more of the status line after the clock (the running-tasks count), or what follows a row */
  trailing?: ReactNode;
  /** a running group's row in the transcript rather than the status line */
  row?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const expandable = !!onToggle && children != null;
  const ms = Number.isFinite(elapsedMs) ? (elapsedMs as number) : 0;
  const clocked = ms >= (row ? ROW_CLOCK_AFTER_MS : CLOCK_AFTER_MS);
  const hasLabel = label != null && label !== '';
  const thinkingNow = thinking && !hasLabel;
  // the turn's clock when this stretch of thinking began: a tool call in between starts the word over
  const [thinkFrom, setThinkFrom] = useState<number | null>(null);
  // only a real clock starts it: a chat reopened mid-turn has none for a moment, and zero would count the whole turn
  if (thinkingNow && thinkFrom === null && Number.isFinite(elapsedMs)) setThinkFrom(ms);
  if (!thinkingNow && thinkFrom !== null) setThinkFrom(null);
  const word = thinkingWord(ms - (thinkFrom ?? ms));
  const mark = (
    <span className="claude-activity-mark">
      <WorkingMark activity={activity} />
    </span>
  );
  const time = clocked && <span className="claude-activity-time">{formatDuration(ms)}</span>;
  const chevron = expandable && <ChevronRight size={14} className="claude-activity-chevron" />;
  // a row says "Thinking…" in its words' place and keeps to the clock; the status line adds tokens and a growing word
  const line = row ? (
    <>
      {mark}
      {(hasLabel || thinkingNow) && (
        <ShimmerSpan className={`claude-activity-label${thinkingNow ? ' claude-activity-thinking' : ''}`}>
          {hasLabel ? label : THINKING_WORD}
        </ShimmerSpan>
      )}
      {time}
      {chevron}
    </>
  ) : (
    <>
      {mark}
      {hasLabel && <ShimmerSpan className="claude-activity-label">{label}</ShimmerSpan>}
      {time}
      {clocked && <TurnTokens />}
      {trailing}
      {thinkingNow && <ShimmerSpan className="claude-activity-thinking">{clocked ? `· ${word}` : word}</ShimmerSpan>}
      {chevron}
    </>
  );
  if (!expandable)
    return (
      <div className="claude-activity" role="status">
        {line}
        {row && trailing}
      </div>
    );
  return (
    <div className={`step claude-step ${open ? 'open' : ''}`}>
      {/* what follows a row (a live link is a button of its own) sits beside its toggle, not inside it */}
      <div className="claude-step-head">
        <button className="claude-activity expandable" aria-expanded={!!open} onClick={onToggle}>
          {line}
        </button>
        {row && trailing}
      </div>
      <Collapse open={!!open}>
        <div className="step-body">{children}</div>
      </Collapse>
    </div>
  );
}
