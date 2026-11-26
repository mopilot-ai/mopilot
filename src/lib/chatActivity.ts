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

// Activity advances at message and tool-result boundaries without rebuilding the sidebar for each text delta.
const OUTPUT = new Set(['item/started', 'item/completed']);

export const isChatOutput = (method: string, itemType?: string) => OUTPUT.has(method) && !!itemType && itemType !== 'statusNote';

/** A rewind can move Claude's resume point without writing a new native transcript message. */
export function withChatRewinds<T extends Active>(threads: Record<string, T>, rewoundAt?: Record<string, number>): Record<string, T> {
  let result = threads;
  for (const [id, at] of Object.entries(rewoundAt ?? {})) {
    const thread = Object.hasOwn(threads, id) ? threads[id] : undefined;
    if (!thread || at <= activityAt(thread)) continue;
    if (result === threads) result = { ...threads };
    result[id] = { ...thread, recencyAt: at };
  }
  return result;
}

interface Touchable extends Active {
  preview: string;
  ephemeral?: boolean;
}

/**
 * The store change for activity in a chat at `now` (Claude Code's lastActivityAt): a turn starting (the user's
 * send, a queued or scheduled one, another app's), live output, a turn ending, an answered approval or
 * question, or a successful rewind. A starting turn also puts the chat first in the list and gives it a preview,
 * except a side chat, which never joins the sidebar.
 */
export function touched<T extends Touchable>(
  s: { threads: Record<string, T>; threadOrder: string[] },
  chatId: string,
  now: number,
  started?: { text: string },
) {
  const t = s.threads[chatId];
  const at = t ? Math.max(now, activityAt(t) || 0) : now;
  const threads = t
    ? { ...s.threads, [chatId]: { ...t, updatedAt: at, recencyAt: at, ...(started && { preview: t.preview || started.text }) } }
    : s.threads;
  if (!started) return t ? { threads } : {};
  return { threads, threadOrder: t?.ephemeral ? s.threadOrder : [chatId, ...s.threadOrder.filter((x) => x !== chatId)] };
}
