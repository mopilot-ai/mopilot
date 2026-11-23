// MoMo's main chat contracts (electron/momo/mainChat.cjs): its brain and what a brain change did.

/** The harness, account and model MoMo's main chat runs on (prefs momo.brain.main). */
export interface MomoBrain {
  /** 'codex', 'claude' or 'acp:<id>' */
  harness: string;
  /** the account it runs on there; null: the harness's own (a basic harness has one sign-in) */
  account: string | null;
  /** null: the harness's default (a basic harness's model is the chat's own option) */
  model: string | null;
  /** the model's name in the switch divider */
  modelLabel: string | null;
  /** the effort MoMo replies at; null: the model's default (a basic harness's thought level is its session's own) */
  effort: string | null;
}

/** The main chat, and a warning when part of the brain couldn't be applied (the chat goes on). */
export interface MomoMainChatInfo {
  chatId: string;
  warning: string | null;
}

/**
 * What a brain change did: saved only (no main chat yet), applied now, with the chat's next message (a switch in place),
 * or a new main chat (`previous` is the one it replaced).
 */
export interface MomoBrainChange {
  brain: MomoBrain;
  chatId: string | null;
  applied: 'saved' | 'now' | 'nextMessage' | 'newChat';
  previous?: string;
  warning: string | null;
}

/** One of MoMo's earlier main chats (a brain change replaced it): readable again from MoMo's navigation. */
export interface MomoPreviousChat {
  chatId: string;
  /** the harness it last ran on, by name */
  harness: string;
  /** when it was last written (ms) */
  at: number;
}

/** One of MoMo's routine runs or errands as its activity lists it (electron/momo/activity.cjs), newest first. */
export interface MomoActivityItem {
  id: string;
  kind: 'routine' | 'errand';
  title: string;
  state: 'running' | 'needs-you' | 'done' | 'failed';
  /** the MoMo chat the work ran in */
  chatId: string;
  /** ms */
  startedAt: number;
}
