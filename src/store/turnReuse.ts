// Keeps the turn objects a chat already shows when a re-read returns the same turns, so every memoized turn view and its Markdown skip rendering.
import type { TurnState } from './types';

/** Structural equality for JSON-shaped values (what a turn read from the app-server holds). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * `read` is a turn as just read; `shown` the turn of the same id on screen. The shown object is kept when every field the read
 * carries is unchanged (`itemTimes` is only what this window saw, so the read never has it), else the read replaces it.
 */
export function reuseTurn(shown: TurnState | undefined, read: TurnState): TurnState {
  if (!shown) return read;
  const same = (Object.keys(read) as (keyof TurnState)[]).every((k) => k === 'itemTimes' || sameValue(shown[k], read[k]));
  return same ? shown : read;
}
