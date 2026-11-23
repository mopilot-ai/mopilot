// A Codex copy that keeps quitting, in words: "Codex 0.163.0-alpha.10.2 from ChatGPT.app keeps quitting", and the
// sentence when MoPilot moved to another installed copy. The banner and a chat's failed read say the same.
import { abbreviateHome } from '../lib/paths';
import type { CodexCopy, CodexQuit } from '../../shared/model/native';
export type { CodexCopy, CodexQuit } from '../../shared/model/native';

/** Where a copy came from, as part of a sentence; null for plain "codex" left to PATH. */
function whereFrom(c: CodexCopy): string | null {
  if (c.via === 'app-bundle') return c.from ? `from ${c.from}` : 'bundled with an app';
  if (c.via === 'brew') return 'from Homebrew';
  if (c.via === 'npm' || c.via === 'bun' || c.via === 'pnpm') return `from ${c.via}`;
  if (c.via === 'self') return 'from its installer';
  return c.path.includes('/') || c.path.includes('\\') ? `at ${abbreviateHome(c.path)}` : null;
}

/** "Codex 0.163.0-alpha.10.2 from ChatGPT.app": the build and where it came from, as far as main knows them. */
export function codexCopyName(c: CodexCopy): string {
  return ['Codex', c.version, whereFrom(c)].filter(Boolean).join(' ');
}

/** Why Codex isn't connected, in a sentence that names the copy, and that it stays when it is the user's own pick. */
export function codexQuitText(q: CodexQuit): string {
  const keeps = `${codexCopyName(q.copy)} keeps quitting.`;
  return q.pinned ? `${keeps} It's the copy you picked, so MoPilot keeps using it.` : keeps;
}

/** The note when main moved from a copy that kept quitting to the next one installed. */
export const codexSwitchedText = (from: CodexCopy, to: CodexCopy) =>
  `${codexCopyName(from)} kept quitting, so MoPilot is using ${codexCopyName(to)} instead.`;

/** The crash output to copy: which binary ran, then what it said as it quit. */
export const codexCrashOutput = (q: CodexQuit | null, connError: string | null) =>
  [q ? `${codexCopyName(q.copy)} (${q.copy.path})` : null, connError].filter(Boolean).join('\n');
