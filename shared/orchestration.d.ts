// What windows read of linked sessions (electron/session/orchestration): which chat started which, the sessions a chat
// proposed, and the items main delivered as a brief, a wake-up or a family message, so a thread shows them as such.

/** How a child's last turn ended. */
export type SideSessionEnding = 'finished' | 'failed' | 'stopped' | 'lost';

export type SideSessionChild = {
  parentId: string;
  /** Historical parent is retained after lineage is detached. */
  detached?: boolean;
  awaitingBrief?: boolean;
  /** its short handle */
  name: string;
  title: string;
  /** how long its turns worked (main times each turn it sends); `since`: when the running one started */
  worked?: { ms: number; turns: number; since: number | null } | null;
  /** the globs it declared for the parent's folder it shares (start_session `paths`) */
  paths?: string[] | null;
  /** files its turns edited outside those paths, relative to the folder (a file outside it by its whole path) */
  outside?: string[] | null;
  harness: string | null;
  /** it works in its own managed worktree */
  useWorktree: boolean;
  createdAt: number;
  lastReport: { how: SideSessionEnding; report: string | null; at: number } | null;
  /** what git says its worktree branch did against its parent's branch, read after each of its turns */
  facts?: SessionFacts | null;
  /** where the user merged its branch from its card */
  merged?: { into: string; commit: string; at: number } | null;
};

/** A session's worktree branch in git (electron/session/orchestration/bringBack.cjs). */
export type SessionFacts = {
  branch: string;
  /** the parent's branch it is compared with */
  base: string;
  ahead: number;
  files: number;
  added: number;
  removed: number;
  uncommitted: number;
  pr: { number: number; state: string; url: string } | null;
  at: number;
};

/** What a card's Merge or Open PR did. */
export type SessionWorkResult =
  | { status: 'merged'; into: string; commit: string }
  | { status: 'conflicts'; into: string; files: string[] }
  | { status: 'opened' }
  | { status: 'refused'; reason: string; message: string };

export type SideSessionDelivery =
  | {
      kind: 'brief';
      chatId: string;
      from: string;
      title: string;
      body: string;
      task?: string;
      context?: string | null;
      fork?: boolean;
      harness?: string;
      at: number;
    }
  | {
      kind: 'wake';
      chatId: string;
      harness?: string;
      at: number;
      notes: { childId: string; body: string }[];
      /** it left the parent's queue before it ran (ms epoch); its notes went back to the parent */
      removedAt?: number;
      removedReason?: 'user' | 'archived' | 'deleted';
    }
  | {
      kind: 'message';
      chatId: string;
      from: string;
      body: string;
      at: number;
      /** it left the recipient's queue before it ran (ms epoch); its sender sees it in list_sessions */
      removedAt?: number;
      /** why: the user removed it, or the recipient was archived or deleted (absent: the user) */
      removedReason?: 'user' | 'archived' | 'deleted';
    };

/** A session a chat proposed instead of starting (start_session with initiation offer or own_initiative). */
export type SideSessionProposal = {
  parentId: string;
  /** offer: the user named the task and chooses where it runs; own_initiative: the agent's suggestion */
  kind: 'offer' | 'own_initiative';
  title: string;
  /** the brief, as far as windows show it */
  prompt: string;
  status: 'open' | 'briefing' | 'starting' | 'started' | 'dismissed' | 'declined' | 'expired';
  /** the session it started */
  chatId: string | null;
  expiresAt: number;
  /** an offer whose call waits for the user's answer on its card */
  waiting: boolean;
  /**
   * a waiting offer counting down (ms epoch): from when, and when it goes ahead as "New session" for a user who has not
   * answered; absent once answered or taken in hand (its start options, "Don't ask again", a click)
   */
  countdown?: { from: number; at: number };
  /** where it would run: a fork of the chat, its own worktree, or the chat's folder */
  place: 'fork' | 'worktree' | 'folder';
};

export type OrchestrationView = {
  /** Family roots retain lifecycle cleanup even when their last start failed before a child was linked. */
  families?: string[];
  children: Record<string, SideSessionChild>;
  /** by the delivered item's id */
  deliveries: Record<string, SideSessionDelivery>;
  /** by task id */
  proposals: Record<string, SideSessionProposal>;
  /** the chats whose briefs or follow-ups wait for a free slot, first in line first (a chat once per waiting item) */
  queue: string[];
  /**
   * each chat's own task list, set by its agent (update_task_list); `stale`: the user sent a message since the agent
   * last updated it, so it is the plan from before that message
   */
  plans: Record<string, { items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]; stale: boolean }>;
  /** each chat's wrap-up box: its recap, question and answers; only a wrap-up with a question and answers has one */
  wrapUps: Record<string, { recap: string; ask: string | null; actions: { label: string; message: string | null }[] }>;
  /**
   * the sessions made with their brief waiting for others (start_session `after`): the chat ids they wait for, and
   * which one holds them and how it ended when one failed, was stopped, was lost or is gone
   */
  waiting?: Record<string, { after: string[]; held: { by: string; how: SideSessionHeldHow } | null }>;
};

/** How the session that holds a waiting one ended (electron/session/orchestration/dependants.cjs HELD_HOW). */
export type SideSessionHeldHow = 'failed' | 'stopped' | 'lost' | 'gone' | 'cycle';
