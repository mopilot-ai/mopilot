// Codex's state in a word from the store's connection fields: the one rule codexStatus (select.ts) and the default
// harness's fallback reason (store/chats.ts) both read, so a note and the Harnesses page never disagree (#1872).
import { codexIncompatible } from './codexCompat';
import type { HarnessStatus } from './types';

export interface CodexConn {
  conn: 'idle' | 'connecting' | 'ready' | 'error';
  connError: string | null;
  requiresAuth: boolean;
  codexCompat: Parameters<typeof codexIncompatible>[0];
}

/**
 * The spawn's own failure for a binary that can't be found or run: ENOENT, EACCES, or EFTYPE (Windows' file that is no
 * program), as the spawn tells it ("spawn <path> ENOENT", "spawn EFTYPE"), not a word in what a process that ran printed
 * ("Codex app-server exited (1).\n… ENOENT …").
 */
const CANT_RUN = /^(?:spawn(?: .*)? )?(?:ENOENT|EACCES|EFTYPE)$/;

/** Detecting, missing (CANT_RUN), error (incl. an incompatible version) or signed out; else null. */
export function codexState(s: CodexConn): Extract<HarnessStatus['state'], 'detecting' | 'missing' | 'error' | 'signin'> | null {
  if (s.conn === 'connecting' || s.conn === 'idle') return 'detecting';
  // a binary that can't be found or run means Codex isn't installed, not that it broke
  if (s.conn === 'error' && CANT_RUN.test(s.connError ?? '')) return 'missing';
  if (s.conn === 'error' || codexIncompatible(s.codexCompat)) return 'error';
  return s.requiresAuth ? 'signin' : null;
}
