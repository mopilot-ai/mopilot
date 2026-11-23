// What a harness switch changes (WP7-11, A14, D-11): the lines of the SwitchSheet and the defaults of its
// choices. Pure, so the sheet, the switch and the tests agree.
import { COPY, fmt } from './copy';
import { isUserQueued } from '../lib/queued';
import type { QueuedMessage } from '../../shared/model/session';
import { effortLabel } from '../lib/format';
import type { HarnessId } from './types';

/** Effort levels from lightest to heaviest; 'ultra' (several agents) is a separate choice, not a level. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort the target model runs at: the same level when it has it, else the nearest one (the
 * lighter of two equally near), else its default.
 */
export function mapEffort(from: string | null, targetEfforts: string[], targetDefault: string | null): string | null {
  const levels = targetEfforts.filter((e) => e !== 'ultra');
  if (!levels.length) return null;
  if (!from || from === 'ultra') return targetDefault && levels.includes(targetDefault) ? targetDefault : levels[0];
  if (levels.includes(from)) return from;
  const rank = (e: string) => EFFORT_ORDER.indexOf(e);
  const r = rank(from);
  if (r < 0) return targetDefault && levels.includes(targetDefault) ? targetDefault : levels[0];
  return [...levels].sort((a, b) => Math.abs(rank(a) - r) - Math.abs(rank(b) - r) || rank(a) - rank(b))[0];
}

/** Permissions only stay or get stricter: "Approve for me" needs a model that can auto-approve. */
export function permissionChange(permission: string, targetAutoMode: boolean | undefined): { to: string; text: string | null } {
  if (permission === 'auto-review' && targetAutoMode === false) return { to: 'default', text: COPY.switchSheet.permissionsStricter };
  return { to: permission, text: null };
}

/** Multiple agents are on in the current segment: Codex's 'ultra' effort, or Claude Code's ultracode switch. */
export const multiAgentIsOn = (from: HarnessId, effort: string | null, ultracodeOn: boolean): boolean =>
  from === 'codex' ? effort === 'ultra' : ultracodeOn;

/** Carrying it over works where it is an effort level (Codex); Claude Code's ultracode is a live-session switch set from its / menu. */
export const canCarryMultiAgent = (to: HarnessId, targetEfforts: string[]): boolean => to === 'codex' && targetEfforts.includes('ultra');

/** "Continue this goal" starts ticked when the harness stays and only the provider changes. */
export const defaultContinueGoal = (from: HarnessId, to: HarnessId) => from === to;

export interface SheetInput {
  from: HarnessId;
  to: HarnessId;
  fromLabel: string;
  toLabel: string;
  vendor: string;
  /** the account the new segment runs on */
  account: string;
  goal: { objective: string; status: string } | null;
  effortFrom: string | null;
  targetEfforts: string[];
  targetDefaultEffort: string | null;
  permission: string;
  targetAutoMode: boolean | undefined;
  /** multi-agent is on in the current segment */
  multiAgentOn: boolean;
  /** messages waiting in the queue */
  queued: number;
}

export interface SheetPlan {
  /** goal: only when the chat has one; the rest are always there */
  goal: { pauses: string; continueLabel: string } | null;
  account: string;
  effort: { text: string; to: string | null };
  permission: { text: string; to: string };
  multiAgent: { on: boolean; label: string };
  queued: { n: number; text: string } | null;
}

export function sheetPlan(i: SheetInput): SheetPlan {
  let goal: SheetPlan['goal'] = null;
  if (i.goal && i.goal.status !== 'complete') {
    // the copy line is "Goal … pauses on X  ☐ Continue this goal on Y": text, then the checkbox's label
    const [pauses, cont] = fmt(COPY.switchSheet.goal, { condition: i.goal.objective, from: i.fromLabel, to: i.toLabel }).split(/\s*☐\s*/);
    goal = { pauses: pauses.trim(), continueLabel: cont.trim() };
  }
  const to = mapEffort(i.effortFrom, i.targetEfforts, i.targetDefaultEffort);
  // named as the picker names them ("Extra high"), so the sheet says which effort the target starts at
  const effort = {
    to,
    text: fmt(COPY.switchSheet.effort, { from: effortLabel(i.effortFrom) || 'Default', to: effortLabel(to) || 'Default' }),
  };
  const perm = permissionChange(i.permission, i.targetAutoMode);
  const multiAgent = { on: i.multiAgentOn, label: COPY.switchSheet.multiAgent.replace(/^☐\s*/, '') };
  const q = i.queued > 0 ? { n: i.queued, text: fmt(COPY.switchSheet.queued, { n: i.queued }).split(/\s*·\s*/)[0] } : null;
  return {
    goal,
    account: fmt(COPY.switchSheet.account, { account: i.account, vendor: i.vendor }),
    effort,
    permission: { to: perm.to, text: perm.text ?? 'Permissions: unchanged' },
    multiAgent,
    queued: q,
  };
}

// The divider when a chat comes back to a harness it used before is in shared/handoff.mjs, since main
// writes it into the new segment's note.
export { backDivider } from '../../shared/handoff.mjs';

/** The queued messages the user wrote: not what another session sent, nor an input no human wrote. Only these go back to the composer. */
export const userQueued = <T extends Partial<QueuedMessage>>(queue: T[]): T[] => queue.filter(isUserQueued);
