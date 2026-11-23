// react-native-gesture-handler for the entry test: its root view is a marked element the test can find.
import type { ReactNode } from 'react';

export const GestureHandlerRootView = ({ children }: { children: ReactNode }) => <div data-gesture-root="true">{children}</div>;
