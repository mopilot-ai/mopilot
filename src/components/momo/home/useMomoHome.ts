// The one store MoMo's home surfaces read: the seam's view kept with structural sharing (a change that touches one task leaves every other task, row and slice the same object), read through selectors so a screen redraws only for the part it draws, and the user's moves with their pending and refused states.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MomoView } from '../../../../shared/momoView';
import type { MomoHomeAction, MomoHomeResult } from './homeActions';
import { momoHomeSeam, type MomoHomeSeam } from './homeSeam';

/** `next` with every part that equals `prev` replaced by the part of `prev`: unchanged objects and lists keep their identity. */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (Array.isArray(next) && Array.isArray(prev)) {
    const out = next.map((x, i) => shareStructure(prev[i], x));
    return (out.length === prev.length && out.every((x, i) => x === prev[i]) ? prev : out) as T;
  }
  if (next && prev && typeof next === 'object' && typeof prev === 'object' && !Array.isArray(next) && !Array.isArray(prev)) {
    const p = prev as Record<string, unknown>;
    const n = next as Record<string, unknown>;
    const keys = Object.keys(n);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shareStructure(p[k], n[k]);
    const same = keys.length === Object.keys(p).length && keys.every((k) => out[k] === p[k]);
    return (same ? prev : out) as T;
  }
  return next;
}

export type MomoHomeStatus = { status: 'loading' } | { status: 'ready' } | { status: 'unavailable'; cause: string };

let view: MomoView | null = null;
let status: MomoHomeStatus = { status: 'loading' };
let started: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function publish(next: MomoView) {
  view = shareStructure(view, next);
  status = status.status === 'ready' ? status : { status: 'ready' };
  emit();
}

function follow(): () => void {
  let stop: (() => void) | null = null;
  let live = true;
  void momoHomeSeam().then(async (seam) => {
    if (!live) return;
    if (!seam) {
      status = { status: 'unavailable', cause: 'MoMo’s home isn’t available here.' };
      return emit();
    }
    stop = seam.subscribe((v) => live && publish(v));
    const first = await seam.read();
    if (!live) return;
    if (first.ok) publish(first.view);
    else {
      status = { status: 'unavailable', cause: first.cause };
      emit();
    }
  });
  return () => {
    live = false;
    stop?.();
  };
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!started) started = follow();
  return () => {
    listeners.delete(cb);
    if (!listeners.size && started) {
      started();
      started = null;
    }
  };
}

/** Forgets what was read; the next reader reads again (a seam swap, or a test). */
export function resetMomoHomeStore() {
  started?.();
  started = null;
  view = null;
  status = { status: 'loading' };
}

/** Whether the home answered with a view: the surfaces replace the current MoMo pages only then. */
export function useMomoHomeStatus(): MomoHomeStatus {
  return useSyncExternalStore(subscribe, () => status);
}

/**
 * A slice of the view, or null before the home has answered. `select` must return a part of the view (its identity is kept while
 * the part is unchanged), not a new object, or the screen redraws on every change.
 */
export function useMomoSelect<T>(select: (v: MomoView) => T): T | null {
  return useSyncExternalStore(subscribe, () => (view ? select(view) : null));
}

/** One user move at a time per screen: `busy` while it runs and `failed` with the home's cause and fix when it was refused. */
export function useMomoAct() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Extract<MomoHomeResult, { ok: false }> | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const seam = useRef<MomoHomeSeam | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const act = useCallback(async (a: MomoHomeAction): Promise<MomoHomeResult> => {
    // a press while this screen's move is still going is the same press again
    if (inFlight.current) return { ok: false, cause: 'Still working on the last one.' };
    inFlight.current = true;
    setBusy(true);
    setFailed(null);
    let r: MomoHomeResult;
    try {
      seam.current ??= await momoHomeSeam();
      r = seam.current ? await seam.current.act(a) : { ok: false, cause: 'MoMo’s home isn’t available here.' };
    } catch {
      r = { ok: false, cause: 'MoMo’s home didn’t answer.' };
    }
    inFlight.current = false;
    if (!mounted.current) return r;
    setBusy(false);
    if (!r.ok) setFailed(r);
    return r;
  }, []);
  return { act, busy, failed };
}
