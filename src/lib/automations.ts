// Scheduled tasks for the Scheduled page: the task fields, reading and saving them through main, and reading their rules.
import { RRule } from 'rrule';
import { native } from './native';
import { scheduleRules } from '../../shared/schedule.mjs';

export interface Automation {
  version: number;
  id: string;
  kind: 'cron' | 'heartbeat' | string;
  name: string;
  prompt: string;
  status: 'ACTIVE' | 'PAUSED' | string;
  rrule: string;
  model?: string;
  reasoning_effort?: string;
  execution_environment?: string;
  cwds?: string[];
  target_thread_id?: string;
  /** which harness runs it: 'codex' (the default), 'claude' or 'acp:<id>' (src/lib/scheduleTask.ts) */
  harness?: string;
  /** the remote machine a run starts on (its id in the machine list); none for this Mac. Its folder there is cwds[0] */
  host_id?: string;
  /** a machine task's project here, which lists its chats (a machine's folder matches no project root on this Mac) */
  project_id?: string;
  /** may a run control apps (default off) */

  computer_control?: boolean;
  /** a run that needs approval: 'wait' and notify (the default), or 'skip' the run */
  on_approval?: string;
  /** the times before this don't count as missed (a new schedule, or one resumed) */
  schedule_from?: number;
  /** the chat whose tool set the task up */
  created_by_chat?: string;
  /** listed only: a Claude Desktop task's own cron expression */
  cron?: string;
  /** a Claude Code task in Claude Desktop: registered, pending, unsupported-schedule, unavailable, missing */
  claude_desktop?: string;
  /** listed only: 'machine' when its machine fires it itself, even while this Mac is off (#2709 phase 2) */
  fired_by?: 'machine';
  /** listed only: where the task lives, and the apps that run it */
  home?: 'codex' | 'mopilot' | 'claude-desktop';
  native_app?: 'codex-app' | 'claude-desktop' | null;
  runs_in?: { apps: ('mopilot' | 'codex-app' | 'claude-desktop')[]; desktop?: string; transfer?: string };
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

/** One scheduled time of a task in the run ledger (electron/platform/runLedger.cjs). */
export interface AutomationRun {
  taskId: string;
  scheduledFor: number;
  claimedAt?: number;
  /** starting | started | skipped | failed */
  status?: string;
  /** why a time was skipped (missed, previous-running) or a run failed */
  reason?: string;
  chatId?: string;
  catchUp?: boolean;
  /** attended Run now or tool invocation, distinct from an RRULE occurrence */
  manual?: boolean;
  /** 'codex-app' for a run the Codex app made itself; MoPilot's runs name no app */
  by?: unknown;
}

/** Whether the scheduler is on, and each native app that runs tasks too (main's automation:apps). */
export interface AutomationApps {
  scheduler: boolean;
  codexApp: { installed: boolean; running: boolean };
  claudeDesktop: { installed: boolean; running: boolean };
}

/** Every task, wherever its harness keeps it (main reads them: electron/platform/automationStore.cjs). */
export async function listAutomations(onError: (message: string) => void): Promise<Automation[]> {
  const { tasks, errors } = await native.automation.list();
  for (const e of errors) onError(e);
  return tasks;
}

/** Save a task where its harness keeps it; a task with no id gets one. Resolves to the task as listed. */
export function saveAutomation(a: Automation): Promise<Automation> {
  return native.automation.save(a);
}

/** Only the fields changed in the editor, including an explicit undefined to clear an optional field. */
export function editedFields(initial: Automation, edited: Automation): Partial<Automation> {
  return Object.fromEntries(Object.entries(edited).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial[k])));
}

/** Existing edits are merged in main's task queue; a missing task rejects and leaves the editor's draft intact. */
export async function saveEditedAutomation(initial: Automation, edited: Automation): Promise<Automation> {
  if (!initial.id) return saveAutomation(edited);
  return native.automation.update(initial.id, editedFields(initial, edited));
}

export function deleteAutomation(id: string): Promise<void> {
  return native.automation.remove(id);
}

const rules = scheduleRules(RRule);

/** The rule as a sentence, with or without the RRULE prefix; a rule that doesn't parse reads as itself. */
export function describeRule(rule: string) {
  return rules.describe(rule);
}

/** The rule's next time after `after`, on the user's clock (the scheduler in main reads it the same way). */
export function nextRun(rule: string, after = new Date()) {
  return rules.nextRun(rule, after);
}

/** What a task's status line says: one state, so the pill and the Pause/Resume button can't disagree (#1862). */
export type TaskState =
  | { kind: 'paused' }
  | { kind: 'scheduled'; next: Date }
  /** active, but its rule has no time left (an exhausted COUNT or UNTIL) */
  | { kind: 'ended' }
  /** active, with no rule this page can read (a cron-only Claude Desktop task, a rule that doesn't parse) */
  | { kind: 'unscheduled' };

function ruleParses(rule: string) {
  try {
    return RRule.parseString(rule.startsWith('RRULE:') ? rule.slice(6) : rule).freq !== undefined;
  } catch {
    return false;
  }
}

/** The task's state at `now`: paused unless ACTIVE, and otherwise by whether its rule has a next time. */
export function taskState(a: Pick<Automation, 'status' | 'rrule'>, now = new Date()): TaskState {
  if (a.status !== 'ACTIVE') return { kind: 'paused' };
  const next = a.rrule ? nextRun(a.rrule, now) : null;
  if (next) return { kind: 'scheduled', next };
  return a.rrule && ruleParses(a.rrule) ? { kind: 'ended' } : { kind: 'unscheduled' };
}

/** The short label for a state with no next time; a scheduled task shows its time instead. */
export const TASK_STATE_LABEL = { paused: 'Paused', ended: 'Ended', unscheduled: 'No next run' } as const;

export const PRESETS: { label: string; rule: string }[] = [
  { label: 'Every hour', rule: 'FREQ=HOURLY;INTERVAL=1' },
  { label: 'Every day at 9:00', rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
  { label: 'Weekdays at 9:00', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0' },
  { label: 'Every Monday at 9:00', rule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
  { label: 'Every 30 minutes', rule: 'FREQ=MINUTELY;INTERVAL=30' },
];
