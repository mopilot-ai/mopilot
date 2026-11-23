// The goal's pill above the composer and the card it opens. Controls follow what the harness can do; the ones Sage holds
// itself (Claude's pause and round limit) say so.
import { useEffect, useRef, useState } from 'react';
import { CirclePause, CirclePlay, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { pauseGoal, resumeGoal, clearGoal, extendGoal, editGoal } from '../../store/actions';
import { toast, toastFailure } from '../../store/core';
import { isEnter, busyField } from '../../lib/focus';
import { focusAfterPlacement } from '../../lib/placedFocus';
import { canResumeGoal, goalBudgetLabel, goalStatusLabel } from '../../lib/codexGoals';
import {
  CLAUDE_GOAL_EXTRA_ROUNDS,
  canExtendClaudeGoal,
  canResumeClaudeGoal,
  claudeGoalDetail,
  claudeGoalStatusText,
  claudeGoalTurns,
} from '../../lib/claudeGoals';
import { useSessions } from '../../store/session/useSession';
import { goalBarDetail } from '../../lib/goalBarDetail';
import type { ChatGoal } from '../../store/types';
import { errorText } from '../../lib/ignored';
import { formatDuration } from '../../lib/format';
import type { GoalClock } from '../../lib/goalClock';
import { useGoalElapsed } from '../../lib/useGoalElapsed';
import { Popover } from '../ui/Popover';

const PAUSED_AT_QUIT = 'Paused when MoPilot quit';

/** The status label, detail line and which buttons to draw, from the goal alone. */
export function goalBarView(goal: ChatGoal) {
  const claude = !!goal.claude;
  return {
    status: claude ? claudeGoalStatusText(goal) : goal.pausedAtQuit ? PAUSED_AT_QUIT : goalStatusLabel(goal.status),
    detail: goalBarDetail(goal, { codex: goalBudgetLabel, claude: claudeGoalDetail }),
    canPause: goal.status === 'active',
    // at Sage's round limit the bar offers "10 more rounds" instead of a plain Resume
    canExtend: claude && canExtendClaudeGoal(goal),
    canResume: claude ? canResumeClaudeGoal(goal) && !canExtendClaudeGoal(goal) : canResumeGoal(goal),
    canEditObjective: !claude && goal.status !== 'complete',
  };
}

/** A Claude goal's end is only visible in the bar (the CLI keeps no goal once met), so it stays until cleared. */
export const goalShown = (goal: ChatGoal | null | undefined): goal is ChatGoal => !!goal && !(goal.status === 'complete' && !goal.claude);

/** Keep seconds visible even after an hour, so a long-running goal still visibly ticks. */
function goalDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const duration = formatDuration(whole * 1000);
  return whole < 3600 ? duration : `${duration} ${whole % 60}s`;
}

/**
 * The pill's short progress, never the words "Goal" or "Active" (a shown goal is the chat's goal): a running Codex goal's
 * time, a running Claude goal's turns, else where it stopped. `tone` mutes the icon of a goal that is not running.
 */
export function goalPillView(
  goal: ChatGoal,
  timeUsedSeconds = goal.timeUsedSeconds || 0,
): { text: string; tone: 'running' | 'muted' | 'limit'; label: string } {
  if (goal.status === 'active') {
    if (goal.claude) {
      const turns = claudeGoalTurns(goal);
      return { text: turns, tone: 'running', label: `Goal, ${turns}` };
    }
    const elapsed = goalDuration(timeUsedSeconds);
    return { text: elapsed, tone: 'running', label: `Goal, running for ${elapsed}` };
  }
  if (canExtendClaudeGoal(goal)) return { text: 'Round limit reached', tone: 'limit', label: 'Goal, Round limit reached' };
  const text = goal.status === 'paused' ? 'Paused' : goalBarView(goal).status;
  return { text, tone: 'muted', label: `Goal, ${text}` };
}

/** The card's muted line: a Claude goal's rounds or who holds it; a Codex goal's stop and time used. */
export function goalCardSummary(goal: ChatGoal, timeUsedSeconds = goal.timeUsedSeconds): string | null {
  if (goal.claude) return claudeGoalDetail(goal);
  const status = goal.status === 'active' ? null : goalBarView(goal).status;
  const elapsed = timeUsedSeconds > 0 ? `${goalDuration(timeUsedSeconds)} elapsed` : null;
  return [status, elapsed].filter(Boolean).join(' · ') || null;
}

function GoalIcon() {
  return (
    <svg
      className="goal-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.8 10.2a9 9 0 1 1-7-7M16.6 11a5 5 0 1 1-3.6-3.6M12 12l8-8m-5 0h5v5" />
    </svg>
  );
}

/** The goal's pill: its progress, the objective on hover, and a click opens the goal card above it. */
export function GoalPill({
  threadId,
  goal,
  clock,
  open,
  onOpenChange,
}: {
  threadId: string;
  goal: ChatGoal;
  clock: GoalClock | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const timeUsedSeconds = useGoalElapsed(threadId, goal, clock);
  const pill = goalPillView(goal, timeUsedSeconds);
  return (
    <>
      <button
        ref={setAnchor}
        className="goal-pill"
        data-tone={pill.tone}
        title={open ? undefined : goal.objective}
        aria-label={pill.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <GoalIcon />
        <span className="goal-pill-text">{pill.text}</span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          onOpenChange(false);
          // the card is in its own layer: Escape or an outside press gives the keyboard back to the pill
          anchor?.focus();
        }}
        placement="top-start"
        offset={8}
      >
        <GoalCard key={`${threadId}:${goal.createdAt}`} threadId={threadId} goal={goal} timeUsedSeconds={timeUsedSeconds} />
      </Popover>
    </>
  );
}

function GoalCard({ threadId, goal, timeUsedSeconds }: { threadId: string; goal: ChatGoal; timeUsedSeconds: number }) {
  const [objective, setObjective] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const v = goalBarView(goal);
  const summary = goalCardSummary(goal, timeUsedSeconds);
  const budget = goalBudgetLabel(goal);
  // the card renders at the end of the page, so the keyboard moves into it when it opens
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => focusAfterPlacement(ref.current!), []);
  return (
    <div ref={ref} className="goal-card" role="dialog" aria-label="Goal" tabIndex={-1}>
      <div className="goal-card-head">
        <span className="goal-card-title">Goal</span>
        <div className="goal-actions">
          {v.canPause && (
            <button
              className="icon-btn goal-control"
              aria-label="Pause"
              title="Pause goal"
              onClick={() => pauseGoal(threadId).catch(toastFailure("Couldn't pause the goal"))}
            >
              <CirclePause size={14} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
          {v.canResume && (
            <button
              className="icon-btn goal-control"
              aria-label="Resume"
              title="Resume goal"
              onClick={() => resumeGoal(threadId).catch(toastFailure("Couldn't resume the goal"))}
            >
              <CirclePlay size={14} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
          {v.canExtend && (
            <button
              className="icon-btn goal-control"
              aria-label={`${CLAUDE_GOAL_EXTRA_ROUNDS} more rounds`}
              title={`${CLAUDE_GOAL_EXTRA_ROUNDS} more rounds`}
              onClick={() => extendGoal(threadId).catch(toastFailure("Couldn't add rounds to the goal"))}
            >
              <Plus size={14} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
          <button
            className="icon-btn goal-control"
            aria-label="Clear"
            title="Clear goal"
            disabled={saving}
            onClick={() => clearGoal(threadId).catch(toastFailure("Couldn't clear the goal"))}
          >
            <Trash2 size={14} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </div>
      {objective !== null ? (
        <form
          className="goal-objective-edit"
          // keys typed here are the editor's, not the composer's or the chat's (Escape closes the card itself)
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving || !objective.trim()) return;
            setSaving(true);
            try {
              if (await editGoal(threadId, objective.trim())) setObjective(null);
            } catch (e) {
              toast(`Couldn't edit goal: ${errorText(e)}`, 'error');
            } finally {
              setSaving(false);
            }
          }}
        >
          <textarea
            className="text-input"
            aria-label="Goal objective"
            autoFocus
            rows={2}
            value={objective}
            {...busyField(saving)}
            onChange={(e) => setObjective(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e) && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="goal-objective-actions">
            <button className="link-btn" type="submit" disabled={saving || !objective.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="link-btn" type="button" disabled={saving} onClick={() => setObjective(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="goal-card-objective">
          <span className="goal-objective" title={goal.objective}>
            {goal.objective}
          </span>
          {v.canEditObjective && (
            <button
              className="icon-btn goal-control goal-edit"
              aria-label="Edit goal"
              title="Edit goal"
              onClick={() => setObjective(goal.objective)}
            >
              <Pencil size={13} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {summary && <div className="goal-card-summary">{summary}</div>}
      {goal.claude?.lastReason && <div className="goal-card-summary">Last check: {goal.claude.lastReason}</div>}
      {budget && <div className="goal-budget">{budget}</div>}
    </div>
  );
}

/** A chat row's marker in the sidebar: the chat has a goal that is not finished (only for chats this window already follows). */
export function GoalMark({ threadId }: { threadId: string }) {
  const goal = useSessions((s) => s.sessions[threadId]?.goal);
  if (!goal || goal.status === 'complete') return null;
  return (
    <span className="row-goal" title={`Goal · ${goalBarView(goal).status}: ${goal.objective}`}>
      <Target size={12} strokeWidth={1.8} />
    </span>
  );
}
