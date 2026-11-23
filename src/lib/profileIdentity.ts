// The rail's profile label and initials: the MoPilot account, or the OS user when signed out.
import type { MoPilotStatus } from './native';

/** The rail identifies the MoPilot user; harness logins remain in their own account menus. */
export function profileIdentity(mp: Pick<MoPilotStatus, 'signedIn' | 'user'>, systemUser: string | null | undefined) {
  const label = (mp.signedIn ? mp.user?.name?.trim() || mp.user?.email?.trim() || 'MoPilot' : systemUser?.trim()) || 'N/A';
  const words = label.split('@')[0].split(/\s+/);
  const initials =
    label === 'N/A' ? label : (words.length > 1 ? words[0][0] + words.at(-1)![0] : [...words[0]].slice(0, 2).join('')).toUpperCase();
  return { label, initials, colorKey: label === 'N/A' ? null : label };
}
