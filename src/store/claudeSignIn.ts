// Whether the built-in browser's shared profile is signed in to claude.ai, as main reports it (electron/capabilities/browser/claudeSite.cjs):
// the snapshot at start and each push after it, where the higher seq wins so a late snapshot never undoes a newer push.
import type { ClaudeSiteState } from '../lib/native';
import { native } from '../lib/native';
import { ignoring } from '../lib/ignored';
import { set } from './core';

/** A well-formed answer from main, else null. */
export function claudeSiteOf(raw: unknown): ClaudeSiteState | null {
  const r = (raw ?? {}) as { signedIn?: unknown; seq?: unknown };
  if ((r.signedIn !== null && typeof r.signedIn !== 'boolean') || typeof r.seq !== 'number' || !Number.isFinite(r.seq)) return null;
  return { signedIn: r.signedIn, seq: r.seq };
}

/** Takes an answer from main when it is newer than the one the store holds. */
export function takeClaudeSite(raw: unknown) {
  const next = claudeSiteOf(raw);
  if (next) set((s) => (next.seq > s.claudeSite.seq ? { claudeSite: next } : s));
}

/** Follows main's answer: the pushes from now on, and the snapshot, whichever is newer. */
export function startClaudeSignIn() {
  const b = native.browser;
  b.onClaudeSignIn(takeClaudeSite);
  // the pushes keep it current without the snapshot
  b.claudeSignIn().then(takeClaudeSite, ignoring("read the browser's claude.ai sign-in"));
}
