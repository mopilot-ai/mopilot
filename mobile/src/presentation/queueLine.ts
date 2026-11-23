// The chat's one error line as the Mac's queue rows use it: a failed Retry, Cancel or Edit puts its words there, and the line goes when the next call of the list works or when the rows it was about change; never another control's line (a failed Stop, a model pick).
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Held } from './macQueue';

/** What the rows stand for: each one's id and why it waits, so a change of any of them reads as a change. */
export const standingOf = (held: Held[]) => held.map((h) => `${h.id}:${h.refused ?? ''}:${h.moved ? 1 : 0}:${h.waiting ?? ''}`).join('|');

/** Takes back `message` from the page's one error line, if it is still the one showing: a control takes back only its own line. */
export const lineDropper = (setError: Dispatch<SetStateAction<string | null>>) => (message: string) =>
  setError((now) => (now === message ? null : now));

/**
 * @param held the rows shown @param setError the page's one error line
 * @returns `fail`: puts a message on the line and remembers it as this list's; `settle`: takes this list's line back, if it is still the one showing
 */
export function useQueueLine(held: Held[], setError: Dispatch<SetStateAction<string | null>>) {
  const said = useRef<string | null>(null);
  const drop = lineDropper(setError);
  const fail = (message: string) => {
    said.current = message;
    setError(message);
  };
  const settle = () => {
    const message = said.current;
    said.current = null;
    if (message !== null) drop(message);
  };
  const standing = standingOf(held);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the rows' standing is the trigger
  useEffect(settle, [standing]);
  return { fail, settle };
}
