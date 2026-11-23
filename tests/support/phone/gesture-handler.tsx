// react-native-gesture-handler in the test DOM: a pan gesture is its config (a test calls its callbacks), a detector draws its child.
import { useEffect, type ReactNode } from 'react';
import { Pressable, ScrollView as ScrollViewBase } from 'react-native';

/** The latest config each pan was made with, so a test can recognise, move and release it. */
export const usePanGesture = (config: Record<string, unknown>) => {
  (globalThis as any).__phonePan = config;
  return config;
};
export const GestureDetector = ({ children }: { gesture?: unknown; children: ReactNode }) => <>{children}</>;
export const GestureHandlerRootView = ({ children }: { children: ReactNode }) => <div data-gesture-root="true">{children}</div>;
/** The scroll view with its own native gesture: it reports one, so a pan can run beside it. */
export const ScrollView = ({ onGestureUpdate_CAN_CAUSE_INFINITE_RERENDER, ...props }: any) => {
  useEffect(() => onGestureUpdate_CAN_CAUSE_INFINITE_RERENDER?.({ handlerTag: 7 }), [onGestureUpdate_CAN_CAUSE_INFINITE_RERENDER]);
  return <ScrollViewBase {...props} />;
};
/** The native button: in the DOM it is the same button a React Native pressable is, with the press look it asked for kept as data. */
export const Touchable = Pressable;
