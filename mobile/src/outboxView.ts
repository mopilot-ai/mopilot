// The phone's outbox read where it is shown, not through the app root (#4986): every send publishes its progress (queued, sending, accepted, gone), and each publish drew the root, the home under the chat, the chat screen and its composer. The root now ignores a publish that changed only the outbox, and the screens that show the messages (the open chat, the home's Unsent messages) read it here.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { MobileRuntime, MobileSnapshot } from './contracts';
import type { QueuedSend } from './outbox';

const NONE: QueuedSend[] = [];

const sameList = (a?: readonly unknown[], b?: readonly unknown[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

/** Two copies of one queued message (a snapshot copies each time): the same fields with the same values. */
function sameItem(a: QueuedSend, b: QueuedSend): boolean {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((key) =>
    Array.isArray(x[key]) ? sameList(x[key] as unknown[], y[key] as unknown[] | undefined) : Object.is(x[key], y[key]),
  );
}

/** The messages of a snapshot (a runtime that holds none has no outbox to read). */
const outboxOf = (snapshot: MobileSnapshot): QueuedSend[] => snapshot.outbox ?? NONE;

/** The same messages in the same order and state. */
export const sameOutbox = (a: readonly QueuedSend[], b: readonly QueuedSend[]) =>
  a.length === b.length && a.every((item, i) => sameItem(item, b[i]));

/** The snapshot without its outbox: what the app root holds, since it draws nothing from the messages themselves. */
export const withoutOutbox = (snapshot: MobileSnapshot): MobileSnapshot => ({ ...snapshot, outbox: NONE });

/** Whether a publish changed the outbox and nothing else (a snapshot is copied whole each time, so its fields are compared by what they say); a publish that changed nothing is not one. */
export function onlyOutboxChanged(before: MobileSnapshot, after: MobileSnapshot): boolean {
  if (sameOutbox(outboxOf(before), outboxOf(after))) return false;
  const { outbox: _b, ...a } = before;
  const { outbox: _a, ...b } = after;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Tells `onChange` of each publish except the ones that changed only the outbox (a send's progress, which the chat and the home's Unsent messages read themselves); it gets the snapshot without its outbox. */
export function watchSnapshots(runtime: MobileRuntime, onChange: (next: MobileSnapshot) => void): () => void {
  let held = runtime.snapshot();
  return runtime.subscribe(() => {
    const next = runtime.snapshot();
    const outboxOnly = onlyOutboxChanged(held, next);
    held = next;
    if (!outboxOnly) onChange(withoutOutbox(next));
  });
}

/** The messages the phone holds for the computer, the same array until one changes. */
export function useOutbox(runtime: MobileRuntime): QueuedSend[] {
  const last = useRef<QueuedSend[]>(NONE);
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const read = useCallback(() => {
    const next = outboxOf(runtime.snapshot());
    if (!sameOutbox(last.current, next)) last.current = next;
    return last.current;
  }, [runtime]);
  return useSyncExternalStore(subscribe, read, read);
}
