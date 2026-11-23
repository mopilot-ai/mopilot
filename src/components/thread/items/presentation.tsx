// Shared step labels, icons, shimmer and timing hooks.
import { useEffect, useState, type ReactNode } from 'react';
import { visiblePoll } from '../../../lib/visiblePoll';
import { formatDuration, prettyCommand } from '../../../lib/format';
import { basename } from '../../../lib/paths';
import { Globe, Bot, Pencil, BookOpen, SquareTerminal, Search, FolderTree, Plug, Brain, Clock, Activity } from '../../ui/icons';
import { prefixUnits } from '../../../../shared/textPrefix.mjs';
import { stepControl, type Step, type AgentItem } from './stepModel';
import { sageCallLine } from '../../../lib/windowToolCall';
import { ownToolLine } from '../../../lib/ownToolLines';
import { nameOf } from '../../../lib/scheduledTaskCall';
import { designCallLine } from '../../../lib/designToolCall';
import { runningSkillLabel } from '../../../session/skillToolCall';
import { ShimmerSpan } from '../../ui/ShimmerBand';
export function useNow(active: boolean, interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    // one shared clock per interval, stopped while the window is hidden
    return visiblePoll(`now:${interval}`, interval, () => setNow(Date.now()));
  }, [active, interval]);
  return now;
}

export function Shimmer({ children }: { children: ReactNode }) {
  return <ShimmerSpan shimmer="shimmer">{children}</ShimmerSpan>;
}

export function stepIcon(kind: Step['kind'], network = false, size = 16) {
  const p = { size, strokeWidth: 1.6 };
  switch (kind) {
    case 'edit':
      return <Pencil {...p} />;
    case 'read':
      return <BookOpen {...p} />;
    case 'search':
      return <Search {...p} />;
    case 'list':
      return <FolderTree {...p} />;
    case 'web':
      return <Globe {...p} />;
    case 'tool':
      return <Plug {...p} />;
    case 'agent':
      return <Bot {...p} />;
    case 'reasoning':
      return <Brain {...p} />;
    case 'wait':
      return <Clock {...p} />;
    case 'watch':
      return <Activity {...p} />;
    case 'command':
      return network ? <Globe {...p} /> : <SquareTerminal {...p} />;
    default:
      return <SquareTerminal {...p} />;
  }
}

/** One-line label for the step that is currently running. */
export function activeStepLabel(step: Step | undefined, showReasoning = true): ReactNode {
  if (!step) return 'Thinking';
  switch (step.kind) {
    case 'reasoning': {
      if (!showReasoning) return 'Thinking';
      const t = (step.item.summary ?? []).filter(Boolean).join('\n');
      return /^\*\*(.+?)\*\*/.exec(t)?.[1] ?? 'Thinking';
    }
    case 'command':
      return `Running ${firstLine(prettyCommand(step.item.command))}`;
    case 'read':
      return `Reading ${basename(step.path)}`;
    case 'search':
      return `Searching for ${step.query}`;
    case 'list':
      return 'Exploring files';
    case 'edit':
      return `Editing ${basename(step.change.path)}`;
    case 'web':
      return step.item.query ? `Searching the web for ${step.item.query}` : 'Searching the web';
    case 'tool':
      return (
        stepControl(step)?.doing ??
        sageCallLine(step.item)?.text ??
        designCallLine(step.item)?.text ??
        runningSkillLabel(step.item) ??
        ownToolLine(step.item)?.text ??
        `Calling ${nameOf(step.item)?.tool ?? 'a tool'}`
      );
    case 'agent':
      return 'Working with agents';
    case 'wait':
      return waitWords(step, undefined, 0);
    case 'watch':
      return step.what === 'monitor' ? 'Starting a monitor' : step.stop ? 'Stopping the check-ins' : 'Scheduling a check-in';
    default:
      return 'Working';
  }
}

/**
 * A wait's words on the running line: "Waiting 50s · 18s left" from when it started (`at`), "Waiting 50s" before its
 * time is known, "Waited 50s" once it ended. A wait that gave no duration reads "Waiting".
 */
export function waitWords(step: Extract<Step, { kind: 'wait' }>, at: { start: number; end?: number } | undefined, now: number): string {
  const length = formatDuration(step.ms);
  // what it waited for ("for a background task"), when the wait is on something rather than a clock
  const on = step.on ? ` for ${step.on}` : '';
  if (at?.end != null) return `Waited${length ? ` ${length}` : ''}${on}`;
  if (!length || on) return `Waiting${on}`;
  const left = at ? step.ms! - (now - at.start) : 0;
  return left >= 1000 ? `Waiting ${length} · ${formatDuration(left)} left` : `Waiting ${length}`;
}

export const firstLine = (s: string) => {
  const l = s.split('\n')[0];
  return l.length > 140 ? prefixUnits(l, 140) + '…' : l;
};

export const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function agentVerb(it: AgentItem) {
  const tool = String(it.tool ?? it.kind ?? '');
  if (/spawn|started/i.test(tool)) return it.status === 'inProgress' ? 'Spawning agent' : 'Spawned agent';
  if (/wait/i.test(tool)) return 'Waited for agents';
  if (/send|message|interact/i.test(tool)) return 'Messaged agent';
  if (/close|kill|interrupt/i.test(tool)) return 'Stopped agent';
  if (/complete/i.test(tool)) return 'Agent finished';
  return 'Agent activity';
}
