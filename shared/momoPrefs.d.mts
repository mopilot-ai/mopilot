export type MomoProactivity = 'off' | 'low' | 'default' | 'high';
export type MomoAtLimit = 'nextAccount' | 'pause' | 'skip';
export type MomoStyle = 'concise' | 'warm' | 'detailed';
export type MomoColor = 'clay' | 'blue' | 'green' | 'violet' | 'ink';
export type MomoStarterRoutine = 'morningFeed' | 'weekAhead' | 'bills';

/** A role's brain: 'codex', 'claude' or 'acp:<id>', with its account and model (none on a basic harness). */
export interface MomoRoleBrain {
  harness: string;
  account: string | null;
  model: string | null;
  modelLabel: string | null;
  /** the effort MoMo replies at, when the brain names one (none: the model's default) */
  effort?: string | null;
}

export interface MomoPrefs {
  /** what MoMo does when its brain's account is at its limit (one rule for every kind of work) */
  atLimit: MomoAtLimit;
  routines: {
    proactivity: MomoProactivity;
    /** 'HH:MM' to 'HH:MM' (past midnight when end is earlier); null: none */
    quietHours: { start: string; end: string } | null;
    /** the starter routines picked in setup */
    starter: MomoStarterRoutine[];
  };
  notify: { needsAnswer: boolean; pushBody: boolean };
  /** a paired phone may change MoMo's brain */
  remote: { brainChange: boolean };
  paused: boolean;
  /** the four-tab Tasks panel (M0a) is on: `momo.tasksPanel` */
  tasksPanel: boolean;
  brief: boolean;
  suggestions: boolean;
  /** channels and groups (A2) are on: `momo.channels` */
  channels: boolean;
  /** MoMo's page shell (M0b) is on: `momo.shell` */
  shell: boolean;
  /** the shell's Sessions pane is on: `momo.sessions` */
  sessions: boolean;
  /** the pane lists the other chats */
  sessionsShow: boolean;
  /** MoMo may read the other chats and answer their cards */
  sessionsAct: boolean;
  /** the name MoMo is shown by (its style is in its persona, in memory) */
  persona: { name: string; color: MomoColor };
  /** step: the setup step to open on (0) */
  onboarding: { done: boolean; step: number };
}

/** What each settable key holds. */
export interface MomoPrefValues {
  atLimit: MomoAtLimit;
  'routines.proactivity': MomoProactivity;
  'routines.quietHours': MomoPrefs['routines']['quietHours'];
  'routines.starter': MomoStarterRoutine[];
  'notify.needsAnswer': boolean;
  'notify.pushBody': boolean;
  'remote.brainChange': boolean;
  paused: boolean;
  tasksPanel: boolean;
  brief: boolean;
  suggestions: boolean;
  channels: boolean;
  shell: boolean;
  sessions: boolean;
  sessionsShow: boolean;
  sessionsAct: boolean;
  'persona.name': string;
  'persona.color': MomoColor;
  onboarding: MomoPrefs['onboarding'];
}
export type MomoPrefKey = keyof MomoPrefValues;

export const MOMO_PROACTIVITY: readonly MomoProactivity[];
export const MOMO_PROACTIVITY_LIMITS: Readonly<Record<MomoProactivity, Readonly<{ runs: number }>>>;
export const MOMO_AT_LIMIT: readonly MomoAtLimit[];
export const MOMO_STYLES: readonly MomoStyle[];
export const MOMO_STARTER_ROUTINES: readonly MomoStarterRoutine[];
export const MOMO_SETUP_STARTERS: readonly MomoStarterRoutine[];
export const MOMO_COLORS: readonly MomoColor[];
export const MOMO_SETUP_STEPS: number;
export const MOMO_DEFAULTS: Readonly<MomoPrefs>;
export function readMomoPrefs(momo: unknown): MomoPrefs;
export function setMomoPref(
  momo: unknown,
  key: unknown,
  value: unknown,
): { ok: true; momo: Record<string, unknown> } | { ok: false; error: string };
export function effectiveAtLimit(saved: MomoAtLimit, noOtherAccount: boolean): MomoAtLimit;
export function roleBrain(momo: unknown): MomoRoleBrain | null;
export function migrateMomoPrefs(momo: unknown): Record<string, unknown> | null;
export function isMomoPaused(momo: unknown): boolean;
export function resetMomoPrefs(): Record<string, unknown>;
