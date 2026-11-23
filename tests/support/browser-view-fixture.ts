// Fake native views, contents and windows shared by browser view and shortcut policy unit tests.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PaneViews } = require('../../electron/capabilities/browser/views.cjs');
const { fakeDebugger } = require('../helpers/browser.cjs');
let nextId = 100;
export class FakeWC extends EventEmitter {
  id = nextId++;
  destroyed = false;
  sent: any[] = [];
  url = '';
  title = '';
  loading = false;
  zoom = 1;
  calls: any[] = [];
  loadResult: Promise<void> | void = undefined;
  history = { back: false, forward: false };
  navigationHistory = {
    canGoBack: () => this.history.back,
    canGoForward: () => this.history.forward,
    goBack: () => this.calls.push('back'),
    goForward: () => this.calls.push('forward'),
  };
  prefs: any;
  session: any;
  debugger = fakeDebugger();
  constructor(prefs: any = {}, session: any = prefs.session) {
    super();
    this.prefs = prefs;
    this.session = session;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setIgnoreMenuShortcuts(_on: boolean) {}
  send(channel: string, payload: any) {
    this.sent.push([channel, payload]);
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.title;
  }
  isLoading() {
    return this.loading;
  }
  getZoomFactor() {
    return this.zoom;
  }
  setZoomFactor(zoom: number) {
    this.calls.push(['zoom', zoom]);
    this.zoom = zoom;
  }
  /** the pinch limits main set, or null while it set none (Electron's 1..1 default turns the gesture off) */
  pinch: [number, number] | null = null;
  setVisualZoomLevelLimits(min: number, max: number) {
    this.pinch = [min, max];
  }
  getType() {
    return 'window';
  }
  getLastWebPreferences() {
    return this.prefs;
  }
  loadURL(url: string) {
    this.calls.push(['load', url]);
    this.url = url;
    return this.loadResult;
  }
  reloadIgnoringCache() {
    this.calls.push('reloadIgnoringCache');
  }
  reload() {
    this.calls.push('reload');
  }
  stop() {
    this.calls.push('stop');
  }
  close() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
export class FakeView {
  webContents: FakeWC;
  bounds: any = null;
  parent: any = null;
  constructor(o: any) {
    this.webContents = o.webContents ?? new FakeWC(o.webPreferences);
  }
  setBounds(b: any) {
    this.bounds = b;
  }
}
export class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = [];
  destroyed = false;
  size: [number, number] | null = null;
  contentView = {
    children: [] as FakeView[],
    addChildView: (v: FakeView) => {
      if (v.parent) v.parent.contentView.children = v.parent.contentView.children.filter((c: FakeView) => c !== v);
      v.parent = this;
      this.contentView.children.push(v);
    },
    removeChildView: (v: FakeView) => {
      this.contentView.children = this.contentView.children.filter((c) => c !== v);
      if (v.parent === this) v.parent = null;
    },
  };
  opts: any;
  constructor(opts: any = {}) {
    super();
    this.opts = opts;
    FakeWindow.made.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  setContentSize(w: number, h: number) {
    this.size = [w, h];
  }
  destroy() {
    this.destroyed = true;
  }
}

export function setup(o: any = {}) {
  const sessions = new Map<string, any>();
  const win = new FakeWindow();
  const sender = Object.assign(new FakeWC(), { zoom: 1.25 });
  const created: any[] = [];
  const views = new PaneViews({
    WebContentsView: FakeView,
    BrowserWindow: FakeWindow,
    session: (p: string) => sessions.get(p) ?? (sessions.set(p, { partition: p }), sessions.get(p)),
    partition: (p: any) => (typeof p === 'string' && p.startsWith('mopilot-chat-') ? p : 'persist:browser'),
    windowOf: (s: any) => (s === sender ? win : (o.windowOf?.(s) ?? null)),
    agentView: o.agentView,
    onCreated: (wc: any) => created.push(wc),
  });
  return { views, win, sender, sessions, created };
}
