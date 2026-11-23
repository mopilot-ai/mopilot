// How far a page shown as a native sheet must lift its bottom bar above the keyboard, since the app frame's keyboard avoidance does not reach into a sheet: the keyboard's top against the screen's bottom, where a page sheet ends. It moves on the keyboard's own duration, on the UI thread: no state changes per frame.
import { useEffect } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { dur, ease } from './motion';

/** Pad needed so nothing sits under a keyboard whose top is `keyboardTop` on a screen `screenHeight` tall. */
export const liftFor = (screenHeight: number, keyboardTop: number) => Math.max(0, Math.round(screenHeight - keyboardTop));

/** Where the lift goes on a keyboard event: its length, else a sheet's. */
export const liftTiming = (event?: { duration?: number }) => ({
  duration: event?.duration || dur.sheet,
  easing: Easing.bezier(...ease.snap),
});

/**
 * The paddingBottom for a sheet's outer view, as a shared value a style reads on the UI thread. A page sheet's own
 * coordinates start at its top (measuring it gives 0, so the sheet's inset from the top of the screen would be lost); its
 * bottom is always the screen's, which is what counts. iOS only: Android resizes the window itself.
 */
export function useKeyboardLift(): SharedValue<number> {
  const lift = useSharedValue(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const change = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
      lift.value = withTiming(liftFor(Dimensions.get('screen').height, e.endCoordinates.screenY), liftTiming(e));
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      lift.value = withTiming(0, liftTiming(e));
    });
    return () => {
      change.remove();
      hide.remove();
    };
  }, [lift]);
  return lift;
}
