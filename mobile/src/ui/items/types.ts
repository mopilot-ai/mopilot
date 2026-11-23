// The typed items every new phone transcript component draws (plan R1): plain data, no runtime, no Orca and no wire types, so a component can be tested from props alone.

/** Where a chat's item came from; the same stream folds to the same items on every path (X4). */
export type ItemId = string;

/** How a step of a run went. */
export type ToolState = 'running' | 'done' | 'failed';
/** The closed set of things a step can be; anything else is `other`. */
export type ToolKind = 'read' | 'search' | 'edit' | 'run' | 'web' | 'other';

/** A message of the person or of the agent. `live` is a reply still arriving or a message the Mac has not recorded yet. */
export type MessageItem = {
  kind: 'message';
  id: ItemId;
  from: 'user' | 'assistant';
  text: string;
  live: boolean;
  /** Your message on its way: `pending` until the Mac takes it, `failed` when it did not go. Never set on the agent's. */
  send?: 'pending' | 'failed';
  clientId?: string;
  /** Pictures from the computer (count and the id it finds them by) and pictures held on this phone (uris). */
  images?: { count: number; messageId?: string };
  pictures?: string[];
  /** Text MoPilot itself wrote (a session's message, a wake-up): its one-line card instead of a bubble. */
  authored?: { title: string; body: string; kind: string; name?: string; completed?: boolean };
};

/** One step of the agent: a command, a file read, an edit, a tool call. */
export type ToolCallItem = {
  kind: 'tool-call';
  id: ItemId;
  text: string;
  tool: ToolKind;
  state: ToolState;
  durationMs: number | null;
  detail?: string;
  thumbnail?: string;
  surface?: string;
  callId?: string;
};

/** Two or more consecutive steps folded into one line ("Read 3 files · 2 s"). */
export type ToolRunItem = {
  kind: 'tool-run';
  id: ItemId;
  summary: string;
  running: boolean;
  steps: ToolCallItem[];
};

/** What a card asks, whichever computer or path delivered it. */
export type CardOption = { id: string; label: string; tone: 'allow' | 'deny' | 'other' };
/**
 * How a card stands. `waiting` carries when it began and the Host's reminder and pause times (absent for a chat relayed by a Mac that does not send
 * them: the words then use the Host defaults of `shared/host/cardLine.mjs`). `unreachable` and `restarted` name the machine. `closed` carries the
 * line that says why or by whom ("Allowed on iPhone", "Not answered", "Already answered on Work MacBook Pro."), made with `shared/host/cardLine.mjs`.
 */
export type CardView =
  | { state: 'waiting'; since?: number; remindMs?: number; pauseMs?: number }
  | { state: 'sending'; optionId: string }
  | { state: 'unreachable'; optionId: string; machineName: string; line: string }
  | { state: 'restarted'; machineName: string; line: string }
  | { state: 'closed'; line: string };

/** One thing a question asks: its words, the answers on offer, whether several may be chosen and whether the person may write their own answer (`other`). */
export type QuestionPrompt = {
  id: string;
  header?: string;
  text: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  other: boolean;
};

type CardBase = {
  id: ItemId;
  /** `mac`: a card the Mac sent with the chat; `host`: a card of a Host the phone reaches directly. */
  origin: 'mac' | 'host';
  title: string;
  detail?: string;
  /** Only the Mac finishes it: the phone shows `waitingCopy` and offers nothing. */
  macOnly: boolean;
  waitingCopy?: string;
  view: CardView;
};
/** A permission request: Allow, Deny and the rest. */
export type ApprovalItem = CardBase & { kind: 'approval'; options: CardOption[]; destination?: string };
/** A question to answer; its form is the existing card's. */
export type QuestionItem = CardBase & { kind: 'question'; prompts: QuestionPrompt[]; questions: number };
/** A plan waiting for approval. */
export type PlanItem = CardBase & { kind: 'plan'; options: CardOption[]; text: string; clipped: boolean };

/** The words of the working line, as catalog keys (`chat.status.<key>`): thinking grows with the time, a step names its activity. */
export type StatusWord =
  | 'thinking'
  | 'thinkingMore'
  | 'thinkingSomeMore'
  | 'stillThinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'searchingWeb'
  | 'working'
  | 'writing'
  | 'waiting'
  | 'error'
  | 'interrupted';

/** What the turn is doing now; `wordKey` names the line in the catalog and `words` is its English fallback. */
export type StatusItem = {
  kind: 'status';
  id: ItemId;
  state: 'thinking' | 'working' | 'writing' | 'waiting' | 'error' | 'interrupted';
  wordKey: StatusWord;
  words: string;
};

/** "Load earlier messages". */
export type EarlierItem = { kind: 'earlier'; id: ItemId; loading: boolean };

/** A reminder MoMo raised in its chat: its open loop, the words that made it and why it came up. Done, Snooze and Dismiss are the card's. */
export type NudgeItem = { kind: 'nudge'; id: ItemId; loopId: string; title: string; quote: string | null; why: string | null };

/** The dotted line where MoMo's chat changes day ("Today", "Yesterday", "Fri, Nov 13"). */
export type DayItem = { kind: 'day'; id: ItemId; label: string };

/** A row the mapper does not know: drawn as plain text, never dropped and never thrown on. */
export type UnknownItem = { kind: 'unknown'; id: ItemId; text: string };

export type Item =
  | MessageItem
  | ToolCallItem
  | ToolRunItem
  | ApprovalItem
  | QuestionItem
  | PlanItem
  | StatusItem
  | EarlierItem
  | NudgeItem
  | DayItem
  | UnknownItem;
export type ItemKind = Item['kind'];
/** Every kind in the union, for tests and exhaustive switches. */
export const ITEM_KINDS: readonly ItemKind[] = [
  'message',
  'tool-call',
  'tool-run',
  'approval',
  'question',
  'plan',
  'status',
  'earlier',
  'nudge',
  'day',
  'unknown',
];
