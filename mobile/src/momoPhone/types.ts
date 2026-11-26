// What the phone adds to the shared MoMo view (shared/momoView.ts): the clock, a wake in flight, the "moved away" notice, and the intents every screen sends to the home.
import type { MomoView } from '../../../shared/momoView';

export type { MomoView };

/** The shared view plus what only this phone knows. */
export type PhoneView = {
  now: number;
  view: MomoView;
  /** True while a wake is in flight. */
  waking: boolean;
  /** The home was composed by this phone itself (no Mac answered): the machine actions are the Mac's, so none is offered. */
  own?: boolean;
  /** Tasks the person put off, and when each comes back (until the home's next view says). */
  snoozed?: Record<string, number>;
  /** When a failed move was tried again, until the move is over. */
  retriedAt?: number;
  /** Cancel was pressed on a move that is still running. */
  cancelling?: boolean;
};

export type Agent = 'claude' | 'codex';

/** One setting at a time, as the home takes it; times are 24-hour HH:MM in the home's zone. */
export type PrefsPatch = {
  brief?: boolean;
  briefTime?: string;
  quietFrom?: string;
  quietTo?: string;
  dailyCap?: number;
  previews?: boolean;
  /** the user said yes in the iOS prompt */
  notifications?: 'allowed';
};

/** A message the phone holds until the home has it: saved before it is sent, sent once, never sent again after a doubt. */
export type LocalTurn = {
  id: string;
  text: string;
  at: number;
  delivery: 'queued' | 'accepted' | 'never-got-it' | 'not-sure';
  /** Check again was asked and the home could not say whether it has the turn: it stays in doubt, and only a `missing` status lets it go again. */
  check?: 'unavailable';
};

/** What a notification button or a screen asks the home for. `open-where`, `open-rules`, `open-settings` (the iOS Settings app) and `pick-machine` are local, never sent. */
export type Intent =
  | { kind: 'open-where' }
  | { kind: 'open-rules' }
  | { kind: 'open-settings' }
  | { kind: 'pick-machine'; taskId: string }
  | { kind: 'fix'; id: string }
  | { kind: 'retry-held' }
  | { kind: 'wake' }
  | { kind: 'move'; toId: string }
  | { kind: 'move-cancel'; moveId?: string }
  | { kind: 'move-retry'; moveId?: string }
  | { kind: 'move-stay'; moveId?: string }
  /** The owner takes the home back: the home asks the machine MoMo was moving to first and only then reclaims the lease; a device that never ran the move passes which one. */
  | { kind: 'reclaim'; moveId?: string; toId?: string }
  | { kind: 'move-ack'; moveId?: string }
  | { kind: 'choose-home'; machineId: string }
  | { kind: 'add-machine' }
  /** Connect, reconnect or grant send runs on this phone (the sign-in needs its browser); remove goes to the home. */
  | { kind: 'google'; intent: 'connect' | 'reconnect' | 'grant-send' | 'remove' }
  | { kind: 'note-create'; title: string; text: string }
  | { kind: 'update-machine'; machineId: string }
  | { kind: 'install-agent'; agent: Agent; machineId: string }
  | { kind: 'sign-in-agent'; agent: Agent; machineId: string }
  | { kind: 'send'; turnId: string; text: string }
  | { kind: 'check-turn'; turnId: string }
  | { kind: 'stop-turn'; turnId: string }
  | { kind: 'approval'; cardId: string; answer: 'send' | 'edit' | 'deny' | 'ask-again'; body?: string }
  | { kind: 'question'; id: string; optionId: string }
  | { kind: 'task-act'; taskId: string; fixId: string }
  | { kind: 'offer'; briefDay: string; offerId: string; action: 'start' | 'hide' }
  | { kind: 'rule-undo'; ruleId: string }
  | { kind: 'rule-set'; ruleId: string; on: boolean }
  | { kind: 'task-stop'; taskId: string }
  /** Stops watching a watched task: no session runs, so (like the Mac) nothing is asked first. */
  | { kind: 'task-stop-watching'; taskId: string }
  | { kind: 'task-retry'; taskId: string; machineId?: string }
  | { kind: 'task-check'; taskId: string }
  | { kind: 'task-snooze'; taskId: string }
  | { kind: 'task-attach'; taskId: string }
  | { kind: 'note-edit'; noteId: string; lineId: string; text: string }
  | { kind: 'note-forget'; noteId: string; lineId: string }
  | { kind: 'open-source'; sourceId: string }
  | { kind: 'note-undo'; noteId: string; changeId: string }
  | { kind: 'note-restore'; noteId: string }
  | { kind: 'prefs'; patch: PrefsPatch }
  | { kind: 'notice-draft-reply'; noticeId: string }
  | { kind: 'notice-remind'; noticeId: string; at: string }
  | { kind: 'notice-not-needed'; noticeId: string; decisionId?: string };

/** The seam the home lane backs: every user action is one intent, and the home answers with a fresh view (or the real cause and a fix). */
/** `turn` is the home's status for a turn it was asked about: it has it, it never had it, or it cannot say. Only `missing` lets a message go again. */
export type IntentResult =
  | { ok: true; view?: Partial<PhoneView>; turn?: 'has' | 'missing' | 'unknown' }
  | { ok: false; cause: string; fix?: Intent; fixLabel?: string };
export type MomoTransport = {
  load(): Promise<PhoneView>;
  send(intent: Intent): Promise<IntentResult>;
  subscribe(listener: (patch: Partial<PhoneView>) => void): () => void;
};

export type NotificationAction = 'draft-reply' | 'remind-at-4' | 'not-needed';
