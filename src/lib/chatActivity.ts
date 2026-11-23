// A chat's last activity, which orders the sidebar's chats and projects on every harness as Claude Code's "Last activity" does.

export interface Active {
  updatedAt: number;
  recencyAt?: number | null;
}

/**
 * When the chat last had activity, in Unix seconds: the later of its harness's own last write (the agent's
 * output included) and the last activity this app saw (`touched`). Opening, renaming or pinning a chat is not
 * activity.
 */
export const activityAt = (t: Active) => Math.max(t.updatedAt, t.recencyAt ?? 0);

/** Newest activity first. */
export const byActivity = (a: Active, b: Active) => activityAt(b) - activityAt(a);

interface Touchable extends Active {
  preview: string;
  ephemeral?: boolean;
}

/**
 * The store change for activity in a chat at `now` (Claude Code's lastActivityAt): a turn starting (the user's
 * send, a queued or scheduled one, another app's), a turn ending (the agent's last output, a stop) and an
 * answered approval or question. A starting turn also puts the chat first in the list and gives it a preview,
 * except a side chat, which never joins the sidebar.
 */
export function touched<T extends Touchable>(
  s: { threads: Record<string, T>; threadOrder: string[] },
  chatId: string,
  now: number,
  started?: { text: string },
) {
  const t = s.threads[chatId];
  const threads = t
    ? { ...s.threads, [chatId]: { ...t, updatedAt: now, recencyAt: now, ...(started && { preview: t.preview || started.text }) } }
    : s.threads;
  if (!started) return t ? { threads } : {};
  return { threads, threadOrder: t?.ephemeral ? s.threadOrder : [chatId, ...s.threadOrder.filter((x) => x !== chatId)] };
}
