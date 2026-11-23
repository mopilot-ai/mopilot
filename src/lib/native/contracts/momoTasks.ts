// MoMo's Tasks as the Tasks tab gets them (A1, electron/momo/tasks.cjs).

/**
 * One task: a routine run going, an open loop awake, or an approval card waiting. `id` is its source's id, the same after a Mac restart;
 * `ref` is what the source's own call takes (a loop's id, a card's id, a run's chat id).
 */
export interface MomoTask {
  id: string;
  kind: 'run' | 'loop' | 'card';
  state: 'running' | 'needs-you';
  title: string;
  detail: string | null;
  at: number | null;
  dueAt: number | null;
  dueDay: string | null;
  ref: string;
  /** a card waiting in a channel (A2): that channel, and the chat it waits in; null for main's cards and every other kind */
  channel?: { id: string; name: string } | null;
  chatId?: string | null;
}

/** Every answer: what was asked for, or why not (`reason`: MoMo is not allowed). */
export type MomoTasksResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; reason?: 'not_allowed' | 'unavailable' | 'expired' | 'skipped' };

/** What the user may do to a run (`reopen` clears a mark). */
export type MomoTaskMark = 'done' | 'archive' | 'delete' | 'reopen';

/** One row of the four-tab panel (electron/momo/tasksPanel.cjs): `tab` says where it sits, `state` which word it carries. */
export interface MomoPanelTask {
  id: string;
  kind: 'card' | 'loop' | 'run' | 'routine' | 'brief';
  tab: 'active' | 'next' | 'scheduled' | 'resolved';
  state: 'needs-you' | 'running' | 'failed' | 'review' | 'queued' | 'scheduled' | 'done' | 'dismissed' | 'archived';
  title: string;
  detail: string | null;
  /** when it started, ended, was said or closed */
  at: number | null;
  dueAt: number | null;
  dueDay: string | null;
  ref: string;
  /** how a run ended: completed, stopped, failed or interrupted */
  outcome: string | null;
  /** a routine's next run, and whether it is paused */
  nextAt: number | null;
  paused: boolean;
  /** a card waiting in a channel (A2): that channel, and the chat it waits in; null for main's cards and every other kind */
  channel?: { id: string; name: string } | null;
  chatId?: string | null;
}
