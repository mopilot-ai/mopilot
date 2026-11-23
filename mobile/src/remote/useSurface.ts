// Where a chat is working right now, for its header's "Working in <site or app>": read from the Mac while a turn runs and again as each step lands.
import { useEffect, useState } from 'react';
import type { Owned } from './client';

const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A page's host ("example.com"), or what it was given as when that is not a URL. */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

/** The line for a surface the Mac named (surface.current), or null before the chat's first browser or desktop step. */
export function surfaceLine(raw: unknown): string | null {
  const s = rec(raw);
  const origin = text(s?.origin);
  const where = s?.kind === 'desktop' ? text(rec(s.app)?.name) : ((origin ? hostOf(origin) : null) ?? text(s?.title));
  return where ? `Working in ${where}` : null;
}

/**
 * The header line while the turn runs; null otherwise, and on a Mac that has no surface.current (it is a line, not an action: a
 * read that fails leaves the header as it was). `steps` changes as the agent moves on, which reads it again; an answer that
 * arrives after the turn ended, the chat changed or a newer read began is dropped.
 */
export function useSurface(request: Owned, chatId: string, running: boolean, steps: number): string | null {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    void steps; // each new step may have moved the work
    if (!running) return setLine(null);
    let current = true;
    request('surface.current', { chatId })
      .then((raw) => current && setLine(surfaceLine(raw)))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [request, chatId, running, steps]);
  return running ? line : null;
}
