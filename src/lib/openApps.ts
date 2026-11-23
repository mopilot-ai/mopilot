// The apps Open in can send a file or folder to, by name, and which of them to offer.
import type { OpenApp } from '../../shared/model/store';

export type { OpenApp };

export const OPEN_APPS = [
  { value: 'finder', label: 'Finder' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'zed', label: 'Zed' },
  { value: 'xcode', label: 'Xcode' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'iterm', label: 'iTerm2' },
] as const satisfies readonly { value: OpenApp; label: string }[];

/** The app's name as the menus show it; an id this list doesn't know shows as itself. */
export function openAppLabel(id: string): string {
  return OPEN_APPS.find((o) => o.value === id)?.label ?? id;
}

/** The apps to offer: the installed ones plus `keep` (the current choice), or every app while the list is unknown. */
export function availableOpenApps(installed: Record<string, boolean> | null, keep: string): (typeof OPEN_APPS)[number][] {
  return OPEN_APPS.filter((o) => !installed || installed[o.value] || o.value === keep);
}
