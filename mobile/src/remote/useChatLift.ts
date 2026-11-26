// The last row travels with the keyboard frame by frame (#5686): the keyboard's own height, read on the UI thread, moves the offset of a reader at the end in the same frame the app's frame lifts (`KeyboardLift` in ui.tsx).
import { type ComponentRef, type MutableRefObject, useCallback, useMemo, useRef } from 'react';
import { Platform, type ScrollView } from 'react-native';
import {
  scrollTo,
  useAnimatedKeyboard,
  useAnimatedReaction,
  useAnimatedRef,
  useDerivedValue,
  useFrameCallback,
  type SharedValue,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFrameLift } from './frameLift';
import { type LiftInput, NO_INPUT, NO_MOTION, lifted, stepLift } from './keyboardLift';

/** A flag the chat's hook keeps (following, pinned, a finger down) that the UI thread reads: read and set like a ref, and every change is told to it. */
type Flag = { current: boolean };
type Geometry = { y: number; content: number; view: number };
export type Lift = {
  /** The list's ref: the one the UI thread scrolls by on iOS, a plain ref elsewhere. */
  ref: MutableRefObject<ComponentRef<typeof ScrollView> | null>;
  /** How far the keyboard has lifted the app's frame, in points (a shared value: read on the JS thread only when nothing is moving). */
  lift: SharedValue<number>;
  following: Flag;
  pinned: Flag;
  touching: Flag;
  /** Where the view stands and how big it and its content are, as the chat last measured them. */
  publish: (geometry: Geometry) => void;
};

/** iOS: the lift is driven from the keyboard's height on the UI thread. */
export function useIosLift(): Lift {
  const animated = useAnimatedRef<ComponentRef<typeof ScrollView>>();
  const keyboard = useAnimatedKeyboard();
  const { bottom } = useSafeAreaInsets();
  const input = useSharedValue<LiftInput>(NO_INPUT);
  const motion = useSharedValue(NO_MOTION);
  const lift = useMemo(() => {
    let heard = NO_INPUT;
    const tell = (patch: Partial<LiftInput>, heardOfView = false) => {
      const next = { ...heard, ...patch };
      if ((Object.keys(patch) as (keyof LiftInput)[]).every((k) => next[k] === heard[k])) return;
      // each report of where the view stands is counted, so the UI thread knows whether it has heard one since its last frame moved the view
      heard = heardOfView ? { ...next, seq: heard.seq + 1 } : next;
      input.value = heard;
    };
    const flag = (key: 'following' | 'pinned' | 'touching'): Flag => ({
      get current() {
        return heard[key];
      },
      set current(value: boolean) {
        tell({ [key]: value });
      },
    });
    return { following: flag('following'), pinned: flag('pinned'), touching: flag('touching'), publish: (g: Geometry) => tell(g, true) };
  }, [input]);
  // the lift is the app frame's own number (the padding under the content is made of it): the scroll below answers the same value in the same flush of the UI thread. An
  // isolated screen (no frame around it) makes its own from the keyboard
  const own = useDerivedValue(() => lifted(keyboard.height.value, bottom));
  const shared = useFrameLift() ?? own;
  // one function for the life of the screen: Reanimated registers a new callback whenever the function it is given changes
  const step = useCallback(
    (p: number) => {
      'worklet';
      const moved = stepLift(motion.value, input.value, p, Date.now());
      if (moved.motion !== motion.value) motion.value = moved.motion;
      if (moved.to !== null) scrollTo(animated, 0, moved.to, false);
    },
    [motion, input, animated],
  );
  useAnimatedReaction(
    () => shared.value,
    (p) => step(p),
    [shared, step],
  );
  // a lift is over once the keyboard has been quiet: nothing changes then, so no reaction says so
  const quiet = useCallback(() => {
    'worklet';
    if (motion.value.active) step(shared.value);
  }, [motion, shared, step]);
  useFrameCallback(quiet);
  // an animated ref holds the component it was attached to as its `current`, like any ref
  return { ref: animated as unknown as Lift['ref'], lift: shared, ...lift };
}

/** Elsewhere (the keyboard moves the window itself, or the app's own frame does): nothing is driven from here. */
export function useNoLift(): Lift {
  const ref = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const flags = useRef({ following: { current: true }, pinned: { current: false }, touching: { current: false } }).current;
  const lift = useSharedValue(0);
  return { ref, lift, ...flags, publish: () => undefined };
}

/** The lift of this platform: the platform does not change while the app runs, so the hooks called are always the same ones. */
export function useChatLift(): Lift {
  // biome-ignore lint/correctness/useHookAtTopLevel: Platform.OS is constant for the life of the app
  return Platform.OS === 'ios' ? useIosLift() : useNoLift();
}
