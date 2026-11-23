// react-native-reanimated in the test DOM: animated views render as plain ones, with the animation they asked for kept as data.
import { useRef } from 'react';
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
/** The per-frame callback is kept for a test to call with a frame's length (`timeSincePreviousFrame`), as the UI thread would. */
export const useFrameCallback = (fn: (frame: { timeSincePreviousFrame: number | null }) => void) => {
  (globalThis as any).__phoneFrame = fn;
};
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
  return <View data-entering={entering?.name} data-exiting={exiting?.name} data-layout={layout?.name} {...props} />;
};
const AnimatedText = (props: any) => <Text {...props} />;
const Animated = { View: AnimatedView, Text: AnimatedText };
export default Animated;
