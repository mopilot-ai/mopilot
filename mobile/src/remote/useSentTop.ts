// A sent message's place under the nav bar (#5686): the sent bubble reports where it really sits in the content, which beats the height measured before it landed, and the message is scrolled back whenever that place moves.
import { type MutableRefObject, useEffect } from 'react';
import { watchSentTop } from '../sendOrigin';

/** Where a pinned message sits below the top of the view: it rests this far under the nav bar. */
export const PIN_GAP = 8;
/** A later report of the bubble's place that differs from the pinned one by more than this is the content above it growing (a tall reply), not the bubble moving: the pin stays. */
export const REPIN_SLACK = 160;

type Ref<T> = MutableRefObject<T>;
export function useSentTop(o: {
  pinLive: () => boolean;
  released: Ref<boolean>;
  anchored: Ref<boolean>;
  target: Ref<number>;
  pending: Ref<number | null>;
  scrollPending: Ref<boolean>;
  room: (value: number | undefined) => void;
  roomView: () => number;
  /** Runs the growth step again, which scrolls to the place once the room under it is part of the content. */
  again: Ref<() => void>;
}) {
  const { pinLive, released, anchored, target, pending, scrollPending, room, roomView, again } = o;
  useEffect(
    () =>
      watchSentTop((y, refine) => {
        if (!pinLive() || released.current || (refine && !anchored.current)) return;
        const next = Math.max(0, y - PIN_GAP);
        // the outbox bubble is drawn after the rows: a reply that grows above it pushes it down, and the message is not dragged after it. Rows that go away above it
        // (older pages dropped by a read again) move it up by any amount, and the room kept under it must follow, or the view is left past the rows that are left
        if (anchored.current && next - target.current > REPIN_SLACK) return;
        anchored.current = true;
        if (!scrollPending.current && next === target.current && pending.current === null) return;
        target.current = next;
        pending.current = null;
        scrollPending.current = true;
        room(next + roomView());
        again.current();
      }),
    [pinLive, room, roomView, released, anchored, target, pending, scrollPending, again],
  );
}
