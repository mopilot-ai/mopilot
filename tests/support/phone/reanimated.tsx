// react-native-reanimated in the test DOM: animated views render as plain ones, with the animation they asked for kept as data.
import { useEffect, useRef } from 'react';
import { Text, View } from './native.tsx';

/** A layout-animation builder: each chained call is recorded, so a test can read the duration and curve asked for. */
const builder = (name: string) => {
  const b: any = { name, steps: [] as unknown[] };
  for (const method of ['duration', 'easing', 'springify', 'dampingRatio', 'delay', 'stiffness', 'damping', 'withInitialValues'])
    b[method] = (...args: unknown[]) => {
      b.steps.push([method, ...args]);
      return b;
    };
  return b;
};
export const FadeIn = builder('FadeIn');
export const FadeInDown = builder('FadeInDown');
export const FadeOut = builder('FadeOut');
export const LinearTransition = builder('LinearTransition');
export const SlideInDown = builder('SlideInDown');
/** Shared values hold their value; withTiming records the target and curve it was given and lands on the target at once. */
/** A test that sets `__phoneAnimatedHooks` to a number reads how many shared values and animated styles were made: what lives on the UI thread for a screen at rest. */
const countHook = () => {
  const g = globalThis as any;
  if (typeof g.__phoneAnimatedHooks === 'number') g.__phoneAnimatedHooks += 1;
};
export const useSharedValue = (initial: any) => {
  countHook();
  return useRef({ value: initial }).current;
};
export const withTiming = (to: unknown, config: unknown, done?: (finished: boolean) => void) => {
  const g = globalThis as any;
  g.__phoneTimings = [...(g.__phoneTimings ?? []), { to, config }];
  // a test can hold a timing open (`__phoneHoldTimings`) and finish it itself through `__phoneFinishTiming`
  if (g.__phoneHoldTimings) g.__phoneFinishTiming = done;
  else done?.(true);
  return to;
};
/** A call to the JS thread runs at once in a test. */
export const runOnJS = (fn: (...args: any[]) => unknown) => fn;
/** A spring lands on its target at once, like a timing; the config it was given (with any release velocity) is recorded beside the timings. */
export const withSpring = (to: unknown, config: unknown, done?: (finished: boolean) => void) => {
  const g = globalThis as any;
  g.__phoneTimings = [...(g.__phoneTimings ?? []), { to, config, spring: true }];
  if (g.__phoneHoldTimings) g.__phoneFinishTiming = done;
  else done?.(true);
  return to;
};
export const useAnimatedStyle = (fn: () => object) => {
  countHook();
  return fn();
};
/** The per-frame callback is kept for a test to call with a frame's length (`timeSincePreviousFrame`), as the UI thread would; `__phoneFrames` holds the callbacks of every mounted screen (each with the latest function it was given). */
export const useFrameCallback = (fn: (frame: { timeSincePreviousFrame: number | null; timestamp: number }) => void) => {
  const g = globalThis as any;
  g.__phoneFrame = fn;
  const slot = useRef({ fn }).current;
  slot.fn = fn;
  useEffect(() => {
    const all: Set<{ fn: typeof fn }> = (g.__phoneFrames ??= new Set());
    all.add(slot);
    return () => void all.delete(slot);
  }, [slot, g]);
};
/** A derived value is read live: it is what its function says now. */
export const useDerivedValue = (fn: () => unknown) => {
  const held = useRef<any>(null);
  held.current ??= {
    get value() {
      return held.current.fn();
    },
  };
  held.current.fn = fn;
  return held.current;
};
/** A reaction is kept for a test to run: it asks what changed (`prepare`) and answers a change with the value before it. `__phoneReactions` holds the reactions of every mounted screen. */
export const useAnimatedReaction = (prepare: () => unknown, react: (now: unknown, before: unknown) => void) => {
  const g = globalThis as any;
  const slot = useRef<any>({ before: null }).current;
  slot.prepare = prepare;
  slot.react = react;
  useEffect(() => {
    const all: Set<any> = (g.__phoneReactions ??= new Set());
    all.add(slot);
    return () => void all.delete(slot);
  }, [slot, g]);
};
/** The keyboard's height as the UI thread reads it: a test sets `__phoneKeyboardHeight`. The object is the same on every render, as the real one is. */
export const useAnimatedKeyboard = () =>
  useRef({
    height: {
      get value() {
        return (globalThis as any).__phoneKeyboardHeight ?? 0;
      },
    },
  }).current;
/** A ref a worklet scrolls by: it holds what it was attached to, like any ref. */
export const useAnimatedRef = () => {
  const held = useRef<any>(null);
  held.current ??= Object.assign(
    (node: unknown) => {
      held.current.current = node;
      return 1;
    },
    { current: null as unknown },
  );
  return held.current;
};
/** A scroll made from the UI thread is recorded: where it went. */
export const scrollTo = (_ref: unknown, x: number, y: number, animated: boolean) =>
  ((globalThis as any).__liftedTo ??= []).push({ x, y, animated });
/** Linear interpolation between two output values, enough for a progress that is 0 or 1. */
export const interpolate = (value: number, input: number[], output: number[]) =>
  output[0] + ((value - input[0]) / (input[1] - input[0])) * (output[1] - output[0]);
/** Colour interpolation: a test reads which end it landed on. */
export const interpolateColor = (value: number, input: number[], output: string[]) => (value <= input[0] ? output[0] : output[1]);
/** The system's Reduce Motion, as a test sets it. */
export const useReducedMotion = () => !!(globalThis as any).__phoneReduceMotion;
/** A CSS-transition curve, kept as data for a test to read. */
export const cubicBezier = (...points: number[]) => ({ cubicBezier: points });
export const Easing = { bezier: (...points: number[]) => ({ bezier: points }) };
/** Children mounted with the list do not run their entrance; a test reads that the list asked for it. */
export const LayoutAnimationConfig = ({ children, skipEntering }: any) => (
  <div data-skip-entering={skipEntering ? 'true' : undefined}>{children}</div>
);
const AnimatedView = ({ entering, exiting, layout, onLayout, ...props }: any) => {
  // the latest onLayout an animated view asked for, so a test can deliver a measurement
  if (onLayout) (globalThis as any).__phoneOnLayout = onLayout;
  // a test that sets the counter to a number reads how many animated views were drawn
  if (typeof (globalThis as any).__animatedViews === 'number') (globalThis as any).__animatedViews += 1;
  // the entrance a view asked for when it was first drawn: the only moment one plays, so a test can tell a row that fades in from one that was there
  const mounted = useRef(entering?.name);
  return (
    <View
      data-entering={entering?.name}
      data-mounted-entering={mounted.current}
      data-exiting={exiting?.name}
      data-layout={layout?.name}
      {...props}
    />
  );
};
const AnimatedText = (props: any) => <Text {...props} />;
const Animated = { View: AnimatedView, Text: AnimatedText };
export default Animated;
