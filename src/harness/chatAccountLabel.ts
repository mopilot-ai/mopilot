// How every surface names a chat's account (the composer picker's Automatic row, Status, SwitchChip, the
// side chat title): one wording for the pin and the account serving the chat (design/multi-account rule 1).
import { accountName, type Account } from './accounts';

/**
 * A chat's account on one harness. `id` is the account the chat is set to: the user's pin when `pinned`,
 * else the one it runs on. `serving` is the account its turns run on now; it differs from `id` only while
 * the pinned account can't serve the chat (signed out), and the chat goes back to the pin once it can.
 */
export interface ChatAccount {
  id: string;
  pinned: boolean;
  serving: string;
}

/** True when the chat is pinned to an account that isn't the one serving it right now. */
export const pinnedElsewhere = (a: ChatAccount | null): boolean => !!a && a.pinned && a.serving !== a.id;

/**
 * How every surface names a chat's account: the account, or "Pinned to B · now on A" while a pinned
 * account can't serve the chat. null: the chat has no account of its own.
 */
export function chatAccountLabel(a: ChatAccount | null, accounts: Account[]): string | null {
  if (!a) return null;
  const name = (id: string) => {
    const acct = accounts.find((x) => x.id === id);
    // its email, else its plan ("Max"), as Status always named it; an unverified login's email may be another account's
    return acct ? ((acct.unverified ? null : acct.email) ?? acct.plan ?? accountName(acct)) : id;
  };
  return pinnedElsewhere(a) ? `Pinned to ${name(a.id)} · now on ${name(a.serving)}` : name(a.serving);
}

/**
 * The account a harness switch puts the chat on, named: the one picked with the switch, else the chat's own
 * pin on that harness (main applies it, electron/session/switchAccount.cjs), else the harness's account in use.
 */
export function switchAccountLabel(
  picked: string | null | undefined,
  own: ChatAccount | null,
  view: { active: Account | null; accounts: Account[] },
  automatic = false,
): string | null {
  if (automatic) return 'Automatic';
  if (picked) return chatAccountLabel({ id: picked, pinned: true, serving: picked }, view.accounts);
  if (own?.pinned) return chatAccountLabel(own, view.accounts);
  return view.active ? chatAccountLabel({ id: view.active.id, pinned: false, serving: view.active.id }, [view.active]) : null;
}
