// Importing from another browser, the renderer's side: how a failure reads, which sources can be used, and when the pane's first-run offer comes back after "Not now" (1, 3, then 7 days).
import type { ImportKind, ImportSource } from './native';
import { staleGrantHint } from '../../shared/staleGrant.mjs';

export const IMPORT_EVENT = 'open-browser-import';
/** Days before the offer returns after the first, second and later "Not now". */
export const SNOOZE_DAYS = [1, 3, 7];
const DAY = 86_400_000;

/** Opens the import dialog (rendered once, in the app shell). */
export function openImportDialog(source?: string) {
  window.dispatchEvent(new CustomEvent(IMPORT_EVENT, { detail: source ?? null }));
}

/**
 * A sentence for an import failure: what happened and what to do.
 * @param file the category came from a file the user chose (Safari's passwords export), not the browser's profile
 */
export function importErrorText(code: string, browser: string, kind?: ImportKind, file = false): string {
  const what = kind ? kind.toLowerCase() : 'data';
  if (file && code === 'missing') return "Couldn't find the chosen passwords file. Choose it again.";
  if (file && code === 'access_blocked')
    return 'Your Mac blocked access to the chosen passwords file. Move it to your Downloads folder and choose it again.';
  if (file && code === 'too_large') return 'The chosen file is too large to be a passwords export.';
  switch (code) {
    case 'keychain_denied':
      return `Your Mac didn't let MoPilot read ${browser}'s sign-in key. Try again and choose Allow.`;
    case 'access_blocked':
      return `Your Mac blocked access to ${browser}'s ${what}. Give MoPilot Full Disk Access in System Settings, then try again. ${staleGrantHint('MoPilot', 'Full Disk Access')}`;
    case 'missing':
      return `Couldn't find ${browser}'s ${what}. Open ${browser} once, then try again.`;
    case 'too_large':
      return `${browser}'s ${what} file is too large to import.`;
    case 'busy':
      return 'Another import is still running. Wait for it to finish.';
    case 'cancelled':
      return 'The import was cancelled.';
    case 'storage_unavailable':
      return "This Mac can't encrypt saved passwords for MoPilot right now, so none were saved.";
    case 'no_file':
      return `Choose the passwords file ${browser} exported, then try again.`;
    case 'unsupported':
      return kind === 'passwords'
        ? `That file isn't a passwords export. In ${browser}, choose File → Export → Passwords…, then choose the file it saves.`
        : `${browser} can't be imported from on this Mac.`;
    default:
      return `Couldn't read ${browser}'s ${what}. Quit ${browser} and try again.`;
  }
}

/** The sources worth showing in the first-run offer: those that can be read now, or could with Full Disk Access. */
export function offerSources(sources: ImportSource[]): ImportSource[] {
  return sources.filter((s) => s.status === 'ready' || s.status === 'needs_full_disk_access');
}

/** Whether the first-run offer may show now: still asking, and not snoozed. */
export function offerDue(prefs: { browserImportPrompt: string; browserImportSnoozeUntil: number }, now: number): boolean {
  return prefs.browserImportPrompt === 'pending' && now >= prefs.browserImportSnoozeUntil;
}

/** The prefs after "Not now": the snooze count and the time the offer may return. */
export function snoozed(snoozes: number, now: number): { browserImportSnoozes: number; browserImportSnoozeUntil: number } {
  const n = snoozes + 1;
  return { browserImportSnoozes: n, browserImportSnoozeUntil: now + SNOOZE_DAYS[Math.min(n, SNOOZE_DAYS.length) - 1] * DAY };
}
