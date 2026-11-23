// The one account view every account surface reads (Settings → Accounts & billing, a harness page's account card,
// the profile menu, the harness/model picker): each account's name, plan, state, status and usage, a harness's
// phase and what it says with no account, an ACP harness's "Managed by …" line and the MoPilot credit balance.
// Pure; the store-bound hooks are in useAccountView.ts. Surfaces render these fields and derive none of them.
import { mostLeft } from '../../shared/switch.mjs';
import { formatCredits } from '../lib/credits';
import { accountLimitText } from './accountMenuUsage';
import { COPY } from './copy';
import { accountName, MOPILOT_PLAN, type Account, type HarnessAccounts } from './accounts';
import { HARNESS_LABEL, type HarnessId, type HarnessStatus, type UsageWindow } from './types';

export type Tone = 'ok' | 'warn' | 'muted';

/**
 * Where an account stands, the same on every surface. `billed`: billed per use (an API key, MoPilot credits), so it
 * has no quota; `checking`: the login in use while its harness checks it again.
 */
export type AccountState = 'signed-in' | 'limited' | 'lapsed' | 'unverified' | 'checking' | 'billed';

/** Where a harness stands: `not-started` is one left idle on purpose until first use (D-66). */
export type HarnessPhase = 'ready' | 'checking' | 'not-started' | 'signed-out' | 'missing' | 'error';

export interface AccountRowView {
  /** "claude:<id>": the row's data-account on every surface */
  key: string;
  /** the account itself, for the actions (use, sign in again, verify, remove); never for what is shown */
  account: Account;
  name: string;
  /** null when there is none or it repeats the name ("API key") */
  plan: string | null;
  state: AccountState;
  /** the full line: "62% left (weekly)", "Limit reached · resets in 2h", "Checking…", "Sign-in expired" */
  status: { text: string; tone: Tone };
  /** the narrow form, for a shortcut slot or a picker row: "62% left", "Limit reached"; null when there is none */
  short: string | null;
  /** usage meters; none for a lapsed login or one billed per use */
  windows: readonly UsageWindow[];
  active: boolean;
  /** what the row's main button does: use it for new chats, sign it in again, or confirm which account it is */
  action: 'use' | 'relogin' | 'verify' | null;
  /** what it is when it is a CLI's own login ("Codex CLI login") */
  cli: string | null;
  /** chats it serves */
  chats: number;
  /** why it is in this state and what its action does, when that needs saying (a login whose folder moved) */
  note: string | null;
}

export interface HarnessAccountView {
  harness: HarnessId;
  label: string;
  phase: HarnessPhase;
  /** the harness's state in a word, for its page header and the picker's badge */
  phaseLabel: { text: string; tone: '' | 'ok' | 'warn' | 'err' };
  /** what every surface says while there is no account in use; null when there is one */
  empty: { title: string; hint: string | null } | null;
  active: AccountRowView | null;
  /** the switcher's list: every login, without the MoPilot-credits key (that is billing, not an account) */
  accounts: AccountRowView[];
  /** every account, MoPilot credits included */
  all: AccountRowView[];
  /** the harness's own error, first line */
  error: string | null;
  /** the error is a refused credential (a key, credits): the CLI itself runs */
  rejected: boolean;
  /** it runs on an API key: no plan usage to read */
  apiKey: boolean;
  /** the harness keeps several accounts side by side */
  multi: boolean;
  /** logins shown as the same server account's row: folded id -> the listed account's id (#1312) */
  same: Record<string, string>;
}

/** What a harness left idle on purpose says: it starts when used, nothing is being checked. */
export const IDLE_HINT = 'Nothing runs until your first chat with it';

const PHASE_LABEL: Record<HarnessPhase, HarnessAccountView['phaseLabel']> = {
  ready: { text: 'Ready', tone: 'ok' },
  checking: { text: 'Checking…', tone: '' },
  'not-started': { text: 'Starts on first use', tone: '' },
  'signed-out': { text: 'Signed out', tone: 'warn' },
  missing: { text: 'Not installed', tone: 'err' },
  error: { text: 'Error', tone: 'err' },
};

const EMPTY_TITLE: Record<HarnessPhase, string> = {
  ready: 'No account yet',
  checking: 'Checking…',
  'not-started': 'Starts on first use',
  'signed-out': 'Not signed in',
  missing: 'Not installed',
  error: 'No account yet',
};

/** A harness's phase from its status. */
export function harnessPhase(st: Pick<HarnessStatus, 'state' | 'idle'>): HarnessPhase {
  if (st.idle) return 'not-started';
  switch (st.state) {
    case 'detecting':
      return 'checking';
    case 'signin':
      return 'signed-out';
    case 'missing':
    case 'error':
      return st.state;
    default:
      return 'ready';
  }
}

/** A harness's state in a word, with the tone of its dot: "Ready", "Checking…", "Not started". */
export const phaseLabelOf = (st: Pick<HarnessStatus, 'state' | 'idle'>) => {
  const p = harnessPhase(st);
  // an API key runs without a login: the header says so rather than "Ready"
  return st.state === 'apikey' && p === 'ready' ? { text: 'API key', tone: '' as const } : PHASE_LABEL[p];
};

const CLI_LABEL: Record<HarnessId, string> = { codex: 'Codex login on this computer', claude: 'Claude Code login on this computer' };

/** Per account: the chats it serves and whether it is its CLI's own login. */
export type AccountMeta = Record<string, { chats?: number; cli?: boolean }>;

function rowView(a: Account, active: boolean, phase: HarnessPhase, meta: AccountMeta): AccountRowView {
  const name = accountName(a);
  const credits = a.plan === MOPILOT_PLAN;
  const state: AccountState =
    a.status !== 'ok'
      ? 'lapsed'
      : active && phase === 'checking'
        ? 'checking'
        : a.unverified || a.addedAs
          ? 'unverified'
          : a.limited
            ? 'limited'
            : a.kind === 'apiKey' || credits
              ? 'billed'
              : 'signed-in';
  const status = state === 'checking' ? { text: 'Checking…', tone: 'muted' as const } : accountLimitText(a);
  const short =
    state === 'signed-in'
      ? a.left == null
        ? null
        : `${a.left}% left`
      : state === 'limited'
        ? 'Limit reached'
        : state === 'checking' || (state === 'billed' && credits)
          ? status.text
          : null;
  const m = meta[a.id] ?? {};
  return {
    key: `${a.harness}:${a.id}`,
    account: a,
    name,
    plan: a.plan && a.plan !== name ? a.plan : null,
    state,
    status,
    short,
    // a key's usage is empty already (accounts.ts); a Console login that reads /usage keeps its own windows
    windows: a.status === 'ok' && !credits ? a.usage.windows : [],
    active,
    action: a.status !== 'ok' ? 'relogin' : a.unverified || a.addedAs ? 'verify' : active ? null : 'use',
    // an unverified login's email may be another account's, so it is not called the CLI's login by that email
    cli: m.cli && !a.unverified ? CLI_LABEL[a.harness] : null,
    chats: m.chats ?? 0,
    note: a.reconfirm ? COPY.accounts.reconfirmWhy : a.addedAs ? COPY.accounts.otherAccountWhy.replaceAll('{addedAs}', a.addedAs) : null,
  };
}

/**
 * A login left out as the same server account as a listed one (#1312) is that account here: its chats count on the
 * listed row, and the row says it is the CLI's login too when the folded one is.
 */
function foldMeta(meta: AccountMeta, same: Record<string, string>): AccountMeta {
  const out = { ...meta };
  for (const [from, to] of Object.entries(same)) {
    const a = out[to] ?? {};
    const b = meta[from] ?? {};
    out[to] = { chats: (a.chats ?? 0) + (b.chats ?? 0), cli: !!(a.cli || b.cli) };
  }
  return out;
}

/** The view of one first-class harness's accounts, from its status and accounts. */
export function harnessAccountView(st: HarnessStatus, view: HarnessAccounts, rawMeta: AccountMeta = {}): HarnessAccountView {
  const phase = harnessPhase(st);
  const same = view.same ?? {};
  const meta = foldMeta(rawMeta, same);
  const all = view.accounts.map((a) => rowView(a, a.id === view.active?.id, phase, meta));
  // the account in use counts even when the list leaves it out
  const active = all.find((r) => r.active) ?? (view.active ? rowView(view.active, true, phase, meta) : null);
  return {
    harness: view.harness,
    label: HARNESS_LABEL[view.harness],
    phase,
    phaseLabel: phaseLabelOf(st),
    empty: active ? null : { title: EMPTY_TITLE[phase], hint: phase === 'not-started' ? IDLE_HINT : null },
    active,
    accounts: all.filter((r) => r.account.plan !== MOPILOT_PLAN),
    all,
    error: st.error ? st.error.split('\n')[0].slice(0, 140) : null,
    rejected: !!st.rejected,
    apiKey: st.state === 'apikey',
    multi: view.multi,
    same,
  };
}

/** The account a chat is served by in the view (a login folded into another is that one's row), else the one new chats use. */
export const servingRow = (v: HarnessAccountView, id: string | null | undefined) =>
  (id && v.all.find((r) => r.account.id === (v.same[id] ?? id))) || v.active;

/**
 * The row a chat's next turn runs on, as main's preflight picks it (electron/identity/contract/switch.cjs
 * claudeLoginFor): with automatic switching on, an unpinned chat whose login is out of usage starts on the usable login
 * of the same kind with the most left (an unread one counts as full, the one in use first among equals). A pinned
 * chat, automatic switching off or no usable stand-in keeps `row`.
 */
export function standInRow(v: HarnessAccountView, row: AccountRowView | null, autoSwitch: boolean, pinned: boolean) {
  if (!row || row.state !== 'limited' || !autoSwitch || pinned) return row;
  const lane = v.accounts.filter((r) => r.state === 'signed-in' && r.account.kind === row.account.kind);
  const best = mostLeft(
    lane.map((r) => r.account),
    v.active?.account.id,
    (a) => a.left ?? 100,
  )[0];
  return lane.find((r) => r.account === best) ?? row;
}

/* ------------------------------------------------------------------ */
/* basic (ACP) harnesses and MoPilot credits                           */
/* ------------------------------------------------------------------ */

export type BasicState = 'admitted' | 'signin' | 'checking' | 'unsupported' | 'off' | 'missing';

/** A basic harness's state in a word, with the tone of its dot. */
const BASIC_STATE: Record<BasicState, { text: string; tone: '' | 'ok' | 'warn' | 'err' }> = {
  admitted: { text: 'Ready', tone: 'ok' },
  // true whether it never signed in or its sign-in lapsed (#2034)
  signin: { text: 'Not signed in', tone: 'warn' },
  checking: { text: 'Checking…', tone: '' },
  unsupported: { text: 'Not supported', tone: 'err' },
  off: { text: 'Turned off', tone: 'warn' },
  missing: { text: 'Not installed', tone: '' },
};

export interface BasicAccountView {
  id: string;
  label: string;
  /** its state in a word, for its row's dot */
  state: { text: string; tone: '' | 'ok' | 'warn' | 'err' };
  /** "Managed by Kimi Code": it signs in and bills on its own */
  managedBy: string;
  /** its account on its own page: who manages it, and that MoPilot can't see its usage */
  managedNote: string;
  /** "Managed by Kimi Code · Ready" */
  line: string;
  tone: '' | 'warn';
  signedOut: boolean;
}

/** A basic (ACP) harness's account: it is the harness's own, so the view says who manages it and its state. */
export const basicAccountView = (b: { id: string; label: string; state: BasicState }): BasicAccountView => {
  const managedBy = `Managed by ${b.label}`;
  return {
    id: b.id,
    label: b.label,
    state: BASIC_STATE[b.state],
    managedBy,
    managedNote: `${managedBy}: it signs in and bills on its own. MoPilot can't see its usage.`,
    line: `${managedBy} · ${BASIC_STATE[b.state].text}`,
    tone: b.state === 'admitted' ? '' : 'warn',
    signedOut: b.state === 'signin',
  };
};

export interface CreditsView {
  signedIn: boolean;
  signingIn: boolean;
  email: string | null;
  /** "$12.34", "—" while not known */
  balance: string;
  /** "MoPilot credits · $12.34 left · a@x.com": a harness's billing line when it pays with them */
  line: string;
  /** what it says while no MoPilot account is signed in, as a harness says with no account; null when one is */
  empty: string | null;
}

/** The MoPilot account's credits, as every surface shows them. */
export const creditsView = (mp: {
  signedIn: boolean;
  signingIn?: boolean;
  user: { email?: string | null } | null;
  balanceMicros: number | null;
}): CreditsView => {
  const balance = formatCredits(mp.balanceMicros);
  const email = mp.user?.email ?? null;
  return {
    signedIn: mp.signedIn,
    signingIn: !!mp.signingIn,
    email,
    balance,
    line: [MOPILOT_PLAN, `${balance} left`, email].filter(Boolean).join(' · '),
    empty: mp.signedIn ? null : EMPTY_TITLE['signed-out'],
  };
};
