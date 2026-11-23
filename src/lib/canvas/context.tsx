// Canvas hooks share keyed state inside the sandbox and send bounded persistence requests to their own preview.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { canvasTokens, canvasPaletteDark } from './theme';

export type CanvasMessage = { type: string; [key: string]: unknown };
export function canvasEnvironment(dark: boolean, initial: Record<string, unknown>, publish: (message: CanvasMessage) => void) {
  const values = new Map(Object.entries(initial));
  const defaults = new Map<string, unknown>();
  const pending = new Map<number, { key: string; value: unknown }>();
  let sequence = 0;
  let revision = -1;
  const listeners = new Set<() => void>();
  return {
    dark,
    publish,
    get<T>(key: string, fallback: T): T {
      if (!defaults.has(key)) defaults.set(key, fallback);
      return (values.has(key) ? values.get(key) : defaults.get(key)) as T;
    },
    value<T>(key: string): T {
      return (values.has(key) ? values.get(key) : defaults.get(key)) as T;
    },
    set(key: string, value: unknown) {
      values.set(key, value);
      pending.set(++sequence, { key, value });
      publish({ type: 'state', key, value, sequence });
      for (const listener of listeners) listener();
    },
    revision: () => revision,
    restore(next: Record<string, unknown>, version: number, acknowledged: number) {
      if (version < revision) return;
      values.clear();
      for (const [key, value] of Object.entries(next)) values.set(key, value);
      for (const [write, { key, value }] of pending) {
        if (write <= acknowledged) pending.delete(write);
        else values.set(key, value);
      }
      revision = version;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export const CanvasContext = createContext<ReturnType<typeof canvasEnvironment> | null>(null);
export function useCanvasEnvironment() {
  const environment = useContext(CanvasContext);
  if (!environment) throw Error('Canvas controls require a canvas preview.');
  return environment;
}
export function useCanvasState<T>(key: string, fallback: T): [T, (action: T | ((previous: T) => T)) => void] {
  const environment = useCanvasEnvironment();
  const value = useSyncExternalStore(environment.subscribe, () => environment.get(key, fallback));
  const set = useCallback(
    (action: T | ((previous: T) => T)) =>
      environment.set(key, typeof action === 'function' ? (action as (previous: T) => T)(environment.value<T>(key)) : action),
    [environment, key],
  );
  return [value, set];
}
export function useHostTheme() {
  const { dark } = useCanvasEnvironment();
  return { ...canvasTokens, kind: dark ? 'dark' : 'light', tokens: canvasTokens, palette: canvasPaletteDark };
}
export function useCanvasAction() {
  const { publish } = useCanvasEnvironment();
  return useCallback((action: unknown) => publish({ type: 'action', action }), [publish]);
}
