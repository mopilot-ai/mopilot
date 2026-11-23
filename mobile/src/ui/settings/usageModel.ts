// What the Usage page shows, as plain data: each account's windows with a remaining share and a relative reset, honest when nothing is known, and the auto-switch setting per agent.
import { USAGE_READ_FRESH_MS } from '../../../../shared/claudeRateLimit.mjs';
import type { AccountList, LoginAccount } from '../../remote/accounts';
import { harnessChip } from '../../presentation/chatChips';
import type { UsageAccount, UsageWindow } from '../../remote/usage';
import { text, thresholds } from './settingsAdapters';

export type Tone = 'ok' | 'warn' | 'bad' | 'quiet';
export type WindowView = {
  key: string;
  label: string;
  /** the share left, 0 to 100; null when the reading is past its reset and says nothing */
  left: number | null;
  value: string;
  reset: string;
  /** "Last known" when the reading is old */
  note: string | null;
  tone: Tone;
};
export type AccountView = {
  key: string;
  title: string;
  /** Active, Signed out, Expired, Limited; empty when none applies */
  status: string;
  statusTone: Tone;
  windows: WindowView[];
  /** why there are no windows, in a few words */
  note: string | null;
};
export type HarnessView = {
  harness: string;
  title: string;
  /** null when the Mac sends no setting for this agent (an older Mac, or an agent without logins) */
  autoSwitch: boolean | null;
  accounts: AccountView[];
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** "Resets in 2 h 10 min", "Resets in 40 min", or the day and time beyond a day; an old reading says it is past. */
export function resetWords(w: Pick<UsageWindow, 'resetsAt' | 'resetsText'>, now: number): string {
  if (w.resetsAt !== null) {
    const ms = w.resetsAt * 1000 - now;
    if (ms <= 0) return text('usage.resetPast');
    if (ms < MIN) return text('usage.resetUnder');
    const mins = Math.round(ms / MIN);
    if (mins < 60) return text('usage.resetInMin', { n: mins });
    if (ms < 24 * HOUR) {
      const h = Math.floor(mins / 60);
      return mins % 60 ? text('usage.resetInHMin', { h, m: mins % 60 }) : text('usage.resetInH', { h });
    }
    return text('usage.resetAt', {
      at: new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    });
  }
  return w.resetsText ? text('usage.resetAt', { at: w.resetsText }) : text('usage.resetUnknown');
}

/** The tone of a share left: quiet when old, red and amber when low. */
const toneOf = (left: number, stale: boolean): Tone =>
  stale ? 'quiet' : left <= thresholds.critical ? 'bad' : left <= thresholds.low ? 'warn' : 'ok';

export function windowView(w: UsageWindow, now: number): WindowView {
  const past = w.resetsAt !== null && w.resetsAt * 1000 <= now;
  const stale = w.stale || !w.at || now - w.at > USAGE_READ_FRESH_MS;
  const base = { key: w.label, label: w.label, reset: resetWords(w, now) };
  // a figure from before its own reset is not a figure: never shown as fresh quota
  if (past) return { ...base, left: null, value: text('usage.refreshNeeded'), note: null, tone: 'quiet' };
  const left = Math.max(0, 100 - Math.round(w.usedPercent));
  return { ...base, left, value: text('usage.left', { n: left }), note: stale ? text('usage.lastKnown') : null, tone: toneOf(left, stale) };
}

/** Read when drawn: the words follow the shown language. */
const statusOf = (status: string): [string, Tone] | null =>
  status === 'signedOut' ? [text('account.signedOut'), 'bad'] : status === 'expired' ? [text('account.expired'), 'bad'] : null;
const noteOf = (state: string): string => (state === 'unsupported' ? text('usage.unsupported') : text('usage.unavailable'));

/** One login: its status from the Mac's account list when it has one, its windows from the usage read. */
function accountView(login: LoginAccount | null, usage: UsageAccount | null, now: number): AccountView {
  const id = login?.account ?? (usage as UsageAccount).account;
  const [status, statusTone]: [string, Tone] =
    (login && statusOf(login.status)) ||
    (login?.limited
      ? [text('account.limited'), 'warn']
      : (login?.active ?? usage?.active)
        ? [text('account.active'), 'ok']
        : ['', 'quiet']);
  const signedOut = (login ? login.status !== 'ok' : false) || usage?.state === 'signin';
  const windows = !signedOut && usage?.state === 'available' ? usage.windows.map((w) => windowView(w, now)) : [];
  return {
    key: id,
    title: login?.label ?? (usage as UsageAccount).label,
    status,
    statusTone,
    windows,
    note: windows.length ? null : signedOut ? text('usage.signin') : usage ? noteOf(usage.state) : text('usage.never'),
  };
}

/**
 * The page's sections, one per agent, in the Mac's order. The account list is the base when the Mac sent one (so a signed-out
 * login is listed, not missing); otherwise the usage read's own accounts are. `labels` are the Mac's names for its agents.
 */
export function usageSections(o: {
  accounts: AccountList | null;
  usage: UsageAccount[] | null;
  labels: ReadonlyMap<string, string>;
  now: number;
}): HarnessView[] {
  const { accounts, labels, now } = o;
  const reads = o.usage ?? [];
  const known = accounts?.accounts ?? [];
  const used = (harness: string, account: string) => reads.find((u) => u.harness === harness && u.account === account) ?? null;
  const order = [...new Set([...known, ...reads].map((a) => a.harness))];
  return order.map((harness) => {
    const logins = known.filter((a) => a.harness === harness);
    const rows = logins.length
      ? logins.map((l) => accountView(l, used(harness, l.account), now))
      : reads.filter((u) => u.harness === harness).map((u) => accountView(null, u, now));
    return {
      harness,
      title: labels.get(harness) ?? harnessChip(harness) ?? harness,
      autoSwitch: accounts?.harnesses.find((h) => h.harness === harness)?.autoSwitch ?? null,
      accounts: rows,
    };
  });
}
