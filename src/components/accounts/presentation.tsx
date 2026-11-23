// Account avatar colors and initials.

import { MOPILOT_PLAN } from '../../harness/accounts';
import { AVATAR_COLORS } from '../../lib/brandColors';

export const initialsOf = (email: string | null | undefined) =>
  email
    ? email
        .replace(/[^a-zA-Z]/g, '')
        .slice(0, 2)
        .toUpperCase()
    : 'API';

export function avatarColor(email: string | null) {
  let h = 0;
  for (const c of email ?? '') h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
export interface AvatarLabel {
  initials: string;
  color: string;
}

const avatarKey = (email: string | null) => (email ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Avatars for accounts listed together, so each one can be told apart: initials that differ when two emails
 * start alike (dax0@… and dax3@… become D0 and D3, not DA twice), and no color used twice while the palette lasts.
 * An account alone, or one whose email is unlike the others, keeps its usual initials and color.
 */
export function avatarLabels(emails: readonly (string | null)[]): AvatarLabel[] {
  const keys = emails.map(avatarKey);
  const taken = new Set<string>();
  return emails.map((email, i) => {
    const key = keys[i];
    const others = keys.filter((k, j) => j !== i && k);
    let initials = initialsOf(email);
    if (key && others.some((k) => initialsOf(k) === initials)) {
      // the shortest start of the email no other account shares; its last character tells this one apart
      let n = 1;
      while (n <= key.length && others.some((k) => k.startsWith(key.slice(0, n)))) n++;
      if (n > 1 && n <= key.length) initials = (key[0] + key[n - 1]).toUpperCase();
    }
    let at = AVATAR_COLORS.indexOf(avatarColor(email));
    for (let tries = 0; taken.has(AVATAR_COLORS[at]) && tries < AVATAR_COLORS.length; tries++) at = (at + 1) % AVATAR_COLORS.length;
    taken.add(AVATAR_COLORS[at]);
    return { initials, color: AVATAR_COLORS[at] };
  });
}

/** What an avatar is decided from. */
export type AvatarAccount = { email: string | null; unverified?: true; kind?: string; plan?: string | null };

/** Avatars for listed accounts: a login whose account is not confirmed shows a question mark, not someone's initials. */
export function accountAvatars(accounts: readonly AvatarAccount[]): AvatarLabel[] {
  const labels = avatarLabels(accounts.map((a) => (a.unverified ? null : a.email)));
  // "API" is for a key; a login whose email is not known yet is unknown, like an unverified one
  const unknown = (a: (typeof accounts)[number]) =>
    a.unverified || (!a.email && a.kind !== undefined && a.kind !== 'apiKey' && a.plan !== MOPILOT_PLAN);
  return labels.map((l, i) => (unknown(accounts[i]) ? { ...l, initials: '?' } : l));
}

/**
 * An account's avatar: `label` when it is listed with others (accountAvatars over the whole list), else as it reads
 * alone. Never initials from a bare email: an unverified login reads "?", only a key reads "API" (#1930).
 */
export function AccountAvatar({ account, size = 18, label }: { account: AvatarAccount; size?: number; label?: AvatarLabel }) {
  const own = label ?? accountAvatars([account])[0];
  return (
    <span className="profile-avatar" style={{ width: size, height: size, fontSize: size * 0.44, background: own.color }}>
      {own.initials}
    </span>
  );
}
