// Claude account/login detection, verified-auth recovery and chat account selection.
import { useSyncExternalStore } from 'react';
import { native, type ClaudeAccountsEvent, type ClaudeAccountsState } from '../../../lib/native';
import { errorText, ignoring, noteIgnored } from '../../../lib/ignored';
import type { TurnState } from '../../../store/types';
import { chatFamily } from '../../../store/chats';
import { get as getState, patchRuntime, set as setState, toast } from '../../../store/core';
import { openPaneTab, navigate } from '../../../store/panes';
import { promptUuidOf } from '../../../harness/claudeTranslate';
import { claudePlanLabel, isClaudeAuthError, type HarnessStatus } from '../../../harness/types';
import { signInAccountFor } from '../../../harness/accounts';
import { chatAccount } from '../chatAccount';
import type { ChatAccountRecord } from '../../../lib/chatMeta';
import { claudeModels } from '../../../../shared/claudeModels.mjs';
import { invalidateClaudeUsage, refreshUsageInBackground } from './usage';
import { loginUsage } from '../../../harness/claudeUsage';
import { loadClaudeThreads } from './threads';
import { COPY } from '../../../harness/copy';
// Keep recovered errors dismissed when a transcript is read back with different turn ids.
const recoveredAuthTurns = new Map<string, Set<string>>();
const authTurnKey = (id: string) => promptUuidOf(id) ?? id;
export function withoutRecoveredAuthErrors(chatId: string, turns: TurnState[]): TurnState[] {
  const recovered = recoveredAuthTurns.get(chatId);
  return turns.map((t) => (isClaudeAuthError(t.error?.message) && recovered?.has(authTurnKey(t.id)) ? { ...t, error: null } : t));
}

/** Only dismiss authentication errors for the login that was verified successfully. */
function clearClaudeAuthErrors(account: string) {
  const s = getState();
  for (const [chatId, rt] of Object.entries(s.runtime)) {
    if (chatFamily(chatId) !== 'claude' || signInAccountFor(s.claudeChats, s.claudeAccounts, chatId) !== account) continue;
    const errors = rt.turns.filter((t) => isClaudeAuthError(t.error?.message));
    if (!errors.length) continue;
    const recovered = recoveredAuthTurns.get(chatId) ?? new Set<string>();
    errors.forEach((t) => recovered.add(authTurnKey(t.id)));
    recoveredAuthTurns.set(chatId, recovered);
    patchRuntime(chatId, (r) => ({ turns: withoutRecoveredAuthErrors(chatId, r.turns) }));
  }
}

const reloggingAccounts = new Set<string>();
let usageTimer: ReturnType<typeof setInterval> | null = null;

/**
 * A pinned login that signs in again serves its chats from their next turn: the login another turn ran on
 * while it was out is no longer where they are (design/multi-account R-4).
 */
export function backOnPin(
  chats: Record<string, ChatAccountRecord>,
  before: ClaudeAccountsState,
  after: ClaudeAccountsState,
): { claudeChats: Record<string, ChatAccountRecord> } | null {
  const was = new Set(before.accounts.filter((a) => a.loggedIn).map((a) => a.id));
  const back = new Set(after.accounts.filter((a) => a.loggedIn && !was.has(a.id)).map((a) => a.id));
  const stale = Object.entries(chats).filter(([, c]) => c.pinned && c.serving && back.has(c.id));
  if (!stale.length) return null;
  return { claudeChats: { ...chats, ...Object.fromEntries(stale.map(([id, c]) => [id, { id: c.id, pinned: true }])) } };
}

/** The one writer of the account list: a change of the login in use also detects that login again. */
export const setAccounts = (claudeAccounts: ClaudeAccountsState) => {
  const prev = getState().claudeAccounts.active;
  setState((s) => ({
    claudeAccounts,
    ...backOnPin(s.claudeChats, s.claudeAccounts, claudeAccounts),
    ...(prev !== claudeAccounts.active
      ? {
          claude: {
            ...s.claude,
            status: {
              ...s.claude.status,
              usage: loginUsage(s.claudeUsage, claudeAccounts, claudeAccounts.active),
              email: null,
              plan: null,
            },
          },
        }
      : {}),
  }));
  // the harness status describes the account in use
  if (prev !== claudeAccounts.active) detectClaude(true).catch(ignoring('detect Claude Code for the account now in use'));
};

export async function refreshClaudeAccounts() {
  setAccounts(await native.claude.refreshAccounts(getState().prefs.claudeBin));
}

/**
 * A process on this login hit an authentication error. The login on disk is stale even though `auth status` says
 * otherwise: flag it so the picker and Settings offer sign-in (the next account read replaces it).
 */
export function markClaudeLoginLapsed(account: string) {
  if (account === getState().claudeAccounts.active)
    setState((s) => ({ claude: { ...s.claude, status: { ...s.claude.status, state: 'signin' } } }));
  setState((s) => ({
    claudeAccounts: {
      ...s.claudeAccounts,
      accounts: s.claudeAccounts.accounts.map((a) => (a.id === account ? { ...a, loggedIn: false } : a)),
    },
  }));
}

/** Make a Claude account the one new chats use. */
export async function switchClaudeAccount(id: string) {
  try {
    setAccounts(await native.claude.setActiveAccount(id));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

/** Add a Claude account: its sign-in runs `claude auth login` in a terminal; it appears once that finishes. */
/** A login terminal shown inside Settings itself, so the page is not left (WP2-10). */
export type LoginTerm = { id: string; command: string[]; title: string };
let loginTerm: LoginTerm | null = null;
const loginSubs = new Set<() => void>();
const setLoginTerm = (t: LoginTerm | null) => {
  loginTerm = t;
  loginSubs.forEach((f) => f());
};
export function useClaudeLoginTerm(): LoginTerm | null {
  return useSyncExternalStore(
    (f) => (loginSubs.add(f), () => void loginSubs.delete(f)),
    () => loginTerm,
  );
}
/**
 * A sign-in for these logins ended: main drops what held their usage back (a backoff from failed reads while the token
 * had lapsed, an answer kept from before), so the next read is theirs (#1582). The login in use's sign-in too.
 */
const signInEnded = (ids: Iterable<string>) => {
  const logins = [...new Set([...ids, getState().claudeAccounts.active])];
  invalidateClaudeUsage(logins);
  return (
    native.claude
      .signInEnded(logins)
      .catch((error) => noteIgnored('tell main a Claude Code sign-in ended', error))
      // A timer may have asked while main was being told; that request is retired before the fresh read too.
      .finally(() => invalidateClaudeUsage(logins))
  );
};

/** The embedded terminal exited: close it and look at the sign-in again. */
export function endClaudeLoginTerm() {
  setLoginTerm(null);
  // recheckClaude below reads the accounts again. Usage is read as soon as the logins are, not after the re-check's
  // model call and probe (#1582).
  void signInEnded(reloggingAccounts)
    .then(() => refreshClaudeAccounts())
    .then(() => refreshUsageInBackground('now'))
    .catch((error) => noteIgnored('refresh the Claude Code accounts after a sign-in', error));
  void recheckClaude();
}

/** The login runs in the terminal beside the chat; Settings embeds it in the page instead (D-42). */
function openLoginTerminal(command: string[]) {
  const route = getState().route.name;
  if (route === 'settings') return setLoginTerm({ id: `claude-login-${crypto.randomUUID()}`, command, title: 'claude auth login' });
  openPaneTab('terminal', { command, title: 'claude auth login', cwd: getState().home, signIn: true });
  if (route !== 'thread' && route !== 'home') navigate({ name: 'home' });
}

export async function addClaudeAccount() {
  try {
    const r = await native.claude.addAccount(getState().prefs.claudeBin);
    setAccounts(r.state);
    openLoginTerminal(r.command);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
export async function cancelClaudeLogin() {
  setAccounts(await native.claude.cancelAccountLogin());
}

/** Sign an account in again (its login lapsed), in a terminal. */
export async function reloginClaudeAccount(id: string) {
  let command: string[];
  try {
    command = await native.claude.reloginCommand(getState().prefs.claudeBin, id);
  } catch (e) {
    // the button must never just do nothing
    return toast(`Couldn't start the sign-in: ${errorText(e)}`, 'error');
  }
  reloggingAccounts.add(id);
  openLoginTerminal(command);
}

/** Forget an added account. The CLI's own login is signed out with `claude auth logout`, run in the background. */
export async function removeClaudeAccount(id: string) {
  if (id === 'default') {
    const bin = getState().claude.status.bin;
    if (!bin) return;
    // runs at once, from any page (a terminal tab would only start once the chat page showed it)
    try {
      await native.claude.logout(bin);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    await detectClaude(true);
    return;
  }
  try {
    setAccounts(await native.claude.removeAccount(getState().prefs.claudeBin, id));
    setState((s) => ({ claudeChats: Object.fromEntries(Object.entries(s.claudeChats).filter(([, c]) => c.id !== id)) }));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function setClaudeAutoSwitch(on: boolean) {
  setAccounts(await native.claude.setAccountAutoSwitch(on));
}

/** Put a Claude chat on one account, or back on the account in use (null). Applies from its next message. */
export function pinClaudeChat(chatId: string, id: string | null) {
  setState((s) => {
    const { [chatId]: _old, ...rest } = s.claudeChats;
    return { claudeChats: id ? { ...rest, [chatId]: { id, pinned: true } } : rest };
  });
}

/** The account a chat runs on: its own (while signed in), else the one in use. */
export function claudeChatAccount(chatId: string): string {
  return chatAccount('claude', chatId)?.serving ?? getState().claudeAccounts.active;
}

/** A fork or side chat starts on the account its parent chat is on, pinned when the parent was (design-v2 commandLayer 19). */
export function inheritClaudeChat(parentChatId: string, childId: string) {
  setState((s) => {
    const c = s.claudeChats[parentChatId];
    return c ? { claudeChats: { ...s.claudeChats, [childId]: { id: c.id, pinned: c.pinned } } } : {};
  });
}

export function onAccountsEvent(e: ClaudeAccountsEvent) {
  if (e.type === 'changed') return setAccounts(e.state);
  if (e.kind === 'signedIn') {
    invalidateClaudeUsage([e.id]);
    toast(`Added ${e.email ?? 'a Claude account'}`, 'success');
    refreshUsageInBackground('now');
  } else if (e.kind === 'duplicate') toast(`${e.email ?? 'That account'} is already signed in`, 'error');
  else if (e.kind === 'otherAccount') {
    const text = e.addedAs ? COPY.accounts.otherAccountNotice.replaceAll('{addedAs}', e.addedAs) : COPY.accounts.otherAccountNoticeUnnamed;
    toast(text.replace('{email}', e.email ?? 'another account'), 'error');
  }
}

/** What a re-check says, and where: a toast, or under the welcome page's row that asked (#2034). */
export type Say = (text: string, kind?: 'error') => void;

/** Re-check button: also test the login with a real call, and say what happened. */
export async function recheckClaude(account?: string, say: Say = toast) {
  // A chat can be pinned to a different login from the one new chats use.
  const accounts = new Set(reloggingAccounts);
  if (account) accounts.add(account);
  // a sign-in in a terminal beside the chat ends with this check: its usage is read afresh
  await signInEnded(accounts);
  await detectClaude(true, true);
  // a newer detection that started meanwhile (a sign-in ending, the account list moving) answers for this one
  await settledDetection();
  let st: Pick<HarnessStatus, 'state' | 'error'> = getState().claude.status;
  for (const id of accounts) {
    if (id === getState().claudeAccounts.active) continue;
    // a check that failed is reported like any other state, not left unanswered
    const d = await native.claude
      .detect(getState().prefs.claudeBin, true, true, id)
      .catch((e) => ({ state: 'error' as const, error: errorText(e) }));
    if (id === account) st = d;
    if (d.state === 'ready' || d.state === 'apikey') {
      clearClaudeAuthErrors(id);
      reloggingAccounts.delete(id);
    }
  }
  if (st.state === 'signin') say('Claude Code is still signed out. Finish `claude auth login`, then re-check.', 'error');
  else if (st.state === 'ready' || st.state === 'apikey') say('Claude Code is signed in.');
  // its state's bare name ("Claude Code: missing") said nothing to do (#2034)
  else if (st.state === 'missing') say("Claude Code isn't found. Install it, or set its location in Settings.", 'error');
  // still being checked is not a failure: the row says Checking…, and its answer shows there
  else if (st.state !== 'detecting') say(`Claude Code: ${(st.error ?? st.state).split('\n')[0]}`, 'error');
}

/** Wait until no detection is under way: each newer one replaces the promise, so wait for the last. */
async function settledDetection() {
  while (detecting !== null) await detecting;
}

let detecting: Promise<void> | null = null;
let detectionVersion = 0;
/** Find the CLI, read its login state, then (if signed in) ask it for models and account. */
export function detectClaude(force = false, verify = false): Promise<void> {
  if (detecting && !force) return detecting;
  const version = ++detectionVersion;
  detecting = (async () => {
    const account = getState().claudeAccounts.active;
    const prev = getState().claude;
    setState({ claude: { ...prev, status: { ...prev.status, state: 'detecting', error: null } } });
    let d: Awaited<ReturnType<typeof native.claude.detect>>;
    try {
      d = await native.claude.detect(getState().prefs.claudeBin, force, verify);
    } catch (e) {
      // a detection that failed must not stay "detecting": the status says why, and Re-check asks again
      if (version === detectionVersion && getState().claudeAccounts.active === account)
        setState((s) => ({ claude: { ...s.claude, status: { ...s.claude.status, state: 'error', error: errorText(e) } } }));
      return;
    }
    const plan = claudePlanLabel(d.auth?.subscriptionType, d.plan?.organizationType, d.plan?.rateLimitTier);
    let status: HarnessStatus = {
      state: d.state,
      bin: d.bin,
      version: d.version,
      offPath: d.offPath,
      terminal: d.terminal,
      candidates: d.candidates,
      plan,
      email: prev.status.email ?? null,
      usage: loginUsage(getState().claudeUsage, getState().claudeAccounts, account),
      error: d.error ?? null,
      ...(d.rejected ? { rejected: true } : {}),
    };
    let models = prev.models;
    if (d.bin && (d.state === 'ready' || d.state === 'apikey')) {
      try {
        const p = await native.claude.probe(d.bin, d.account ?? null);
        models = claudeModels(p.models);
        status = {
          ...status,
          plan:
            d.state === 'apikey'
              ? (d.billing?.label ?? 'API key')
              : (claudePlanLabel(p.account.subscriptionType, d.plan?.organizationType, d.plan?.rateLimitTier) ?? plan),
          email: p.account.email,
          fastBlocked: p.fastBlocked,
        };
      } catch (e) {
        status = { ...status, error: errorText(e) };
      }
    }
    if (version !== detectionVersion || getState().claudeAccounts.active !== account) return;
    status.usage = loginUsage(getState().claudeUsage, getState().claudeAccounts, account) ?? status.usage;
    setState({ claude: { status, models } });
    if (verify && (d.state === 'ready' || d.state === 'apikey')) {
      const account = d.account ?? getState().claudeAccounts.active;
      clearClaudeAuthErrors(account);
      reloggingAccounts.delete(account);
    }
    if (d.state === 'ready' || d.state === 'apikey') {
      // keep the account list we have; the next detection reads it again
      await refreshClaudeAccounts().catch((error) => noteIgnored('refresh the Claude Code accounts after detection', error));
      if (version !== detectionVersion || getState().claudeAccounts.active !== account) return;
      loadClaudeThreads().catch(ignoring('list the Claude Code chats after detection'));
      // a Re-check the user asked for reads at once; a detection on its own counts as the surface opening
      refreshUsageInBackground(verify ? 'now' : 'surface');
      // main reads a login only when it is due (often while in use, rarely when idle): asking each minute is cheap
      if (!usageTimer) usageTimer = setInterval(() => refreshUsageInBackground(), 60 * 1000);
    } else if (d.state === 'signin')
      // the login in use is signed out: the other logins are read anyway, so the list says which still work
      await refreshClaudeAccounts().catch((error) => noteIgnored('refresh the Claude Code accounts of a signed-out login', error));
  })().finally(() => {
    if (version === detectionVersion) detecting = null;
  });
  return detecting;
}
