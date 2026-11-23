// Loaded by register.ts for every unit test: a test that starts a real app fails at once instead of opening it on the
// developer's computer and leaving it running (AGENTS.md: real apps run only in release suites). A real app is a
// browser (Chrome, Chromium, Edge, Brave, Arc), any program inside a macOS .app bundle (the computer-use helper once it
// is built), an opener, which always opens something (macOS open, xdg-open and the other desktop openers, Windows
// start and explorer: an app, a URL in the default browser, a file in its app, a Finder window), or osascript, which
// can launch and raise any app. Shell command lines (exec, execSync, shell: true) are checked command by command.
// Tests inject a fake spawn instead.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const BROWSER_BIN =
  /(Google Chrome( (Beta|Dev|Canary))?|Chromium|Microsoft Edge|Brave Browser|Arc)\.app([/\\]|$)|(^|[/\\])(google-chrome[\w-]*|chromium(-browser)?|chrome\.exe|msedge(\.exe)?|brave(\.exe)?)$/i;

const APP_BUNDLE_BIN = /\.app[/\\]Contents[/\\]MacOS[/\\]/i;
const OPENER =
  /(^|[/\\])(open|xdg-open|gio|gnome-open|kde-open5?|wslview|sensible-browser|x-www-browser|osascript|explorer(\.exe)?|start)$/i;

/** Whether a command starts a real app: a browser, a program in a .app bundle, an opener or osascript. */
export function startsRealApp(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return BROWSER_BIN.test(command) || APP_BUNDLE_BIN.test(command) || OPENER.test(command);
}

const SHELL_BIN = /(^|[/\\])(sh|bash|zsh|dash)$/;
// -c, or flags that end with it (bash -lc): the next argument is the script
const SCRIPT_FLAG = /^-[a-z]*c$/;

/**
 * Whether a shell command line starts a real app: the first word of each command in it (after `;`, `&`, `|`, a
 * newline or a parenthesis, past VAR=value assignments, `exec` and `cmd /c`), with its quotes taken off; the script
 * of a nested `sh -c` is read the same way.
 */
export function shellStartsRealApp(line: string): boolean {
  return line.split(/[;&|\n()]+/).some((part) => {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
    while (words.length > 1 && /^(\w+=.*|exec|cmd(\.exe)?|\/c)$/i.test(words[0])) words.shift();
    if (SHELL_BIN.test(words[0] ?? '') && SCRIPT_FLAG.test(words[1] ?? '')) return shellStartsRealApp(words.slice(2).join(' '));
    return startsRealApp(words[0]);
  });
}

const refusal = (command: unknown) =>
  new Error(
    `A unit test tried to start a real app (${String(command)}). Unit tests never launch real apps (AGENTS.md); inject a fake spawn instead.`,
  );

/**
 * Whether a launcher call starts a real app: its file, every command in its line when a shell reads it (exec,
 * execSync, shell: true), or the script it hands a shell itself (`sh -c <script>`).
 */
function refused(name: string, command: unknown, rest: unknown[]) {
  if (typeof command !== 'string') return false;
  if (startsRealApp(command)) return true;
  const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
  const options = rest.find((r) => !!r && typeof r === 'object' && !Array.isArray(r)) as { shell?: unknown } | undefined;
  if (name === 'exec' || name === 'execSync' || options?.shell) return shellStartsRealApp([command, ...args].join(' '));
  const script = args.findIndex((a) => SCRIPT_FLAG.test(a));
  return SHELL_BIN.test(command) && script >= 0 && shellStartsRealApp(args.slice(script + 1).join(' '));
}

/** Replaces the child_process launchers so a real app is refused; everything else runs as before. */
export function guardLaunchers(cp: Record<string, any> = childProcess as any) {
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const real = cp[name];
    if (real.guarded) continue;
    const guarded = function (this: unknown, command: unknown, ...rest: unknown[]) {
      if (refused(name, command, rest)) throw refusal(command);
      return real.call(this, command, ...rest);
    };
    guarded.guarded = true;
    // exec's and execFile's promisified forms ({ stdout, stderr }) are their own functions: keep them, behind the same check
    const custom = real[promisify.custom];
    if (custom) {
      (guarded as any)[promisify.custom] = (command: unknown, ...rest: unknown[]) =>
        refused(name, command, rest) ? Promise.reject(refusal(command)) : custom(command, ...rest);
    }
    cp[name] = guarded;
  }
}

guardLaunchers();
syncBuiltinESMExports();
