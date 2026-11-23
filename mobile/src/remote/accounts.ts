// The Mac's logins as a phone reads them (accounts.get) and the auto-switch setting it may change (accounts.autoSwitch): no screen, so any UI can draw them.
import { bad, capabilities, needs, rec, str, type Owned } from './client';

export type AccountStatus = 'ok' | 'expired' | 'signedOut';
export type LoginAccount = {
  harness: string;
  account: string;
  label: string;
  status: AccountStatus;
  billing: string;
  active: boolean;
  /** the login has hit a limit and waits for its reset */
  limited: boolean;
};
/** Whether chats may move between this harness's logins when one runs out. `pool`: 'spread' puts new chats on the login with most left. */
export type HarnessPolicy = { harness: string; autoSwitch: boolean; pool: string };
export type AccountList = { harnesses: HarnessPolicy[]; accounts: LoginAccount[] };
const STATUSES = ['ok', 'expired', 'signedOut'];

/** The logins an `accounts.get` reply holds; a malformed field fails the whole read rather than showing a login in the wrong state. */
export function parseAccounts(raw: unknown): AccountList {
  const r = rec(raw);
  if (r?.scope !== 'local' || !Array.isArray(r.harnesses) || !Array.isArray(r.accounts)) return bad('the accounts');
  const harnesses = r.harnesses.map((item) => {
    const h = rec(item);
    if (!h || !str(h.harness) || typeof h.autoSwitch !== 'boolean' || !str(h.pool)) return bad('an account policy');
    return { harness: h.harness as string, autoSwitch: h.autoSwitch, pool: h.pool as string };
  });
  const accounts = r.accounts.map((item) => {
    const a = rec(item);
    if (!a || !str(a.harness) || !str(a.account) || !str(a.label) || !STATUSES.includes(String(a.status)) || !str(a.billing))
      return bad('an account');
    return {
      harness: a.harness as string,
      account: a.account as string,
      label: a.label as string,
      status: a.status as AccountStatus,
      billing: a.billing as string,
      active: a.active === true,
      limited: a.limited === true,
    };
  });
  return { harnesses, accounts };
}

export async function loadAccounts(request: Owned): Promise<AccountList> {
  needs(await capabilities(request), 'accounts.get', 'see accounts');
  return parseAccounts(await request('accounts.get'));
}

/** Sets auto-switch for one harness; resolves to the setting the Mac now has. */
export async function setAutoSwitch(request: Owned, harness: string, on: boolean): Promise<boolean> {
  needs(await capabilities(request), 'accounts.autoSwitch', 'change auto-switch');
  const r = rec(await request('accounts.autoSwitch', { harness, on }));
  if (typeof r?.autoSwitch !== 'boolean') return bad('the auto-switch answer');
  return r.autoSwitch;
}
