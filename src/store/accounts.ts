// Codex sign-in and the multiple-accounts pool. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { codexApi } from '../harness/adapters/codexApi';
import { native, type AccountsEvent } from '../lib/native';
import { errorText, ignoring } from '../lib/ignored';
import { switchNoteText } from '../../shared/switch.mjs';
import { set, get, toast } from './core';
import { chatOf, accountNote } from './chats';
import { codexThreadOf } from '../harness/family';
import { ensureCodex, refreshAccount, refreshRateLimits } from './connection';
import { navigate } from './panes';
import type { UsageReason } from '../harness/types';
import { ACCOUNT_REMOVED } from './liveAction';

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */
// signing in, with a key or out is a use of Codex: it starts first if it was left for first use (D-66)
export async function login() {
  await ensureCodex();
  const r = await codexApi.loginChatgpt();
  set({ loginPending: { loginId: r.loginId, authUrl: r.authUrl } });
  // no browser opened: say so, with the address to finish signing in by hand
  if (r.authUrl)
    native.shell
      .openExternal(r.authUrl)
      .catch((e) => toast(`Couldn't open the browser to sign in (${errorText(e)}): ${r.authUrl}`, 'error'));
}
/** Stop waiting for the ChatGPT sign-in `login` started (its browser tab was closed): the button is free again at once. */
export async function cancelChatgptLogin() {
  const pending = get().loginPending;
  set({ loginPending: null });
  // one that already ended has nothing to cancel
  if (pending?.loginId) await codexApi.loginCancel(pending.loginId).catch(ignoring('cancel the ChatGPT sign-in'));
}
/** Sign Codex in with an OpenAI API key: kept as its own account like Settings' key, and refused when OpenAI rejects it. */
export async function loginWithApiKey(apiKey: string) {
  await ensureCodex();
  await addCodexApiKey(apiKey);
}
/** Signs the active account out. With several accounts, the next one takes over. */
export async function logout() {
  const { accounts } = get();
  if (!accounts.active) {
    await ensureCodex();
    await codexApi.logout();
    return refreshAccount();
  }
  set({ accounts: await native.accounts.remove(accounts.active) });
  await Promise.allSettled([refreshAccount(), refreshRateLimits()]);
}

/* ------------------------------------------------------------------ */
/* multiple accounts                                                   */
/* ------------------------------------------------------------------ */
const accountLabel = (email: string | null | undefined) => email ?? 'another account';

export async function switchAccount(id: string) {
  try {
    set({ accounts: await native.accounts.switchTo(id) });
    await Promise.allSettled([refreshAccount(), refreshRateLimits()]);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
/** Subscription ⇄ API key for Codex. Throws a readable message (e.g. no key yet). */
export async function setCodexMode(mode: 'subscription' | 'apiKey' | 'mopilot') {
  try {
    set({ accounts: await native.accounts.setMode(mode) });
  } catch (e) {
    throw new Error(errorText(e));
  }
  await Promise.allSettled([refreshAccount(), refreshRateLimits()]);
}
export async function addCodexApiKey(key: string, baseUrl?: string, replaceId?: string | null) {
  try {
    set({ accounts: await native.accounts.addApiKey(key, baseUrl, replaceId ?? null) });
  } catch (e) {
    throw new Error(errorText(e));
  }
  await Promise.allSettled([refreshAccount(), refreshRateLimits()]);
}
/** Starts a browser sign-in; with `targetId` it re-verifies that account instead of adding one. */
export async function addAccount(targetId?: string) {
  try {
    set({ accounts: await native.accounts.login(targetId ?? null) });
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
/** An expired toast's "Sign in again", read at the click: an account removed since is said, never added anew (main refuses it too). */
export function signInAgain(id: string) {
  if (!get().accounts.accounts.some((a) => a.id === id)) return toast(ACCOUNT_REMOVED, 'error');
  return addAccount(id);
}
export async function cancelAccountLogin() {
  set({ accounts: await native.accounts.cancelLogin() });
}
export async function removeAccount(id: string) {
  set({ accounts: await native.accounts.remove(id) });
  await Promise.allSettled([refreshAccount(), refreshRateLimits()]);
}
/** Each Codex account's usage that `reason` finds due; main decides per account (electron/identity/contract/usageRefresh.cjs). */
export async function refreshAccountsUsage(reason: UsageReason = 'surface') {
  set({ accounts: await native.accounts.refreshUsage(reason) });
}
export async function setAutoSwitch(on: boolean) {
  set({ accounts: await native.accounts.setAutoSwitch(on) });
}
export async function setAccountPool(mode: 'spread' | 'single') {
  set({ accounts: await native.accounts.setPool(mode) });
}
/**
 * Put a Codex chat on one account, or back on the pool (null). The relay keys it by the chat's Codex
 * thread, which a switch away and back keeps; a chat that has never been on Codex has none to pin yet
 * (a switch to Codex pins its new thread itself, electron/session/switch.cjs).
 */
export async function pinCodexChat(chatId: string, id: string | null) {
  const thread = codexThreadOf(get().segments[chatId], chatId);
  if (!thread) return;
  set({ accounts: await native.accounts.pinChat(thread, id) });
}
/** A fork or side chat of a Codex chat stays on the account the user put the chat on (design-v2 commandLayer 19). */
export async function inheritCodexPin(parentChatId: string, childThread: string) {
  const s = get();
  const thread = codexThreadOf(s.segments[parentChatId], parentChatId);
  const pin = thread ? s.accounts.chatAccounts?.[thread] : null;
  if (pin?.pinned) set({ accounts: await native.accounts.pinChat(childThread, pin.id) });
}

export function onAccountsEvent(e: AccountsEvent) {
  if (e.type === 'changed') {
    const prev = get().accounts.active;
    set({ accounts: e.state });
    // cannot reject: allSettled waits for both, whatever each does
    if (prev && prev !== e.state.active) void Promise.allSettled([refreshAccount(), refreshRateLimits()]);
    return;
  }
  switch (e.kind) {
    case 'switched':
    case 'moved': {
      const why = e.reason === 'limit' ? 'reached its usage limit' : e.reason === 'expired' ? 'needs to sign in again' : "isn't available";
      const chat = e.threadId ? chatOf(e.threadId) : null;
      if (!(chat && accountNote(chat, switchNoteText({ reason: e.reason, from: accountLabel(e.from), to: accountLabel(e.to) }))))
        toast(`${e.kind === 'moved' ? 'Moved this chat' : 'Switched'} to ${accountLabel(e.to)} — ${accountLabel(e.from)} ${why}`, 'info', {
          duration: 6000,
        });
      break;
    }
    case 'resume': {
      // A turn stopped on a usage limit; it continues on another account without the user retyping.
      const chat = chatOf(e.threadId);
      if (!accountNote(chat, switchNoteText({ reason: 'limit', from: accountLabel(e.from), to: accountLabel(e.to) })))
        toast(`Continuing on ${accountLabel(e.to)} — ${accountLabel(e.from)} reached its usage limit`, 'info', { duration: 6000 });
      // main joins the account move with the actual turn completion: once, and with no window open too
      break;
    }
    case 'exhausted':
      toast('All your accounts have reached their usage limits', 'error', {
        action: { label: 'View usage', run: () => navigate({ name: 'settings', section: 'account' }) },
      });
      break;
    case 'expired':
      toast(`Sign-in expired for ${accountLabel(e.email)}`, 'error', { action: { label: 'Sign in again', run: () => signInAgain(e.id) } });
      break;
    case 'signedIn':
      if (e.mismatch)
        toast(`Signed in as ${accountLabel(e.email)}, not ${e.mismatch}. ${e.added ? 'It was added as a new account.' : ''}`, 'error', {
          duration: 8000,
        });
      else toast(e.added ? `Added ${accountLabel(e.email)}` : `Signed in again as ${accountLabel(e.email)}`, 'success');
      break;
    case 'loginFailed':
      toast(e.error, 'error');
      break;
  }
}
