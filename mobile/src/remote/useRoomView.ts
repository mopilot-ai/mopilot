// The view a chat will have once the keyboard is down and the composer is back to one line (#5686): what the room under a sent message is made for, so nothing the keyboard or the composer gives back can make the content shorter than the view.
import { type MutableRefObject, useCallback, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { useComposerGrowth } from './frameLift';
import type { Slide } from './useSlide';

export function useRoomView(o: {
  size: MutableRefObject<{ view: number }>;
  slide: MutableRefObject<Slide>;
  layoutHeld: () => boolean;
  pinned: { current: boolean };
  /** The keyboard's lift of the app's frame. */
  lift: SharedValue<number>;
}) {
  const { size, slide, layoutHeld, pinned, lift } = o;
  const growth = useComposerGrowth();
  // the view as it is, plus what the keyboard and the composer can give back, as it stood when the message was sent (all measured together, before the send empties the composer)
  const atSend = useRef<number | null>(null);
  /** What the keyboard and the composer can still give back to the view: the frame's lift, the composer's height over its resting height and the Changes chip above it. */
  const giveBack = useCallback(() => lift.value + (growth?.extra ?? 0) + (growth?.chip ?? 0), [lift, growth]);
  return {
    giveBack,
    /**
     * The height the room under a sent message is made for: the view and what it can be given back now, and never less than what was measured at the send while that message
     * is pinned (a measure taken after the composer reported its collapse but before the view grew would be short). It is a floor, not a fixed value: the view can grow by
     * more than the keyboard and the composer give back (the Changes chip above the composer goes away on a send), and the room follows it. While a slide holds layouts, its
     * own measure from where it began stands in for the view's.
     */
    roomView: useCallback(() => {
      const sent = pinned.current && atSend.current !== null ? atSend.current : 0;
      const now = layoutHeld() ? slide.current.fullView : size.current.view + giveBack();
      return Math.max(now, sent);
    }, [layoutHeld, slide, pinned, size, giveBack]),
    /** A message is sent: the view, the keyboard and the composer are measured together now, before the send empties the composer. */
    sent: useCallback(() => {
      atSend.current = size.current.view + giveBack();
    }, [size, giveBack]),
  };
}
