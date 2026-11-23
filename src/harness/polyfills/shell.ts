// Shell polyfill (by MoPilot): Claude Code has no `!cmd`, so in a Claude chat Sage runs it in its
// own pty and attaches the output to the conversation, marked as outside the harness sandbox.
import { copy } from '../copy';
import { isWin, shellScript } from '../../lib/platform';

/** `!cmd` at the start of a message; `!` alone, `!!` and "! x" are plain text. */
export function parseBang(text: string): { cmd: string } | null {
  const m = /^!(?![!\s])([\s\S]+)$/.exec(text.trim());
  return m ? { cmd: m[1].trim() } : null;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;

/** Terminal output as plain text: escape codes removed, CRLF folded, a bare carriage return drops the overwritten part. */
export function cleanOutput(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1))
    .join('\n')
    .replace(/\s+$/, '');
}

/** Keeps the tail (where errors and results are) when output is too long. */
export function clip(output: string, max = 100_000): { text: string; clipped: boolean } {
  if (output.length <= max) return { text: output, clipped: false };
  return { text: output.slice(output.length - max), clipped: true };
}

export interface ShellResult {
  cmd: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  timedOut?: boolean;
}

/** The text block attached to the conversation. */
export function shellAttachment(r: ShellResult): { name: string; text: string } {
  const { text, clipped } = clip(cleanOutput(r.output));
  const status = r.timedOut ? 'timed out' : r.exitCode === 0 ? 'exit 0' : `exit ${r.exitCode ?? 'unknown'}`;
  const lines = [
    `$ ${r.cmd}`,
    `(${copy('misc', 'shellPolyfillNote')} · ${r.cwd} · ${status})`,
    '',
    clipped ? `[output truncated, last ${text.length} characters]\n${text}` : text || '(no output)',
  ];
  return { name: 'shell-output.txt', text: lines.join('\n') };
}

/** The slice of the preload pty API this needs. */
export interface PtyApi {
  spawn(id: string, opts: { command: string[]; cwd?: string; cols?: number; rows?: number; selfAnswer?: boolean }): Promise<unknown>;
  kill(id: string): Promise<unknown>;
  onEvent(cb: (e: { id: string; type: 'data' | 'exit'; data?: string; exitCode?: number }) => void): () => void;
}

let seq = 0;

/**
 * The command line that runs `cmd` once: `sh -c` (or `shell -c`) on macOS and Linux, and on Windows, which has no /bin/sh,
 * PowerShell, the shell its terminal runs (src/lib/platform.ts shellScript). PowerShell `-Command` exits 1 whenever the
 * line's last native command fails, whatever its own code: a `git push` that exits 128 reports 1.
 */
export function oneShot(cmd: string, shell?: string, win = isWin): string[] {
  if (shell) return [shell, '-c', cmd];
  return win ? shellScript(cmd, true) : ['/bin/sh', '-c', cmd];
}

/** Runs `cmd` (oneShot, for this platform unless `win` says) in `cwd` in a Sage pty and resolves with its output once it exits (or the timeout kills it). */
export function runShell(
  pty: PtyApi,
  cmd: string,
  cwd: string,
  o: { timeoutMs?: number; shell?: string; win?: boolean } = {},
): Promise<ShellResult> {
  const id = `bang-${Date.now()}-${seq++}`;
  const timeoutMs = o.timeoutMs ?? 120_000;
  let output = '';
  return new Promise<ShellResult>((resolve, reject) => {
    let timedOut = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = pty.onEvent((e) => {
      if (e.id !== id) return;
      if (e.type === 'data') output += e.data ?? '';
      else finish(e.exitCode ?? null);
    });
    function finish(exitCode: number | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve({ cmd, cwd, output, exitCode, timedOut });
    }
    timer = setTimeout(() => {
      timedOut = true;
      void pty.kill(id);
      finish(null);
    }, timeoutMs);
    pty.spawn(id, { command: oneShot(cmd, o.shell, o.win ?? isWin), cwd, cols: 200, rows: 50, selfAnswer: true }).catch((err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      reject(err);
    });
  });
}
