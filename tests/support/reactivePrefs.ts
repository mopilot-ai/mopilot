// A store stand-in whose `prefs` re-render the components that read them when `setPrefs` writes (the shell keeps its rail, pane and widths there): `useStore` selects from `{ prefs, ...rest }`, `setPrefs` merges and tells every reader.
import { useEffect, useReducer } from 'react';

export function reactivePrefs(rest: () => Record<string, unknown> = () => ({})) {
  const prefs: Record<string, unknown> = {};
  const readers = new Set<() => void>();
  const sets: Record<string, unknown>[] = [];
  return {
    prefs,
    /** every `setPrefs` call's patch, in order */
    sets,
    useStore: (sel: (s: any) => unknown) => {
      const [, tick] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        readers.add(tick);
        return () => void readers.delete(tick);
      }, []);
      return sel({ prefs, ...rest() });
    },
    setPrefs: (patch: Record<string, unknown>) => {
      sets.push(patch);
      Object.assign(prefs, patch);
      for (const r of [...readers]) r();
    },
    reset: () => {
      for (const k of Object.keys(prefs)) delete prefs[k];
      sets.length = 0;
    },
  };
}
