// Why a screen rendered, read from React's own bookkeeping, for the performance log's trace mode: which props and which `useState` values differ from the render before. React exposes the fibre only in development builds (the dev client the measuring runs on); a release build says "unavailable". Names nothing of the app's own: only the shapes of values (their keys, or a short number, boolean or word), never their text.
import * as React from 'react';

/** One hook of a component: `queue` is set for the ones that hold a value (`useState`, `useReducer`, `useSyncExternalStore`) and null for effects, memos and refs. */
type Hook = { memoizedState: unknown; queue: unknown; next: Hook | null };
type Fiber = {
  memoizedProps: Record<string, unknown> | null;
  memoizedState: Hook | null;
  alternate: Fiber | null;
};

/** The fibre of the component being rendered now (call it from inside a render); null where React does not give it. */
export function ownerFiber(): Fiber | null {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { A?: { getOwner?: () => Fiber | null } | null };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return internals?.A?.getOwner?.() ?? null;
}

/** A value's shape in a few characters: its keys, the length of a list, a number, a boolean, or a word cut short. */
export function shape(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `list${value.length}`;
  if (typeof value === 'object') return `{${Object.keys(value).slice(0, 4).join(',')}}`;
  if (typeof value === 'function') return 'fn';
  if (typeof value === 'string') return value.length > 12 ? `"${value.slice(0, 12)}…"` : `"${value}"`;
  return String(value);
}

/** The reasons the fibre rendered the way it just did, one label each: `props a,b`, `state 33 null→{rev,session,items,shape}`, or `no change`. */
export function causesOf(fiber: Fiber | null): string[] {
  const before = fiber?.alternate;
  if (!fiber) return ['unavailable'];
  if (!before) return ['first render'];
  const causes: string[] = [];
  const now = fiber.memoizedProps ?? {};
  const was = before.memoizedProps ?? {};
  const changed = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter((key) => !Object.is(now[key], was[key]));
  if (changed.length) causes.push(`props ${changed.slice(0, 6).join(',')}`);
  let a: Hook | null = fiber.memoizedState;
  let b: Hook | null = before.memoizedState;
  for (let i = 0; a && b; i += 1, a = a.next, b = b.next) {
    // only the values the component holds; effects, memos and refs are its own bookkeeping
    if (!a.queue) continue;
    if (!Object.is(a.memoizedState, b.memoizedState)) causes.push(`state ${i} ${shape(b.memoizedState)}→${shape(a.memoizedState)}`);
  }
  return causes.length ? causes : ['no change'];
}
