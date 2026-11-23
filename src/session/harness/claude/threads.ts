// Claude session listing, search and archived-thread metadata cache.
import { native, type ClaudeSessionInfo } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { archivedClaudeMissing, readAllPages } from '../../../lib/chatSearch';
import type { Thread } from '../../../store/types';
import { get as getState, set as setState } from '../../../store/core';
import { claudeSessionId, claudeThreadId, isAcpThread, isClaudeThread } from '../../../harness/types';
import { beginThreadVisibilityRead } from '../../../store/archiveOwnership';
import { ownerOf } from '../../../harness/ownership';
import { loadDesktopLineage } from './desktopLineage';
import { launchMark } from '../../../lib/launchMarks';
import { confirmList, settleList } from '../../../store/sidebarSnapshot';

export function sessionThread(si: ClaudeSessionInfo): Thread {
  return {
    id: claudeThreadId(si.sessionId),
    name: si.customTitle ?? null,
    preview: si.firstPrompt ?? si.summary ?? '',
    cwd: si.cwd ?? '',
    createdAt: Math.floor((si.createdAt ?? si.lastModified) / 1000),
    updatedAt: Math.floor(si.lastModified / 1000),
    status: { type: 'notLoaded' },
    gitInfo: si.gitBranch ? { branch: si.gitBranch, sha: null, originUrl: null } : null,
    projectId: null,
    parentThreadId: null,
    forkedFromId: null,
    ephemeral: false,
    turns: [],
  } as unknown as Thread;
}

const sessionInfo = new Map<string, Thread>();
/** The most sessions one listing reads. */
const LIST_CAP = 5000;

export async function loadClaudeThreads() {
  const visible = beginThreadVisibilityRead();
  launchMark('chats:claude:start', undefined, true);
  try {
    // the SDK caps a call, so read every page (a long history reaches the sidebar and Cmd+K whole)
    const cut = { truncated: false };
    const list = await readAllPages((offset, limit) => native.claude.list({ limit, offset }), 200, LIST_CAP, cut);
    launchMark('chats:claude', list.length, true);
    const archived = getState().claudeArchived;
    setState((s) => {
      const threads = { ...s.threads };
      const order = [...s.threadOrder];
      for (const si of list) {
        const t = sessionThread(si);
        if (!visible.allows(t.id)) continue;
        sessionInfo.set(t.id, t);
        if (archived[t.id]) continue;
        const prev = threads[t.id];
        threads[t.id] = prev
          ? {
              ...prev,
              ...t,
              name: t.name ?? prev.name,
              projectId: prev.projectId ?? null,
            }
          : t;
        if (!order.includes(t.id)) order.push(t.id);
      }
      return { threads, threadOrder: order };
    });
    // what the page cap or a failed page cut off is not known to be gone, and an empty list says little while the login is not read yet
    confirmList({
      listed: list.map((si) => claudeThreadId(si.sessionId)),
      owns: isClaudeThread,
      complete:
        !cut.truncated && list.length < LIST_CAP && (list.length > 0 || ['ready', 'apikey'].includes(getState().claude.status.state)),
    });
    // after the listing, so a new side session nests as soon as its row shows
    void loadDesktopLineage();
  } catch (e) {
    console.warn('Claude sessions', e);
  } finally {
    visible.finish();
    settleList('claude');
  }
}

/** Claude chats whose title or transcript holds the term (the search palette); `scope` names the search box asking. */
export async function searchClaudeThreads(term: string, scope?: string): Promise<Thread[]> {
  return (await native.claude.search(term, 30, scope)).map(sessionThread);
}

/** Keep a chat's last known Thread so the archived list can show it after it leaves the sidebar. */
export function rememberClaudeThread(t: Thread | undefined) {
  if (t) sessionInfo.set(t.id, t);
}

/**
 * Read the archived chats the session list did not return (past the paging cap, or Claude signed out)
 * from their own files, so each can be restored or deleted (D-38).
 */
export async function loadArchivedClaudeInfo() {
  const missing = archivedClaudeMissing(getState().claudeArchived, sessionInfo, (id) => ownerOf(id) === 'claude');
  await Promise.all(
    missing.map(async (id) => {
      // unreadable: that chat is left out of the archived list until it is read again
      const si = await native.claude
        .info(claudeSessionId(id))
        .catch((error) => (noteIgnored("read an archived Claude Code chat's file", error), undefined));
      if (si) sessionInfo.set(id, sessionThread(si));
    }),
  );
}

/**
 * A chat archived in Sage meta that lives on Codex and isn't known here yet (archived in an earlier run): only
 * Codex's archived list can show it, so Settings → Archived starts Codex for it.
 */
export function archivedCodexMissing(): boolean {
  return Object.keys(getState().claudeArchived).some((id) => !isAcpThread(id) && ownerOf(id) === 'codex' && !sessionInfo.has(id));
}

export function archivedClaudeThreads(): Thread[] {
  const archived = getState().claudeArchived;
  return [...sessionInfo.values()].filter((t) => archived[t.id]);
}
