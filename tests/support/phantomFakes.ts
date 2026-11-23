// Fakes for the phantom cursor's unit tests: an Electron BrowserWindow that records its calls, a manual clock, and a PhantomCursor over them.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhantomCursor } = require('../../electron/capabilities/phantomCursor.cjs');

export function fakeElectron(o: { makeThrows?: boolean } = {}) {
  const windows: any[] = [];
  class BrowserWindow {
    opts: any;
    calls: any[] = [];
    destroyed = false;
    throwOn = new Set<string>();
    constructor(opts: any) {
      if (o.makeThrows) throw new Error('no window');
      this.opts = opts;
      windows.push(this);
    }
    private rec(name: string, ...args: any[]) {
      this.calls.push([name, ...args]);
      if (this.throwOn.has(name)) throw new Error(`${name} failed`);
    }
    setIgnoreMouseEvents(...a: any[]) {
      this.rec('setIgnoreMouseEvents', ...a);
    }
    setAlwaysOnTop(...a: any[]) {
      this.rec('setAlwaysOnTop', ...a);
    }
    setContentProtection(...a: any[]) {
      this.rec('setContentProtection', ...a);
    }
    /** 'stale': the promise resolves at once but the page is not committed until commit() (loadURL answering for an older navigation) */
    loadMode: 'reject' | 'resolve' | 'pending' | 'throw' | 'stale' = 'resolve';
    committed = '';
    wanted = '';
    listeners = new Set<Function>();
    /** the wanted page is committed and did-finish-load fires */
    commit = () => {
      this.committed = this.wanted;
      for (const f of [...this.listeners]) f();
    };
    loadURL(url: string) {
      this.rec('loadURL', url);
      if (this.loadMode === 'throw') throw new Error('loadURL failed');
      if (this.loadMode === 'pending') return new Promise(() => {});
      this.wanted = url;
      if (this.loadMode === 'stale') return Promise.resolve();
      this.committed = url;
      return this.loadMode === 'resolve' ? Promise.resolve() : Promise.reject(new Error('aborted'));
    }
    /** how insertCSS settles: at once, never, with an error, or when `releaseCss()` is called (a late start) */
    cssMode: 'resolve' | 'pending' | 'reject' | 'throw' | 'late' = 'resolve';
    cssWaiting: (() => void)[] = [];
    releaseCss = () => this.cssWaiting.splice(0).forEach((f) => f());
    webContents = {
      getURL: () => this.committed,
      on: (_: string, f: Function) => this.listeners.add(f),
      removeListener: (_: string, f: Function) => this.listeners.delete(f),
      insertCSS: (css: string) => {
        this.rec('insertCSS', css);
        if (this.cssMode === 'throw') throw new Error('insertCSS failed');
        if (this.cssMode === 'reject') return Promise.reject(new Error('no frame'));
        if (this.cssMode === 'pending') return new Promise(() => {});
        if (this.cssMode === 'late') return new Promise<string>((r) => this.cssWaiting.push(() => r('key')));
        return Promise.resolve('key');
      },
    };
    setBounds(b: any) {
      this.rec('setBounds', b);
    }
    showInactive() {
      this.rec('showInactive');
    }
    hide() {
      this.rec('hide');
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.rec('destroy');
      this.destroyed = true;
    }
  }
  return { windows, electron: { BrowserWindow } };
}

export function fakeTimers() {
  const pending = new Map<number, Function>();
  const delays = new Map<number, number>();
  let id = 0;
  return {
    pending,
    delays,
    timers: {
      setTimeout: (fn: Function, ms?: number) => (pending.set(++id, fn), delays.set(id, ms ?? 0), id),
      clearTimeout: (t: number) => pending.delete(t),
    },
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    /** fires the pending timer(s) due at `ms` */
    fireAt: (ms: number) => {
      for (const [t, fn] of [...pending]) if (delays.get(t) === ms) pending.delete(t), fn();
    },
  };
}
export const flush = () => new Promise<void>((r) => setImmediate(r));

/** A page without its per-approach nonce comment (the rest is what approachHtml renders from the plan). */
export const unNonce = (html: string) => html.replace(/\/\* n\w+ \*\//, '/*  */');
export const page = (w: any) =>
  unNonce(
    decodeURIComponent(
      w.calls
        .filter((c: any) => c[0] === 'loadURL')
        .at(-1)[1]
        .replace(/^data:text\/html;charset=utf-8,/, ''),
    ),
  );
export const WIN = { x: 100, y: 50, width: 500, height: 400 };

export function approachRig(o: { reducedMotion?: () => boolean; electron?: any } = {}) {
  const e = fakeElectron();
  const t = fakeTimers();
  const c = new PhantomCursor({ electron: o.electron ?? e.electron, timers: t.timers, reducedMotion: o.reducedMotion });
  return { e, t, c };
}
export const ACT = { chatId: 'c1', bundleId: 'com.apple.Notes', bounds: WIN, points: [{ x: 300, y: 250 }], kind: 'click' };

/** An approach with a token, as AppVisibility makes it. */
export const act = (c: any, o: object = {}) => {
  const token = {};
  return { token, done: c.approach({ ...ACT, ...o, token }) };
};

// the overlay's own schedule for a click (electron/capabilities/phantomCursor.cjs scheduleOf): when its input goes and when its cursor has played out
const { scheduleOf } = createRequire(import.meta.url)('../../electron/capabilities/phantomCursor.cjs');
export const inputAtOf = (plan: any): number => scheduleOf(plan, true).inputAt;
export const playedAtOf = (plan: any): number => scheduleOf(plan, true).playedAt;
