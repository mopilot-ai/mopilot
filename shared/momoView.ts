// MoMo's view contract: what the Mac and phone clients draw (home, chat rows, approval card, tasks, notes, rules, settings), independent of any harness.
//
// Conventions that hold for every field below:
// - A time (`at`, `since`, `startedAt`, `expiresAt`, ...) is epoch milliseconds (UTC); a clock time or day string is in the HOME machine's local time zone: `brief.day` is `YYYY-MM-DD`, `MomoSettingsView` times are 24-hour `HH:MM` ("08:00"; quiet hours off is "00:00" to "00:00").
// - A machine is always named by its stable `machineId` plus the display `name` at the time (a name changes when the user renames the machine).
// - A union that a newer Host may extend is `Open<...>`: a client must handle a value it does not know, and the helpers here do (an unknown value degrades to the safe, visible choice; it never enables an action).

import type { MomoMachineRef, Open } from './momoViewBase.ts';
import type { MomoChatRow } from './momoViewRows.ts';
import type { MomoNoteView, MomoRuleSignalView, MomoRuleView, MomoSettingsView, MomoTaskView } from './momoViewLists.ts';
export * from './momoViewBase.ts';
export * from './momoViewRows.ts';
export * from './momoViewLists.ts';

/** Where MoMo lives and what it is doing: the home record's five states (design section 3.1). */
export const MOMO_HOME_STATES = ['running', 'moving', 'asleep', 'needs-update', 'needs-sign-in'] as const;
export type MomoHomeState = Open<(typeof MOMO_HOME_STATES)[number]>;

/**
 * The steps of a move, in order (design 3.1: pause, seal, copy, switch, resume, wipe). The move can be cancelled until `switching`
 * starts: the design's table says "Cancel before the switch" and W1.1 says "You can cancel until the switch", and the epoch changes
 * at the switch, so from there the move can only finish (design section 1, "Tap Cancel before the switch").
 */
export const MOMO_MOVE_STEPS = ['paused', 'sealed', 'copied', 'switching', 'resuming', 'cleaning-up'] as const;
export type MomoMoveStep = Open<(typeof MOMO_MOVE_STEPS)[number]>;

/** A move in flight or one that ended; `failedAt` is the last step reached before it failed. */
export interface MomoMoveView {
  moveId: string;
  from: MomoMachineRef;
  to: MomoMachineRef;
  step: MomoMoveStep;
  outcome: Open<'running' | 'moved' | 'failed' | 'cancelled'>;
  /** when the move ended; null while it runs */
  finishedAt: number | null;
  /** the real cause when the move did not finish, shown as is */
  failure: { cause: string; failedAt: MomoMoveStep } | null;
  /** the move finished (`outcome` moved) while the old machine was offline: it still holds a copy until it is back */
  oldMachineOffline: boolean;
  /** the owner can take the home back (reclaim) and this is the confirmation sheet's copy; null when it cannot (nothing to reclaim yet) */
  reclaim?: { title: string; body: string; confirm: string } | null;
}

/** One machine in the Where-MoMo-runs list (the same list as Remote Run's). */
export interface MomoMachineView {
  machineId: string;
  name: string;
  /** this Mac */
  isThisDevice: boolean;
  isHome: boolean;
  status: Open<'online' | 'offline' | 'needs-update' | 'not-set-up'>;
  /** the plain cost of picking it ("Stops when the lid closes"); null when none */
  note: string | null;
  recommended: boolean;
  /** the agents that are signed in there, by display name */
  agentsSignedIn: string[];
}

/** A one-click fix: `id` is what the client sends back, `label` is the button. */
export interface MomoFix {
  id: string;
  label: string;
}

/** The agent MoMo thinks with is not usable on the home; `fix` is the one-click action for it. */
export interface MomoAgentProblem {
  kind: Open<'signed-out' | 'not-installed'>;
  agent: string;
  fix: MomoFix;
}

/** A problem delivering the brief or notifications; `cause` is the exact sentence to show. */
export interface MomoDeliveryProblem {
  /** `push:<pairId>` or `day:<code>` */
  id: string;
  code: Open<'notifications_off' | 'token_invalid' | 'relay_unreachable' | 'push_disabled' | 'brief_failed' | 'brief_missed_asleep'>;
  cause: string;
  fix: MomoFix;
  also?: MomoFix[]; // other ways on, each its own button (an older MoMo: keep this one, delete the old one)
  since: number | null; // null for the brief's problems; a time for the push ones
}

export interface MomoHomeView {
  state: MomoHomeState;
  /** the home record's holder and fencing token; null before the first-run choice */
  homeMachineId: string | null;
  leaseEpoch: number | null;
  /** the display name of the home machine; null before the first-run choice */
  machineName: string | null;
  /** when this home's record was started (ms since epoch; null with no home): it changes when the home is made anew (Reset, Start fresh, a reinstall), which is when an older lease no longer binds it */
  createdAt?: number | null;
  /** when `state` last changed */
  stateSince: number | null;
  lastSeenAt: number | null;
  /** set on a machine that is no longer home: "MoMo moved to Studio at 3:02 PM" with Open Studio */
  movedAway: { machine: MomoMachineRef; at: number } | null;
  move: MomoMoveView | null;
  /** what the home runs and what it needs, while `state` is needs-update */
  update: { have: string; need: string } | null;
  agentProblem: MomoAgentProblem | null;
  /** set while the home does not take the account's access (MoMo is paused); older Hosts send none */
  access?: import('./momoAccessView.ts').MomoAccessProblem | null;
  machines: MomoMachineView[];
  /** Gmail and Calendar, read only: what the home can read right now */
  sources: MomoSourceView[];
}

/** A connected Google source (Settings, Sources). `needs-reconnect` shows "<Source> needs you to sign in again"; `cause` (`revoked`, `testing_expired`, `scope_missing`, `client_rejected`, `wrong_account`) says why, absent from a home that does not. */
export interface MomoSourceView {
  id: Open<'gmail' | 'calendar'>;
  account: string;
  access: Open<'blocked' | 'read-only' | 'read-and-ask'>;
  status: Open<'ok' | 'needs-reconnect' | 'catching-up'>;
  cause?: string | null;
  progress: { done: number; total: number } | null; // the first look at the last 30 days, while it runs
}

/** First-run setup: three steps, in this order. */
export const MOMO_SETUP_STEPS = ['where', 'read', 'reach'] as const;
export type MomoSetupStep = (typeof MOMO_SETUP_STEPS)[number];

export interface MomoSetupView {
  step: MomoSetupStep | 'done';
  /** step 2: the sign-in is open in the browser, or ended in a way the user can fix */
  google: 'idle' | 'waiting' | 'connected' | 'failed';
  /** step 3 */
  notifications: 'unknown' | 'allowed' | 'denied';
}

/** The whole store state both clients render. */
export interface MomoView {
  home: MomoHomeView;
  setup: MomoSetupView;
  chat: MomoChatRow[];
  tasks: MomoTaskView[];
  notes: MomoNoteView[];
  rules: MomoRuleView[];
  signals: MomoRuleSignalView[];
  settings: MomoSettingsView;
  problems: MomoDeliveryProblem[]; // delivery problems, each with its one-click fix
  keptOlder?: string[]; // the older MoMos the owner chose to keep (`olderKey`): a client that composes the home itself does not ask about them again; absent from an older Mac
}

/** Whether the pill is green (running), blue (moving) or amber (asleep, needs a fix, or a state this client does not know). */
export function momoHomeTone(state: MomoHomeState): 'ok' | 'warn' | 'busy' {
  if (state === 'running') return 'ok';
  return state === 'moving' ? 'busy' : 'warn';
}

/** A move can be cancelled until the switch (the epoch changes there); an unknown step cannot be, so Cancel is never offered by mistake. */
export function momoMoveCancellable(step: MomoMoveStep): boolean {
  const at = (MOMO_MOVE_STEPS as readonly string[]).indexOf(step);
  return at >= 0 && at < MOMO_MOVE_STEPS.indexOf('switching');
}
