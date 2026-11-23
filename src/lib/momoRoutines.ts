// MoMo's routines in the renderer (#2139): Settings › MoMo › Routines' data from window.native.momoRoutines, read again when main says it changed. A newer load wins over an older one still in flight.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from './native';
import { errorText } from '../../shared/userError.mjs';
import type { MomoRoutineEdit, MomoRoutinesView } from './native/momoRoutines';

export function useMomoRoutines() {
  const [view, setView] = useState<MomoRoutinesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const n = ++latest.current;
    try {
      const next = await native.momoRoutines.view();
      if (n !== latest.current) return;
      setView(next);
      setError(null);
    } catch {
      if (n === latest.current) setError('Couldn’t load the routines.');
    }
  }, []);
  useEffect(() => {
    // load() never rejects: a failure becomes the error it shows
    void load();
    const off = native.momoRoutines.onChanged(() => {
      void load();
    });
    return () => {
      // a load still in flight is no longer this page's
      latest.current++;
      off();
    };
  }, [load]);
  // a change shows only once main has it (the view is read again); one main refused says why (a routine changed since
  // it was shown, a time that isn't one)
  const refused = (e: unknown) => setError(`Couldn’t save that: ${errorText(e)}`);
  const saved = (p: Promise<unknown>) => p.then(load, refused);
  return {
    view,
    error,
    reload: load,
    approve: (routineId: string, rev: number) => saved(native.momoRoutines.approve(routineId, rev)),
    /** whether main saved it: an edit form stays open, with what the user typed, when it didn't */
    edit: (routineId: string, edit: MomoRoutineEdit): Promise<boolean> =>
      native.momoRoutines.edit(routineId, edit).then(
        async () => (await load(), true),
        (e: unknown) => (refused(e), false),
      ),
    remove: (routineId: string) => saved(native.momoRoutines.remove(routineId)),
  };
}
