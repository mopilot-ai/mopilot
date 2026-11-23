// MoMo's view contract: what the Mac and phone clients draw (home, chat rows, approval card, tasks, notes, rules, settings), independent of any harness.
//
// Conventions that hold for every field below:
// - A time (`at`, `since`, `startedAt`, `expiresAt`, ...) is epoch milliseconds (UTC); a clock time or day string is in the HOME machine's local time zone: `brief.day` is `YYYY-MM-DD`, `MomoSettingsView` times are 24-hour `HH:MM` ("08:00"; quiet hours off is "00:00" to "00:00").
// - A machine is always named by its stable `machineId` plus the display `name` at the time (a name changes when the user renames the machine).
// - A union that a newer Host may extend is `Open<...>`: a client must handle a value it does not know, and the helpers here do (an unknown value degrades to the safe, visible choice; it never enables an action).

/** A union that stays open: the known values, plus any string a newer sender may use. */
export type Open<T extends string> = T | (string & {});

/** Whether `v` is one of the values a client knows; the narrowing every switch over an `Open` union starts with. */
export function isKnown<T extends string>(known: readonly T[], v: string): v is T {
  return (known as readonly string[]).includes(v);
}

/** One machine, as it is shown and as it is addressed. */
export interface MomoMachineRef {
  machineId: string;
  name: string;
}

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
  /** null for the brief's problems; a time for the push ones */
  since: number | null;
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
  machines: MomoMachineView[];
  /** Gmail and Calendar, read only: what the home can read right now */
  sources: MomoSourceView[];
}

/** A connected Google source (Settings, Sources). `needs-reconnect` shows "<Source> needs you to sign in again". */
export interface MomoSourceView {
  id: Open<'gmail' | 'calendar'>;
  account: string;
  access: Open<'blocked' | 'read-only' | 'read-and-ask'>;
  status: Open<'ok' | 'needs-reconnect' | 'catching-up'>;
  /** the first look at the last 30 days, while it runs */
  progress: { done: number; total: number } | null;
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

/**
 * How far a user message got (the device saves it before it sends and never resends after an uncertain delivery; design section 1):
 * `queued` is on this device, not sent (offline or the home asleep); `never-got-it` is the home saying it never saw the turn;
 * `not-sure` is no answer yet; the rest are the home's turn states.
 */
export type MomoDelivery = Open<'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'never-got-it' | 'not-sure'>;

/**
 * Why MoMo decided what it did about one mail or event (design W3.2 "Why you saw this", W3.3): the model's own short reason, the
 * kind it was filed under, the rule that matched, the checks that ran, and the matter it belongs to. Everything but the reason is
 * from the decision log, not from the model.
 */
export interface MomoDecisionView {
  id: string;
  /** this one decision (a row's id repeats when later mail reopens the thread): sent back with "Not needed" so an old tap cannot act on what came after it */
  decisionId?: string;
  outcome: Open<'tell_now' | 'watch' | 'quiet' | 'unsorted'>;
  /** the model's words, up to 20 */
  reason: string;
  /** "Client replies" */
  kind: string | null;
  /** "Client replies → tell me right away"; null when no rule matched */
  rule: { id: string; text: string } | null;
  /** what was checked, one plain sentence each: "Sender matches Acme · passes the sender check" */
  checks: string[];
  /** the thread of events this belongs to: "Acme renewal", and whether this is the first of it */
  matter: { key: string; title: string; first: boolean } | null;
  at: number;
}

/** One row in MoMo's chat. `id` is the turn or card id, stable across restarts. */
export type MomoChatRow =
  | {
      kind: 'assistant';
      id: string;
      at: number;
      text: string;
      source: string | null;
      whyTold: string | null;
      /** the row offers "Not needed"; `suggestion` is the rule a second "Not needed" proposed (Undo applies to it) */
      notNeeded: { suggestion: { ruleId: string; text: string } | null } | null;
      /** why MoMo told you now ("Told you now: Client replies" opens it); absent when the row is not a notice */
      decision?: MomoDecisionView | null;
    }
  | { kind: 'user'; id: string; at: number; text: string; delivery: MomoDelivery }
  | { kind: 'waiting'; id: string; at: number; machine: MomoMachineRef }
  | { kind: 'brief'; id: string; at: number; brief: MomoBriefView }
  | { kind: 'catch-up'; id: string; at: number; catchUp: MomoCatchUpView }
  | { kind: 'approval'; id: string; at: number; approval: MomoApprovalView }
  | { kind: 'question'; id: string; at: number; question: MomoQuestionView }
  | { kind: 'result'; id: string; at: number; result: MomoResultView }
  | { kind: 'watch-changed'; id: string; at: number; watch: MomoWatchChangedView }
  | MomoDraftRow;

/** A reply MoMo drafted from a mail, as a row: the words to review and the thread it belongs to; it never sends anything by itself. `to` comes from the mail's own From header in code, only `body` is the model's words; the body came from outside text, so a client draws it as plain text only. */
export interface MomoDraftRow {
  kind: 'draft';
  id: string;
  at: number;
  draft: { to: string[]; subject: string; body: string };
  matter: { key: string; title: string };
  untrusted: true;
  /** the body was cut to its size limit */
  truncated: boolean;
}

/**
 * A row a client reads through the Host's row store (`host.momoRows`) and is told of by `momo.row`: `{ ev: 'momo.row', row }` for one row written or changed,
 * the whole row, never a patch. A row is identified by `row.id`; a second row with an id a client has replaces it (a card that was answered, a result that was
 * superseded), and `host.momoRows { after }` answers every row written or changed after that time, oldest first.
 */
export interface MomoRowEvent {
  ev: 'momo.row';
  row: MomoChatRow;
}

/** What `host.momoRows` answers: rows oldest first by the time they were last written, and where to ask from next. */
export interface MomoRowsAnswer {
  rows: MomoChatRow[];
  /** pass back as `after` to read only what changed since */
  next: number;
  /** there are more rows after this page: ask again from `next` */
  more: boolean;
}

export interface MomoBriefView {
  /** the local day (home time zone) the brief is for, `YYYY-MM-DD` */
  day: string;
  greeting: string;
  /** the one thing that needs you, or null on a quiet day */
  attention: { text: string; source: string } | null;
  /** at most two offers */
  offers: { id: string; title: string; why: string }[];
  overnight: { read: number; notesUpdated: number; rulesLearned: number };
  /** quiet mail the brief left out, each with a one-line reason */
  leftOut: { id: string; reason: string }[];
}

export interface MomoCatchUpView {
  machine: MomoMachineRef;
  /** the span the home was asleep */
  from: number;
  to: number;
  read: number;
  needsYou: { id: string; text: string }[];
}

/**
 * The states of a card (design section 5, `card.status`): pending → approved → consumed → completed, or denied, expired,
 * answered-elsewhere, failed, uncertain (it ended without a result: never retried on its own).
 */
export const MOMO_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'answered-elsewhere',
  'consumed',
  'completed',
  'failed',
  'uncertain',
  // the home that raised it is no longer the home (a move, a reclaim): it can no longer be answered
  'void',
] as const;
export type MomoApprovalStatus = Open<(typeof MOMO_APPROVAL_STATUSES)[number]>;

/** A card for one action MoMo wants to take; the user answers once, on any device. */
export interface MomoApprovalView {
  id: string;
  /** `send-email` fills recipients, subject, attachments and body; any other action lists its `fields` */
  action: Open<'send-email' | 'other'>;
  /** the question: "Send this email?" */
  title: string;
  recipients: { name: string; address: string; outsideCompany: boolean }[];
  subject: string | null;
  attachments: string[];
  /** the exact text the action will send; for an `other` action, a one-line summary */
  body: string;
  /** labelled details of an `other` action (what, where, how much) */
  fields: { label: string; value: string }[];
  expiresAt: number | null;
  status: MomoApprovalStatus;
  /** another device answered first: which, when, and what it answered */
  answeredElsewhere: { device: string; at: number; outcome: Open<'approved' | 'denied'> } | null;
  /** why it failed, with the one-click fix; null unless `status` is failed */
  failure: { cause: string; fix: MomoFix | null } | null;
  /** an expired, denied or uncertain card the user can ask again (a new card is raised) */
  canAskAgain: boolean;
  /** the body (and the subject of a mail) can be changed before it is sent, as the intent `approval.edit` does: true only on a card that waits and that the home itself runs (a note), because for any other the chat runs the call and would never see the change; absent from a Host that does not say, which a client reads as false */
  editable?: boolean;
}

/** The states of a question card: one question with answers to choose from, answered once on any device. */
export const MOMO_QUESTION_STATUSES = ['pending', 'answered', 'answered-elsewhere', 'expired', 'void'] as const;
export type MomoQuestionStatus = Open<(typeof MOMO_QUESTION_STATUSES)[number]>;

/** MoMo asks you something with a few answers to tap (it never asks to act, that is an approval card). */
export interface MomoQuestionView {
  id: string;
  title: string;
  body: string;
  options: { id: string; label: string }[];
  expiresAt: number | null;
  status: MomoQuestionStatus;
  /** the option that was chosen, by which device and when; null while pending */
  answer: { optionId: string; device: string; at: number } | null;
}

/**
 * The one card a task leaves in the chat when it settles (one per task and settle count, the task's `id` plus `settle`). `text` fields come from a session and are
 * data to show, never instructions or an approval: `untrusted` is always true.
 */
export interface MomoResultView {
  taskId: string;
  /** how many times the task has settled: the card's own key with `taskId` */
  settle: number;
  title: string;
  state: Open<'done' | 'needs_you' | 'failed'>;
  summary: string;
  files: string[];
  evidence: string;
  /** what MoMo's read-only check said of the result */
  checked: string;
  machine: MomoMachineRef;
  /** the session on that machine, or null: it is a chat id of that machine and means nothing on another */
  sessionId: string | null;
  untrusted: true;
  /** the one-click actions the card offers, by the fix ids the home understands */
  actions: MomoFix[];
}

/** A watched source changed: what, where it is watched from and what is different. */
export interface MomoWatchChangedView {
  taskId: string;
  title: string;
  detail: string;
  machine: MomoMachineRef;
}

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
  /** delivery problems, each with its one-click fix */
  problems: MomoDeliveryProblem[];
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

/** The status of a card: one still pending after its expiry is an expired deny, whatever its stored status says. */
export function momoApprovalStatus(a: Pick<MomoApprovalView, 'status' | 'expiresAt'>, now: number): MomoApprovalStatus {
  return a.status === 'pending' && a.expiresAt !== null && a.expiresAt <= now ? 'expired' : a.status;
}

/** Whether Send, Edit and Don't send are offered: only on a card that is still pending (an unknown status offers nothing). */
export function momoApprovalAnswerable(a: Pick<MomoApprovalView, 'status' | 'expiresAt'>, now: number): boolean {
  return momoApprovalStatus(a, now) === 'pending';
}

/** Whether a message needs the user's attention before anything is sent again: the home never got it, or nobody knows. An unknown delivery counts as not sure. */
export function momoDeliveryNeedsCheck(d: MomoDelivery): boolean {
  return d === 'never-got-it' || d === 'not-sure' || !isKnown(['queued', 'accepted', 'completed', 'failed', 'cancelled', 'interrupted'], d);
}
