// The bubble that rises from the composer's box to the top of the list when a message is sent (Claude for iOS turns the composer's own text into the bubble); it floats over the page for 0.45 s on an even curve and the real bubble is there under it when it lands. Nothing moves under Reduce Motion.
import { type ComponentRef, type RefObject, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { MessageBubble } from './MessageBubble';
import { dur, ease } from '../motion';
import { PIN_GAP } from '../remote/useFollowEnd';
import { measureTop, setRiding, watchLaunch } from '../sendOrigin';

/** The rise from the composer lasts as long as Claude's (0.35-0.5 s). */
export const RISE_MS = dur.slow;

/** `scroller` is the list the message is pinned at the top of, PIN_GAP under its top edge. */
export function RiseGhost({ scroller }: { scroller: RefObject<Parameters<typeof measureTop>[0]> }) {
  const reduce = useReducedMotion();
  const box = useRef<ComponentRef<typeof View>>(null);
  const [ride, setRide] = useState<{ text: string; top: number; key: number } | null>(null);
  const shift = useSharedValue(0);
  // read when a send lands, so a new render does not restart the listener
  const slide = useRef(shift);
  slide.current = shift;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const done = () => {
      setRide(null);
      setRiding(false);
    };
    const stop = watchLaunch(({ text, start }) => {
      if (timer.current) clearTimeout(timer.current);
      // the page's own place in the window, so the ghost's window positions become this view's
      void Promise.all([start, measureTop(scroller.current), measureTop(box.current)]).then(([from, to, origin]) => {
        if (reduce || from === null || to === null || origin === null) return done();
        // the bubble's own 6 pt top margin is part of its rest place
        const top = to + PIN_GAP - 6 - origin;
        slide.current.value = from - (to + PIN_GAP - 6);
        setRide({ text, top, key: Date.now() });
        slide.current.value = withTiming(0, { duration: RISE_MS, easing: Easing.bezier(...ease.rise) });
        timer.current = setTimeout(done, RISE_MS);
      });
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
      setRiding(false);
    };
  }, [scroller, reduce]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: shift.value }] }));
  return (
    <View ref={box} pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {ride && (
        <Animated.View key={ride.key} style={[{ position: 'absolute', top: ride.top, left: 16, right: 16 }, style]}>
          <MessageBubble id="rise" role="user" text={ride.text} />
        </Animated.View>
      )}
    </View>
  );
}
