// The one place computer-use UI turns an app an agent named (a bundle id or a name) into what a person reads: the installed app's display name and icon from main (cached), a short table of common apps meanwhile, and "App" rather than a raw bundle id.
import { useSyncExternalStore } from 'react';
import { installedNative } from './native';

export interface AppIdentity {
  name: string;
  icon: string | null;
}

const BUNDLE_ID = /^[A-Za-z][\w-]*(\.[\w-]+)+$/;

/** Common apps by bundle id, shown before main answers (and when it can't). */
const KNOWN: Record<string, string> = {
  'com.apple.finder': 'Finder',
  'com.apple.systempreferences': 'System Settings',
  'com.apple.mail': 'Mail',
  'com.apple.mobilesms': 'Messages',
  'com.apple.ical': 'Calendar',
  'com.apple.reminders': 'Reminders',
  'com.apple.addressbook': 'Contacts',
  'com.apple.calculator': 'Calculator',
  'com.apple.notes': 'Notes',
  'com.apple.textedit': 'TextEdit',
  'com.apple.safari': 'Safari',
  'com.apple.terminal': 'Terminal',
  'com.apple.preview': 'Preview',
  'com.google.chrome': 'Google Chrome',
  'com.microsoft.vscode': 'VS Code',
  'com.tinyspeck.slackmacgap': 'Slack',
};

/** lower-cased query -> what main answered (null: no installed app matches) */
const resolved = new Map<string, AppIdentity | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** Asks main once per app; the answer re-renders every subscriber. */
export function requestApp(app: string): void {
  const key = app.trim().toLowerCase();
  if (!key || asked.has(key)) return;
  asked.add(key);
  // read at call time: narration also runs where there is no window (tests, tooling)
  const ask = installedNative()?.computer?.appIdentity;
  if (!ask) return;
  ask(app.trim()).then(
    (r) => {
      resolved.set(key, typeof r?.name === 'string' && r.name ? { name: r.name, icon: typeof r.icon === 'string' ? r.icon : null } : null);
      changed();
    },
    () => {
      /* no answer: the fallback name stays */
    },
  );
}

/**
 * What a person reads for `app`: main's display name once known, a common app's name, a name as the
 * agent gave it ("Notes.app" → "Notes"), and "App" for a bundle id nothing names. Asks main as a side effect.
 */
export function appLabel(app: string): string {
  const q = app.trim();
  const key = q.toLowerCase();
  requestApp(q);
  const r = resolved.get(key);
  if (r) return r.name;
  if (KNOWN[key]) return KNOWN[key];
  if (/\.app$/i.test(q)) return q.slice(0, -4);
  return BUNDLE_ID.test(q) ? 'App' : q;
}

/** The app's icon (a data: URL) once main has it. */
export function appIcon(app: string): string | null {
  return resolved.get(app.trim().toLowerCase())?.icon ?? null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Changes whenever main names another app: a memo over narration text depends on it. */
export function useAppNamesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** The app's display name and icon, re-rendering when main answers. */
export function useAppIdentity(app: string): AppIdentity {
  useAppNamesVersion();
  return { name: appLabel(app), icon: appIcon(app) };
}

/** Tests: forget every answer. */
export function resetAppNames(): void {
  resolved.clear();
  asked.clear();
  changed();
}
