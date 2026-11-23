// MoMo's memory as the Memory tab gets it (#2139, electron/momo/memory.cjs, electron/momo/memoryIpc.cjs).

/** One fact MoMo keeps about the user: typed by the user, or saved in a MoMo chat (on that harness). */
export interface MomoFact {
  id: string;
  text: string;
  source: 'user' | { chatId: string; harness: string };
  createdAt: number;
  confidence: 'sure' | 'likely';
  expiresAt?: number;
  /** 'extracted': MoMo wrote it on its own after a chat (the memory pass), not asked to */
  origin?: 'extracted';
  /** when a newer fact replaced it (a past fact), and which */
  invalidAt?: number;
  supersededBy?: string;
}

/** One change to the facts: each fact as it was and as it became (null: absent), and whether Undo can take it back. */
export interface MomoMemoryChange {
  id: string;
  at: number;
  /** the user, a MoMo chat, or MoMo's background pass */
  by: 'user' | 'pass' | { chatId: string; harness: string };
  op: 'save' | 'update' | 'forget' | 'pass' | 'undo';
  items: { before: MomoFact | null; after: MomoFact | null }[];
  undone?: number;
  reason?: string;
  undoable: boolean;
}

/** A cap on MoMo's background tokens in a day (the local day) and what was spent under it today. */
export interface MomoBackgroundShare {
  cap: number;
  /** null: can't be read now */
  today: number | null;
}

/** MoMo's background work's one daily token cap and each kind's share of it (the memory pass, the search aliases). */
export interface MomoMemoryLimits {
  daily: MomoBackgroundShare;
  memory: MomoBackgroundShare;
  /** search aliases of past chats and saved facts */
  aliases: MomoBackgroundShare;
  /** the most one memory pass's prompt may take */
  maxTokensPerPass: number;
}

/** About you and MoMo's persona, by the name the store takes. */
export type MomoMemoryFile = 'aboutYou' | 'persona';

/** Every answer: what was asked for, or why not (`reason`: MoMo is not allowed, or this Mac can't encrypt its memory). */
export type MomoMemoryResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: 'not_allowed' | 'unavailable' };

/** One open loop MoMo kept from what the user said in its chat (#2139 P4, electron/momo/openLoops.cjs). */
export interface MomoLoop {
  id: string;
  kind: 'promise' | 'date' | 'todo';
  text: string;
  /** the user's own words */
  quote: string;
  source: { chatId: string; harness: string; turnId: string };
  saidAt: number;
  tz: string;
  confidence: 'sure' | 'likely';
  dueAt?: number;
  dueDay?: string;
  event?: string;
  lastMentionedAt: number;
  state: 'open' | 'done' | 'dismissed';
  closedAt?: number;
  snoozedUntil?: number;
  nudged: { at: number; trigger: string; key: string }[];
  askedClose?: number;
}

/** What can be done to a loop: snooze for a day or a week. */
export type MomoLoopAct = { action: 'done' | 'dismiss' | 'reopen' } | { action: 'snooze'; snooze: 'day' | 'week' };
