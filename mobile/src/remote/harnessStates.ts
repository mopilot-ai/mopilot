// Every agent the Mac knows, with why one cannot be used and whether a chat can move to it (harnesses.list with `states`): no screen, so any UI can draw it.
import { capabilities, rec, str, type Owned } from './client';

export type HarnessState = 'ready' | 'signin' | 'missing' | 'off' | 'checking' | 'unavailable';
export type HarnessRow = {
  id: string;
  /** the Mac's name for it (an added agent's own, never a prettified id) */
  label: string;
  kind: 'builtin' | 'acp';
  state: HarnessState;
  /** why the Mac switched it off or could not sign it in, in its words */
  reason: string | null;
  /** a chat may move to it from its next message */
  canSwitch: boolean;
  /** why not, in the Mac's words (a model to pick on the Mac first, not signed in) */
  switchReason: string | null;
};
const STATES = ['ready', 'signin', 'missing', 'off', 'checking', 'unavailable'];

/** The rows of a `harnesses.list` reply; an older Mac sends none (null), a row without an id is dropped, an unknown state is "checking". */
export function parseHarnessStates(reply: unknown): HarnessRow[] | null {
  const rows = rec(reply)?.states;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((x) => {
    const h = rec(x);
    const id = str(h?.id);
    if (!h || !id) return [];
    return [
      {
        id,
        label: str(h.label) ?? id,
        kind: h.kind === 'acp' ? ('acp' as const) : ('builtin' as const),
        state: STATES.includes(String(h.state)) ? (h.state as HarnessState) : 'checking',
        reason: str(h.reason),
        canSwitch: h.canSwitch === true,
        switchReason: str(h.switchReason),
      },
    ];
  });
}

/** The Mac's harness rows, or null from a Mac that does not send them. */
export async function loadHarnessStates(request: Owned): Promise<HarnessRow[] | null> {
  const caps = await capabilities(request).catch(() => null);
  if (caps?.methods && !caps.methods.has('harnesses.list')) return null;
  return parseHarnessStates(await request('harnesses.list', { states: true }));
}

/** The agents a chat on `current` can move to now, in the Mac's order; null when the Mac sent no rows to judge by (the caller keeps `harnesses.list`'s own). */
export const switchTargets = (rows: HarnessRow[] | null, current: string | null) =>
  rows?.filter((h) => h.canSwitch && h.id !== current) ?? null;
