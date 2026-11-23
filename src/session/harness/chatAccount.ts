// Which account a chat is on, for every first-class harness and every place that shows it: the user's pin
// and the account its turns actually run on, both keyed by the MoPilot chat id (design/multi-account rule 1).
import { useMemo } from 'react';
import { get as getState, useStore } from '../../store/core';
import type { AppState } from '../../store/state';
import { codexThreadOf } from '../../harness/family';
import { loginUnread } from '../../harness/accounts';
import type { ChatAccount } from '../../harness/chatAccountLabel';
import type { HarnessId } from '../../harness/types';

export type { ChatAccount };

/** What a chat's account is read from: both harnesses' pools, Claude's per-chat logins and the chat's segments. */
export type ChatAccountState = Pick<AppState, 'claudeChats' | 'claudeAccounts' | 'accounts' | 'segments'>;

/** A login folded into another of the same server account (#1312) is that one: the account shown for it. */
const shownClaude = (s: ChatAccountState, id: string) => s.claudeAccounts.same?.[id] ?? id;
const claudeKnown = (s: ChatAccountState, id: string) =>
  !!id && (s.claudeAccounts.accounts.length ? s.claudeAccounts.accounts.some((a) => a.id === id) : id === 'default');
const claudeSignedIn = (s: ChatAccountState, id: string) =>
  !!id &&
  (s.claudeAccounts.accounts.length
    ? s.claudeAccounts.accounts.some((a) => a.id === id && (a.loggedIn || loginUnread(a)))
    : id === 'default');

/** The account a chat is on, or null when it has none of its own on that harness (the harness's account in use applies). */
export function chatAccount(h: HarnessId, chatId: string | null, s: ChatAccountState = getState()): ChatAccount | null {
  if (!chatId) return null;
  if (h === 'claude') {
    const c = s.claudeChats[chatId];
    if (!c) return null;
    // the login its last turn ran on (main also weighs limits the window can't see, electron/harness/claude/adapter.cjs
    // accountOf); `serving` is dropped once the pinned login signs in again (claude/accounts.ts)
    const ran = shownClaude(s, c.serving ?? c.id);
    const own = shownClaude(s, c.id);
    const serving = claudeSignedIn(s, ran) ? ran : claudeSignedIn(s, own) ? own : s.claudeAccounts.active;
    const pinned = c.pinned && claudeKnown(s, own);
    return { id: pinned ? own : serving, pinned, serving };
  }
  // the relay knows the chat by its Codex thread, which a switch away and back keeps
  const thread = codexThreadOf(s.segments[chatId], chatId);
  const p = thread ? s.accounts.chatAccounts?.[thread] : null;
  return p ? { id: p.id, pinned: p.pinned, serving: p.id } : null;
}

export function useChatAccount(h: HarnessId, chatId: string | null): ChatAccount | null {
  const claudeChats = useStore((s) => s.claudeChats);
  const claudeAccounts = useStore((s) => s.claudeAccounts);
  const accounts = useStore((s) => s.accounts);
  const segments = useStore((s) => (chatId ? s.segments[chatId] : undefined));
  return useMemo(
    () => chatAccount(h, chatId, { claudeChats, claudeAccounts, accounts, segments: { [chatId ?? '']: segments ?? [] } }),
    [h, chatId, claudeChats, claudeAccounts, accounts, segments],
  );
}
