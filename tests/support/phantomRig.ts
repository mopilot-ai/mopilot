// A real PhantomCursor and AppVisibility over a fake Electron window and a manual clock, for the tests that drive the cursor through the app-scoped tools.
import { createRequire } from 'node:module';
import { waitFor } from './waitFor.ts';
import { unNonce } from './phantomFakes.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../../electron/session/state.cjs');
const { AppVisibility } = require('../../electron/capabilities/appVisibility.cjs');
const { PhantomCursor, FRAME_MS } = require('../../electron/capabilities/phantomCursor.cjs');

/** The window's size and place in the app-scoped kit's Notes screenshot. */
export const BOUNDS = { x: 0, y: 0, width: 500, height: 400 };

export type FakeWindow = { calls: string[]; shown: boolean };

/**
 * @param load how loadURL settles: 'resolve' at once, 'pending' never (until `release()` of the returned rig)
 */
export function phantomRig(load: 'resolve' | 'pending' | 'reject' = 'resolve') {
  const windows: FakeWindow[] = [];
  const pending = new Map<number, { fn: Function; ms: number }>();
  const loads: (() => void)[] = [];
  let id = 0;
  class BrowserWindow implements FakeWindow {
    calls: string[] = [];
    shown = false;
    constructor() {
      windows.push(this);
    }
    webContents = {
      insertCSS: (css: string) => {
        this.calls.push(`css:${css}`);
        return Promise.resolve('key');
      },
    };
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setBounds() {}
    showInactive() {
      this.shown = true;
      this.calls.push('show');
    }
    hide() {
      this.shown = false;
      this.calls.push('hide');
    }
    isDestroyed() {
      return false;
    }
    loadURL(url: string) {
      this.calls.push(url);
      if (load === 'resolve') return Promise.resolve();
      if (load === 'reject') return Promise.reject(new Error('aborted'));
      return new Promise<void>((resolve) => loads.push(resolve));
    }
  }
  const timers = {
    setTimeout: (fn: Function, ms: number) => (pending.set(++id, { fn, ms }), id),
    clearTimeout: (t: number) => pending.delete(t),
  };
  const sessions = new SessionStore();
  const cursor = new PhantomCursor({ electron: { BrowserWindow }, timers, reducedMotion: () => false });
  const visibility = new AppVisibility({
    sessions: { get: (i: string) => sessions.get(i), patch: (i: string, p: any) => sessions.patch(i, p) },
    cursor,
  });
  const decode = (c: string) => unNonce(decodeURIComponent(c.replace(/^data:text\/html;charset=utf-8,/, '')));
  /** every page the window was given, in order */
  const pages = () => (windows[0]?.calls ?? []).filter((c) => c.startsWith('data:')).map(decode);
  /** the approach pages among them (the cursor's glide to a click), not a ring or a drag's path */
  const approaches = () => pages().filter((p) => p.includes('class="cur"') && p.includes('@keyframes life'));
  /** fires the timers set for `ms`, once one exists */
  const frame = () => {
    for (const [k, p] of [...pending]) if (p.ms === FRAME_MS) pending.delete(k), p.fn();
  };
  const arrive = async (ms: number) => {
    // the plan's clock starts one frame after the page was set going: let that frame pass
    await waitFor(() => (frame(), [...pending.values()].some((p) => p.ms === ms)), `a timer at ${ms}`);
    for (const [k, p] of [...pending]) if (p.ms === ms) pending.delete(k), p.fn();
  };
  const fire = (ms: number) => {
    for (const [k, p] of [...pending]) if (p.ms === ms) pending.delete(k), p.fn();
  };
  return { windows, pending, cursor, visibility, pages, approaches, arrive, fire, release: () => loads.splice(0).forEach((f) => f()) };
}
