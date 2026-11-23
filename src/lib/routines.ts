// Routines in the renderer (#3571, G4): Settings › Browser › Routines' list from window.native.routines, read again when main says it changed; a newer load wins over an older one still in flight. Main answers {ok, …} or {ok:false, error}.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from './native';
import type { RoutineView, RoutinesResult } from './native/routines';

/** What an answer says went wrong, or null when it went through. */
export const failure = (r: RoutinesResult | undefined): string | null => (r?.ok ? null : (r?.error ?? 'Couldn’t reach the routines.'));

export function useRoutines() {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const [skillsProblem, setSkillsProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const n = ++latest.current;
    const r = await native.routines.list().catch(
      (): RoutinesResult<{ routines: RoutineView[]; skillsProblem: string | null }> => ({
        ok: false,
        error: 'Couldn’t load the routines.',
      }),
    );
    if (n !== latest.current) return;
    // a bridge without routines (an older preload) answers nothing: the list stays empty and says why
    if (r?.ok) {
      setRoutines(r.routines);
      setSkillsProblem(r.skillsProblem ?? null);
    }
    setError(failure(r));
  }, []);
  useEffect(() => {
    void load();
    const off = native.routines.onChanged(() => void load());
    return () => {
      // a load still in flight is no longer this page's
      latest.current++;
      off();
    };
  }, [load]);
  /** Whether main took the change; when it didn't, why shows above the list. */
  const done = async (p: Promise<RoutinesResult>) => {
    const r = await p.catch((): RoutinesResult => ({ ok: false, error: 'Couldn’t save that.' }));
    setError(failure(r));
    return r.ok;
  };
  return {
    routines,
    skillsProblem,
    error,
    reload: load,
    rename: (r: RoutineView, name: string, description: string) => done(native.routines.edit(r.id, r.rev, { name, description })),
    remove: (id: string) => done(native.routines.remove(id)),
  };
}
