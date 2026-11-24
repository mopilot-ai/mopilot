// MoMo's view contract, part 3 (re-exported from ./momoView.ts: import from there): tasks, notes, rules and settings.

import type { MomoMachineRef, Open } from './momoViewBase.ts';
import type { MomoDecisionView } from './momoViewRows.ts';
import type { MomoFix } from './momoView.ts';

export const MOMO_TASK_STATES = ['working', 'needs_you', 'watching', 'done', 'failed', 'stopped'] as const;
export type MomoTaskState = Open<(typeof MOMO_TASK_STATES)[number]>;

/** Why a task failed, with the one-click fix the client offers next to it. */
export interface MomoTaskFailure {
  code: Open<
    | 'machine-unreachable'
    | 'agent-missing'
    | 'agent-signed-out'
    | 'usage-limit'
    | 'session-error'
    | 'unanswered'
    | 'retry-cap'
    | 'not-done'
    | 'restarted'
  >;
  /** the real cause, shown as is */
  message: string;
  machine: MomoMachineRef | null;
  agent: string | null;
  /** the one-click fix the home offers for this cause; null: the client falls back to Retry */
  fix: MomoFix | null;
}

export interface MomoTaskView {
  id: string;
  title: string;
  doneMeans: string;
  state: MomoTaskState;
  origin: Open<'asked' | 'suggestion' | 'matter' | 'routine'>;
  where: { machine: MomoMachineRef; agent: string };
  startedAt: number;
  /** runs made so far, and the most there may be (one run plus up to two retries) */
  attempts: number;
  attemptCap: number;
  /** the live step while working; why it is watched while watching */
  step: string | null;
  nextCheck: number | null;
  failure: MomoTaskFailure | null;
  result: { summary: string; files: string[]; evidence: string } | null;
  /** a Watching row (W3.3): why it is watched, when it is checked next, and whether and when you were told; absent on other tasks */
  watch?: { why: string; nextCheck: number | null; told: boolean; toldAt: number | null; decision: MomoDecisionView | null } | null;
}

export const MOMO_NOTE_STATUSES = ['mentioned-once', 'learned', 'confirmed', 'let-go'] as const;
export type MomoNoteStatus = Open<(typeof MOMO_NOTE_STATUSES)[number]>;

export interface MomoNoteSource {
  id: string;
  kind: Open<'mail' | 'event' | 'chat'>;
  /** "Gmail · Re: Acme renewal" */
  label: string;
  at: number;
  /** the message is gone from Gmail: the quote is kept */
  gone: boolean;
}

export interface MomoNoteLine {
  id: string;
  text: string;
  at: number;
  status: MomoNoteStatus;
  /** the verbatim quote that backs the line */
  quote: string | null;
  sources: MomoNoteSource[];
}

export interface MomoNoteChange {
  id: string;
  at: number;
  /** a plain sentence */
  summary: string;
  undoable: boolean;
}

export interface MomoNoteView {
  id: string;
  title: string;
  kind: Open<'person' | 'company' | 'project' | 'topic' | 'about'>;
  updatedAt: number;
  /** the last night's change, shown as the banner with See change and Undo */
  lastChange: MomoNoteChange | null;
  lines: MomoNoteLine[];
  history: MomoNoteChange[];
}

export type MomoRuleEffect = Open<'tell_now' | 'stay_quiet' | 'ask_first' | 'dont_ask'>;

export interface MomoRuleView {
  id: string;
  text: string;
  /** "quieter" lowers what MoMo does on its own; "does-more" needs the user's tap */
  kind: Open<'quieter' | 'does-more'>;
  effect: MomoRuleEffect;
  origin: Open<'learned' | 'yours' | 'built-in'>;
  /** `saved`: the owner's own words are kept but the notice judge and the brain do not read rules yet, so it is not applied */
  state: Open<'suggested' | 'on' | 'off' | 'undone' | 'saved'>;
  appliesTo: string;
  /** the reactions that created it; empty for yours and built-in rules */
  evidence: { at: number; reaction: string; item: string }[];
  useCount: number;
  /** the brief also lists what this rule keeps quiet */
  inBrief: boolean;
  /** One line of help for the effect (MOMO_RULE_HELP in ./momoRuleHelp.ts), or null; absent from an older home. */
  help?: string | null;
}

/** An early signal one reaction short of a rule (Rules: "Make it a rule" or "Ignore"). */
export interface MomoRuleSignalView {
  id: string;
  text: string;
}

/** Times are 24-hour `HH:MM` in the home's time zone; quiet hours off is "00:00" to "00:00". */
export interface MomoSettingsView {
  brief: { on: boolean; time: string };
  quietHours: { from: string; to: string };
  /** tell-now items a day */
  dailyCap: number;
  /** show message text on the lock screen */
  previews: boolean;
}

/** The groups Tasks lists, in order; `other` holds a state this client does not know, so such a task is never hidden. */
export const MOMO_TASK_GROUPS: readonly { id: 'needs-you' | 'working' | 'watching' | 'done'; states: readonly string[] }[] = [
  { id: 'needs-you', states: ['needs_you'] },
  { id: 'working', states: ['working'] },
  { id: 'watching', states: ['watching'] },
  { id: 'done', states: ['done', 'failed', 'stopped'] },
];

/** Tasks in group order, empty groups left out; a task in a state no group knows goes last, in `other`. */
export function groupMomoTasks(tasks: readonly MomoTaskView[]) {
  const known = MOMO_TASK_GROUPS.flatMap((g) => g.states);
  const groups: { id: (typeof MOMO_TASK_GROUPS)[number]['id'] | 'other'; tasks: MomoTaskView[] }[] = [
    ...MOMO_TASK_GROUPS.map((g) => ({ id: g.id, tasks: tasks.filter((t) => g.states.includes(t.state)) })),
    { id: 'other', tasks: tasks.filter((t) => !known.includes(t.state)) },
  ];
  return groups.filter((g) => g.tasks.length > 0);
}
