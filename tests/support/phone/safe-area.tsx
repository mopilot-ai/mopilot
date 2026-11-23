// react-native-safe-area-context as DOM: its insets-aware SafeAreaView (Android) as a marked div, so a test can tell it from React Native's; the provider as a div marked `data-safe-area-provider`; the insets a test sets on `globalThis.__safeAreaInsets` (none by default).
export const SafeAreaView = ({ children, style }: any) => (
  <div data-safe-area="context" style={Array.isArray(style) ? Object.assign({}, ...style) : style}>
    {children}
  </div>
);
export const SafeAreaProvider = ({ children }: any) => <div data-safe-area-provider="">{children}</div>;
export const useSafeAreaInsets = () => (globalThis as any).__safeAreaInsets ?? { top: 0, bottom: 0, left: 0, right: 0 };
