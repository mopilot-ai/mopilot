// Platform differences in the renderer: the primary shortcut modifier and how shortcuts are shown.
// Shortcut labels are written in macOS glyphs (⌘N, ⇧⌘A, ⌥Space); on Windows and Linux they read as
// Ctrl+N, Ctrl+Shift+A, Alt+Space, and Ctrl plays ⌘'s part.
import { installedNative } from './native';

/** The installed bridge's platform; macOS where there is none (tooling, a test without one). */
export const platform: string = installedNative()?.platform || 'darwin';
export const isMac = platform === 'darwin';
export const isWin = platform === 'win32';

/** What showing a file in the system's file manager is called there: Finder, Explorer, or a folder. */
export const revealLabel = (p = platform) => (p === 'darwin' ? 'Show in Finder' : p === 'win32' ? 'Show in Explorer' : 'Show in folder');

/** The primary modifier is held: ⌘ on macOS, Ctrl elsewhere. */
export function modKey(e: { metaKey: boolean; ctrlKey: boolean }, mac = isMac) {
  return mac ? e.metaKey : e.ctrlKey;
}

const GLYPHS: [string, string][] = [
  ['◆', 'Super'],
  ['⌃', 'Ctrl'],
  ['⌘', 'Ctrl'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift'],
];
/** A shortcut label in macOS glyphs, as this platform shows it ("⇧⌘A" → "Ctrl+Shift+A" off macOS). */
export function shortcutLabel(label: string, mac = isMac) {
  if (mac || !label) return label;
  const mods = new Set<string>();
  let i = 0;
  for (; i < label.length; i++) {
    const g = GLYPHS.find(([c]) => c === label[i]);
    if (!g) break;
    mods.add(g[1]);
  }
  const key = label.slice(i).trim();
  if (!mods.size) return label;
  const order = ['Ctrl', 'Alt', 'Shift', 'Super'].filter((m) => mods.has(m));
  return [...order, key].filter(Boolean).join('+');
}

/** The interactive shell a new terminal runs: a login zsh on macOS, Windows PowerShell on Windows and sh on Linux. */
export function defaultShell(win = isWin): string[] {
  return win ? ['powershell.exe', '-NoLogo'] : [platform === 'linux' ? '/bin/sh' : '/bin/zsh', '-l'];
}
export function defaultShellName(win = isWin) {
  return win ? 'powershell' : platform === 'linux' ? 'sh' : 'zsh';
}

/** Runs a one-line shell script: `zsh -lc` on macOS, PowerShell on Windows and sh on Linux. */
export function shellScript(script: string, win = isWin): string[] {
  return win
    ? ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script]
    : [platform === 'linux' ? '/bin/sh' : '/bin/zsh', '-lc', script];
}

/** A terminal tab's title: the folder's name, else the shell's. */
export function terminalTitle(cwd: string, win = isWin) {
  const name = /^[A-Za-z]:([\\/]|$)|^\\\\/.test(cwd)
    ? cwd
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop()
    : cwd.split('/').pop();
  return name || defaultShellName(win);
}
