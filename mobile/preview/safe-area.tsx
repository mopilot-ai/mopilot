// The native insets view is a plain View in the test-only web preview, which has no status bar to keep clear of.
import type { ReactNode } from 'react';
import { View } from 'react-native';
export const SafeAreaView = View;
/** The preview has no insets to provide: children render as they are. */
export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => <>{children}</>;
/** No status bar or home indicator in the web preview: every inset is zero. */
export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
