// The running turn's line while the model thinks: the dots status line under the task list (statusSlot.tsx), which at the turn's start waits before it shows so a quick first token never flashes it, or Codex's shimmering row in place.
import { InlineCounts } from '../../tasks/SessionsCount';
import { ThinkingDots } from '../../ui/icons';
import type { ActivityUx } from '../../../session/activityUx';
import { ActivityTime } from '../ActivityTime';
import { ClaudeActivity } from '../ClaudeActivity';
import { Shimmer } from '../items/presentation';
import { InStatusSlot } from '../statusSlot';
import type { MarkActivity } from '../workingMark/markStages';

export function ThinkingLine({
  ux,
  elapsedMs,
  chatId,
  activity,
  reveal = true,
}: {
  ux: ActivityUx;
  elapsedMs: number | null;
  chatId: string;
  /** The activity of the current placeholder, independent of earlier work in the turn. */
  activity: MarkActivity;
  /** wait before showing: only before the turn's first step, since after one the slot already held a running group's line */
  reveal?: boolean;
}) {
  if (ux !== 'dots')
    return (
      <div className="step-row active item-enter">
        <ThinkingDots />
        <Shimmer>Thinking</Shimmer>
        <ActivityTime elapsedMs={elapsedMs} />
        <InlineCounts chatId={chatId} />
      </div>
    );
  return (
    <InStatusSlot>
      <div className={reveal ? 'placeholder-reveal' : undefined}>
        <ClaudeActivity
          activity={activity}
          thinking={activity === 'think'}
          elapsedMs={elapsedMs}
          trailing={<InlineCounts chatId={chatId} />}
        />
      </div>
    </InStatusSlot>
  );
}
