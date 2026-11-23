// The mail account the person last sent a draft from, kept in this window's localStorage as a per-viewer convenience: with several accounts able to send, it is the default, so the person is not asked every time. Storage that fails reads as none and writes nothing.
import { noteIgnored } from '../../lib/ignored';

const KEY = 'momo.draftFrom';

/** The account id last sent from, or '' when none or storage is unavailable. */
export function lastFrom(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remembers `id` as the account last sent from. */
export function rememberFrom(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch (error) {
    noteIgnored('remember the mail account last sent from', error);
  }
}
