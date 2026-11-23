// Forking a chat that switched harness (#1941): every segment's native session is forked, so the new chat owns its own
// copy of each and shows the whole conversation, with the same hand-off dividers; it runs on where the fork point was.
import { native } from '../../lib/native';
import { errorText, noteIgnored } from '../../lib/ignored';
import { copyChatConfig, rememberChatProject } from '../../store/projects';
import { get as getState, set as setState, threadTitle, toast, upsertThread } from '../../store/core';
import { inheritCodexPin } from '../../store/accounts';
import { navigate } from '../../store/panes';
import { loadOlderTurns } from '../../store/threads';
import type { Thread } from '../../store/types';
import { inheritClaudeChat } from './claude/accounts';
import { sessionThread } from './claude/threads';
import { promptUuidOf } from '../../harness/claudeTranslate';
import { claudeSessionId, claudeThreadId, type Segment } from '../../harness/types';

/**
 * The segments a fork takes, and where each of their sessions is cut: all of them, whole, for a whole fork; for a fork
 * from the turn at `turnIndex`, those through the one holding it (the fork continues on that segment's harness), each
 * session cut at its last turn the fork keeps, so a session a switch back used again after that point (#1941 review)
 * brings no later turn along. `cuts` maps a session to that turn's index in the chat; a session not in it is whole.
 */
export function forkedSegments(segs: readonly Segment[], turnIndex: number): { keep: Segment[]; cuts: Map<string, number> } {
  const cuts = new Map<string, number>();
  if (turnIndex < 0) return { keep: [...segs], cuts };
  const keep = segs.filter((g, i) => i === 0 || g.start <= turnIndex);
  keep.forEach((g, i) => {
    // only the chat's last segment has no count, and it is the last kept when kept
    const last = i === keep.length - 1 ? turnIndex : g.start + (g.count as number) - 1;
    if (last >= g.start) cuts.set(g.nativeId, last);
  });
  return { keep, cuts };
}

/** Fork one native session, through `turnId` when given; the new session's id in the window's form, and its Codex thread. */
async function forkNative(seg: Segment, turnId: string | null): Promise<{ id: string; thread: Thread | null }> {
  if (seg.harness === 'codex') {
    const lastTurnId = turnId && !turnId.startsWith('pending-') ? turnId : undefined;
    const r = await native.codex.fork({
      threadId: seg.nativeId,
      excludeTurns: true,
      deferGoalContinuation: true,
      ...(lastTurnId ? { lastTurnId } : {}),
    });
    return { id: r.thread.id, thread: r.thread as unknown as Thread };
  }
  // discardable: if a later segment's fork fails, this one goes again (discardFork below)
  const r = await native.claude.fork(claudeSessionId(seg.nativeId), turnId ? promptUuidOf(turnId) : null, true);
  return { id: claudeThreadId(r.sessionId), thread: null };
}

/** Read the pages above a chat's window until it holds every turn; false, having said so, when they can't be read. */
async function loadedWhole(chatId: string): Promise<boolean> {
  try {
    for (let cursor = getState().runtime[chatId]?.olderCursor; cursor; ) {
      await loadOlderTurns(chatId);
      const next = getState().runtime[chatId]?.olderCursor;
      if (next === cursor) throw new Error('its earlier messages stopped loading');
      cursor = next;
    }
    return true;
  } catch (e) {
    toast(`Couldn't fork the chat: ${errorText(e)}`, 'error');
    return false;
  }
}

/**
 * Fork a chat that switched harness, through `turnId` when given: each native session its segments name (once, though a
 * switch back reuses one) is forked, the one holding the turn up to it, and the new chat takes the same segments over
 * the copies, so its transcript is the whole conversation and each harness keeps the hand-off it was given. A harness
 * that can't fork (an ACP one) refuses the fork, saying so. `rename` names it where the harness lists it (renameThread),
 * so the name outlives a restart.
 */
export async function forkSwitchedChat(
  chatId: string,
  turnId: string | undefined,
  rename: (id: string, name: string) => Promise<void>,
): Promise<string | undefined> {
  // a fork from a message cuts its sessions at turns of the chat, which the window has to hold
  if (turnId && !(await loadedWhole(chatId))) return undefined;
  const s = getState();
  // forkThread sends only a chat with several segments
  const segs = s.segments[chatId];
  const turnIndex = turnId ? (s.runtime[chatId]?.turns ?? []).findIndex((t) => t.id === turnId) : -1;
  const turns = s.runtime[chatId]?.turns ?? [];
  const { keep, cuts } = forkedSegments(segs, turnIndex);
  const unforkable = keep.find((g) => g.harness !== 'codex' && g.harness !== 'claude');
  if (unforkable) {
    toast(`This chat can't be forked: its ${unforkable.harness} part has no fork`, 'error');
    return undefined;
  }
  const forks = new Map<string, { id: string; thread: Thread | null }>();
  try {
    for (const g of keep) {
      if (forks.has(g.nativeId)) continue;
      const at = cuts.get(g.nativeId);
      // a cut is an index into the turns the fork point was found in
      forks.set(g.nativeId, await forkNative(g, at === undefined ? null : turns[at].id));
    }
  } catch (e) {
    // the sessions already forked would list as chats of their own (a Claude one does): they go again
    for (const f of forks.values())
      if (!f.thread)
        await native.claude.discardFork(claudeSessionId(f.id)).catch((error) => noteIgnored('remove a fork left half made', error));
    toast(`Couldn't fork the chat: ${errorText(e)}`, 'error');
    return undefined;
  }
  const first = forks.get(keep[0].nativeId)!;
  const id = first.id;
  const src = s.threads[chatId];
  const projectId = src?.projectId ?? s.chatProject[chatId] ?? null;
  const base = first.thread ?? sessionThread({ sessionId: claudeSessionId(id), summary: '', lastModified: Date.now(), cwd: src?.cwd });
  const name = `${threadTitle(src)} (fork)`;
  upsertThread({ ...base, name, projectId } as Thread, true);
  const next = keep.map((g, i) => ({ ...g, nativeId: forks.get(g.nativeId)!.id, count: i === keep.length - 1 ? null : g.count }));
  // the fork is marked: Codex lists a fork only once it has a message of its own (readUnlistedSwitchedChats)
  if (next.length > 1) setState((st) => ({ segments: { ...st.segments, [id]: next }, chatForkOf: { ...st.chatForkOf, [id]: chatId } }));
  await rename(id, name).catch((error) => noteIgnored('name a forked chat where its harness lists it', error));
  rememberChatProject(id, projectId);
  copyChatConfig(chatId, id);
  inheritClaudeChat(chatId, id);
  // the fork runs on the account the user put this chat on; if that can't be kept, it is said
  const codex = [...keep].reverse().find((g) => g.harness === 'codex');
  if (codex)
    await inheritCodexPin(chatId, forks.get(codex.nativeId)!.id).catch((e) =>
      toast(`The fork couldn't keep this chat's account (${errorText(e)}); it uses the pool's`, 'error'),
    );
  navigate({ name: 'thread', id });
  toast('Forked into a new chat');
  return id;
}
