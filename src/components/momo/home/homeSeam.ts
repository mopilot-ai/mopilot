// The thin seam MoMo's home surfaces talk through: a view to read, changes to hear, and one call per user move. In the app it is the IPC seam (ipcSeam.ts); a dev run may switch to the fixture seam; tests install their own. The view changes only from what the home answers.
import type { MomoView } from '../../../../shared/momoView';
import type { MomoHomeAction, MomoHomeResult } from './homeActions';
import { fixtureView, scenarioView } from './homeFixtures';
import { reduceHome } from './homeReducer';
import { momoHomeScenario } from './homeSwitch';
import { createIpcSeam } from './ipcSeam';
import { ignoring } from '../../../lib/ignored';
import { native } from '../../../lib/native';

export type MomoHomeRead = { ok: true; view: MomoView } | { ok: false; cause: string };

export interface MomoHomeSeam {
  /** the whole view as it stands, or why there is none */
  read(): Promise<MomoHomeRead>;
  /** called with the new view whenever the home changes it; returns the way to stop */
  subscribe(cb: (v: MomoView) => void): () => void;
  /** one user move; the answer is done, or the real cause and the fix the home offers */
  act(a: MomoHomeAction): Promise<MomoHomeResult>;
}

/** The fixture seam: a scripted home for unit tests and a dev run. It answers every move through the pure reducer; `script` lets a test play the home's own steps. */
export function createFixtureSeam(initial: MomoView = fixtureView(), clock: () => number = Date.now) {
  let view = initial;
  const listeners = new Set<(v: MomoView) => void>();
  const set = (next: MomoView) => {
    view = next;
    for (const l of listeners) l(view);
  };
  return {
    read: async (): Promise<MomoHomeRead> => ({ ok: true, view }),
    subscribe(cb: (v: MomoView) => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    async act(a: MomoHomeAction): Promise<MomoHomeResult> {
      set(reduceHome(view, a, clock()));
      return { ok: true };
    },
    /** what the scripted home does by itself (a move's next step, a failure), not a user move */
    script(f: (v: MomoView, now: number) => MomoView) {
      set(f(view, clock()));
    },
  };
}

let installed: MomoHomeSeam | null = null;
let chosen: Promise<MomoHomeSeam | null> | null = null;

/** Tests install their own seam here (null: choose again). */
export function setMomoHomeSeam(next: MomoHomeSeam | null) {
  installed = next;
  chosen = null;
}

/**
 * The seam this window uses: an installed one; else none when the bridge has no home (an older preload); else, only in a dev run
 * (main says so) the dev switch decides: off is no seam (today's pages stay, which is what every other dev-run spec expects), "ipc" is
 * the home main serves, anything else a fixture scenario; a packaged app always gets the IPC seam.
 */
export function momoHomeSeam(): Promise<MomoHomeSeam | null> {
  if (installed) return Promise.resolve(installed);
  chosen ??= (async () => {
    const bridge = (native as { momoHome?: (typeof native)['momoHome'] }).momoHome;
    if (!bridge) return null;
    const dev = (await bridge.dev().catch(ignoring('ask whether this is a dev run'))) === true;
    const scenario = momoHomeScenario();
    if (!dev) return createIpcSeam(bridge);
    if (!scenario) return null;
    return scenario === 'ipc' ? createIpcSeam(bridge) : createFixtureSeam(scenarioView(scenario === '1' ? null : scenario));
  })();
  return chosen;
}
