// react-native-gesture-handler in the browser preview: a pan never recognises, and the detector draws its child.
import type { ReactNode } from 'react';
import { Pressable, ScrollView as ScrollViewBase } from 'react-native';

export const usePanGesture = (config: Record<string, unknown>) => config;
export const GestureDetector = ({ children }: { gesture?: unknown; children: ReactNode }) => <>{children}</>;
export const GestureHandlerRootView = ({ children }: { children: ReactNode }) => <>{children}</>;
/** The scroll view; its native gesture means nothing in a browser. */
export const ScrollView = ({ onGestureUpdate_CAN_CAUSE_INFINITE_RERENDER: _unused, ...props }: any) => <ScrollViewBase {...props} />;
/** The native button: in a browser it is a pressable, and the press fade it would draw natively is left out. */
export const Touchable = Pressable;
