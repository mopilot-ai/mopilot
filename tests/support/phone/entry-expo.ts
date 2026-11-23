// Captures the component registered by the real Expo entry.
export function registerRootComponent(component: unknown) {
  (globalThis as any).__phoneRegistered = component;
}
