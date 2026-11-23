// Account-scoped Claude usage reads, caching and background refresh integration.
import { native } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { get as getState, set as setState } from '../../../store/core';
import { type HarnessStatus, type UsageReason } from '../../../harness/types';
import { createUsageRefresher, loginUsage, mergeUsage, usageFetchState } from '../../../harness/claudeUsage';

function noteUsageFetch(
  account: string,
  fetchState: 'loading' | 'unavailable' | 'error',
  fetchError: string | null = null,
  who?: string | null,
) {
  const s = getState();
  const prev = s.claudeUsage[account] ?? null;
  noteUsage(account, usageFetchState(prev, fetchState, fetchError, who));
}

const refreshUsageForAccount = createUsageRefresher({
  read: (id, reason) => {
    const bin = getState().claude.status.bin;
    return bin ? native.claude.usage(bin, id, reason) : Promise.resolve({ state: 'error', error: 'Claude Code is not installed.' });
  },
  current: (id) => getState().claudeUsage[id] ?? null,
  noteReading: noteUsage,
  noteFetch: noteUsageFetch,
});

/**
 * Plan usage of every signed-in Claude account, read again where `reason` finds it due (main decides, per login:
 * electron/identity/contract/usageRefresh.cjs); concurrent callers share each request.
 */
export async function refreshClaudeUsage(reason: UsageReason = 'surface') {
  const { bin, state } = getState().claude.status;
  // Each login is read for itself: the one in use being checked or signed out says nothing of the others, and
  // a login just signed in again is read at once (#1582). A key billing the whole harness has no plan usage.
  if (!bin || state === 'apikey') return;
  const { active, accounts, same = {} } = getState().claudeAccounts;
  const ids = accounts.length
    ? accounts.filter((a) => (a.loggedIn || a.id === active) && !/api.?key|console/i.test(a.authMethod ?? '')).map((a) => a.id)
    : [active];
  // a login folded into the same server account (#1312) is still read: its reading is how main learns it was signed in
  // again as another account (harness/claude/loginIdentity.cjs), and noteUsage drops the figures of a login not listed
  await Promise.all([...ids, ...Object.keys(same)].map((id) => refreshUsageForAccount(id, reason)));
}

/** Sign-in retires local requests too: a new "now" must reach main, even if an old "now" is pending. */
export function invalidateClaudeUsage(ids: Iterable<string>) {
  for (const id of ids) refreshUsageForAccount.invalidate(id);
}

/** refreshClaudeUsage for a timer or an event: the figures stay as last read when it fails, and the next refresh asks again. */
export function refreshUsageInBackground(reason: UsageReason = 'background'): void {
  refreshClaudeUsage(reason).catch(ignoring('refresh Claude Code usage'));
}

/**
 * What a turn on the login reported: the quota of its server account, so a login folded into another of the same
 * account (#1312) has it noted on the login shown for it. Its own polls are not kept (its CLI's cache may be another's).
 */
export function noteLiveUsage(login: string, usage: HarnessStatus['usage'], startedAs?: string | null) {
  const { same, accounts } = getState().claudeAccounts;
  const shown = same?.[login] ?? login;
  // of the account the turn's process started as (main's evt.serverAccount: it keeps that token), else the account the
  // login is now (null while not known), so a sign-in as another account drops it (#1582)
  const account = startedAs ?? accounts.find((a) => a.id === shown)?.serverId ?? null;
  noteUsage(shown, usage && { ...usage, account });
}

/** Record a usage reading for one account (and the harness status when it's the one in use). */
export function noteUsage(account: string, usage: HarnessStatus['usage']) {
  setState((s) => {
    // An account removed while its query was running must not regain a cache entry.
    if (s.claudeAccounts.accounts.length && !s.claudeAccounts.accounts.some((a) => a.id === account)) return {};
    const prev = s.claudeUsage[account] ?? null;
    const reading = usage?.fetchState && usage.fetchState !== 'success' ? usage : mergeUsage(prev, usage);
    // the same figures again (an older answer than a chat's live reading, asked for each minute) change nothing
    if (prev && JSON.stringify(reading) === JSON.stringify(prev)) return {};
    return {
      claudeUsage: { ...s.claudeUsage, [account]: reading },
      ...(account === s.claudeAccounts.active
        ? { claude: { ...s.claude, status: { ...s.claude.status, usage: loginUsage({ [account]: reading }, s.claudeAccounts, account) } } }
        : {}),
    };
  });
}
