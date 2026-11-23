// Android's back button and gesture do what the screen's visible "‹ Back" control does; without it they close the app from any screen.
import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

/** While the calling screen is mounted (and `active`), hardware back runs `back` instead of leaving the app; iOS has no such control. A sheet that stays mounted while closed passes whether it is open. */
export function useHardwareBack(back: () => void, active = true) {
  // the latest callback, so a screen that rebuilds `back` on every render keeps one subscription (and its place in the stack)
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (Platform.OS !== 'android' || !active) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      latest.current();
      return true;
    });
    return () => subscription.remove();
  }, [active]);
}
