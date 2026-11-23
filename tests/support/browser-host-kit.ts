// Fakes and helpers for the browser host tests (electron/capabilities/browser/host.cjs and the modules it uses):
// Electron webContents with a fake CDP debugger and page agent, fake images, virtual-time driving, and a BrowserTabs setup.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as flush } from './async-scenarios.ts';
import { waitFor } from './waitFor.ts';
export { flush };

const require = createRequire(import.meta.url);
const host = require('../../electron/capabilities/browser/host.cjs');
export const {
  BrowserTabs,
  MAX_TABS,
  BUFFER_MAX,
  normalizeUrl,
  redactUrl,
  chord,
  modifierBits,
  safeFileName,
  oneLine,
  isBlank,
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  PAGE_BACKDROP,
} = host;
export const { PAGE_AGENT_SOURCE } = require('../../electron/capabilities/browser/pageAgent.cjs');
/** A CDP call of the tab's own setup, not its WebMCP catalog's (webmcp.cjs, tested in tests/webmcp.test.ts). */
export const ownSetup = (c: { method: string }) => !c.method.startsWith('WebMCP.') && c.method !== 'Page.getFrameTree';
export const { mapping } = require('../../electron/capabilities/browser/capture.cjs');
/** Where an image pixel lands in the coordinate frame, by a mapping's factor and origin (what a model does with them). */
export const toFrame = (m: any, [x, y]: number[]) => [m.x0 + x * m.kx, m.y0 + y * m.ky];
const { isViewTab } = require('../../electron/capabilities/browser/views.cjs');

const AGENT_CALL = /^globalThis\.__mopilotAgent\.call\(("[^"]*"), ([\s\S]*?), (\d+)(?:, (\{[\s\S]*\}))?\)$/;
const OWNER_OF = /^globalThis\.__mopilotAgent\.element\(("[^"]*")\)$/;
const INPROC_CALL = /^\.call\(("[^"]*"), ([\s\S]*?), (\d+)(?:, (\{[\s\S]*\}))?\)$/;
const RAW = Symbol('raw');
/** An agent op's answer that replaces the whole Runtime.evaluate result. */
export const raw = (r: any) => ({ [RAW]: r });

class FakeDebugger extends EventEmitter {
  attached = false;
  attaches = 0;
  detachThrows = false;
  calls: { method: string; params: any; sessionId?: string }[] = [];
  /** emulated focus on this CDP session (Emulation.setFocusEmulationEnabled); detaching ends it, as in Chromium */
  focus = false;
  /**
   * Input Chromium never delivers: a mouse or key event sent to a view tab no window shows (parked, views.cjs) while
   * its focus isn't emulated hangs and lands nowhere, or is the first one dropped after the view wakes (#1509).
   * `wc.shown` marks a view a window shows.
   */
  dropped: { method: string; params: any }[] = [];
  wc: FakeWC;
  constructor(wc: FakeWC) {
    super();
    this.wc = wc;
  }
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attaches++;
    this.attached = true;
  }
  detach() {
    if (this.detachThrows) throw new Error('detach failed');
    this.attached = false;
    this.focus = false;
  }
  sendCommand(method: string, params: any = {}, sessionId?: string) {
    this.calls.push(sessionId === undefined ? { method, params } : { method, params, sessionId });
    if (method === 'Emulation.setFocusEmulationEnabled') this.focus = !!params?.enabled;
    else if (/^Input\.dispatch/.test(method) && isViewTab(this.wc) && !this.wc.shown && !this.focus) this.dropped.push({ method, params });
    return new Promise((resolve, reject) => {
      try {
        resolve(this.wc.cdp(method, params, sessionId));
      } catch (e) {
        reject(e);
      }
    });
  }
  /** A CDP event from the page. */
  event(method: string, params?: any, sessionId?: string) {
    this.emit('message', {}, method, params, sessionId);
  }
  sent(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

let wcIds = 100;
class FakeWC extends EventEmitter {
  id = wcIds++;
  destroyed = false;
  /** the renderer is gone (crashed, or killed when it hung) while the contents stay */
  crashed = false;
  url = 'about:blank';
  title = '';
  loading = false;
  /** a view tab a window shows (FakeDebugger.dropped) */
  shown = false;
  throttling: boolean[] = [];
  /** the pinch limits main set (views.cjs), as Electron's setVisualZoomLevelLimits */
  pinch: [number, number] | null = null;
  setVisualZoomLevelLimits(min: number, max: number) {
    this.pinch = [min, max];
  }
  throttleThrows = false;
  type: string;
  session: any;
  hostWebContents: any;
  prefs: any;
  debugger: FakeDebugger;
  ctxSeq = 0;
  seq = 0;
  handlers: Record<string, (params: any, sessionId?: string) => any> = {};
  ops: Record<string, (args: any, sessionId?: string) => any> = {};
  agentCalls: { op: string; args: any; sessionId?: string; contextId: number; hints?: any }[] = [];
  /** refs the next page-agent call reports as minted (pageAgent.cjs `minted`): [ref, role, name, tag] rows, and the page's address */
  mintedNext: { minted: any[]; url: string } | null = null;
  /** frame ids by the ref of their owner element (tab.childFrame) */
  ownerFrames: Record<string, string> = {};
  worldFrames = new Map<number, string>();
  entries = [{ url: 'https://a.test/0' }];
  index = 0;
  navs: string[] = [];
  stops = 0;
  restores: any[] = [];
  /** what navigationHistory.restore returns while its page loads (settles with the load, as Electron's does) */
  restoreLoad: Promise<void> = new Promise(() => {});
  captureImpl: (rect: any) => any = () => image({ src: 'capturePage' });
  navigationHistory = {
    getActiveIndex: () => this.index,
    length: () => this.entries.length,
    getEntryAtIndex: (i: number) => this.entries[i],
    getAllEntries: () => this.entries.map((e: any) => ({ title: '', ...e })),
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.entries.length - 1,
    goBack: () => this.navs.push('back'),
    goForward: () => this.navs.push('forward'),
    // Electron 44: the entries are written at once and the current one starts loading; the promise settles with that
    // load and has a no-op rejection handler. A page that loaded anything (about:blank included) refuses, writing nothing.
    restore: ({ entries, index }: any) => {
      this.restores.push({ entries, index });
      const load =
        this.url === ''
          ? this.restoreLoad
          : Promise.reject(new Error('Cannot restore history on webContents that have previously loaded a page.'));
      load.catch(() => undefined);
      if (this.url === '') Object.assign(this, { entries, index, url: entries[index].url, loading: true });
      return load;
    },
  };
  constructor({ type = 'webview', session, owner, prefs = {} }: any) {
    super();
    this.type = type;
    this.session = session;
    this.hostWebContents = type === 'webview' ? owner : undefined;
    this.prefs = prefs;
    this.debugger = new FakeDebugger(this);
    this.ops.state = () => ({ w: 800, h: 600, dpr: 2, sx: 0, sy: 10, visibility: 'visible', quietMs: 1000 });
  }
  isDestroyed() {
    return this.destroyed;
  }
  isCrashed() {
    return this.crashed;
  }
  getType() {
    return this.type;
  }
  getLastWebPreferences() {
    return this.prefs;
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
  getUserAgent() {
    return 'Real UA';
  }
  setBackgroundThrottling(on: boolean) {
    if (this.throttleThrows) throw new Error('gone');
    this.throttling.push(on);
  }
  reload() {
    this.navs.push('reload');
  }
  stop() {
    this.stops++;
    this.loading = false;
  }
  capturePage(rect: any) {
    return this.captureImpl(rect);
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
  cdp(method: string, params: any, sessionId?: string): any {
    if (method in this.handlers) return this.handlers[method](params, sessionId);
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: sessionId ? `frame-${sessionId}` : 'main' } } };
      case 'Page.createIsolatedWorld':
        this.worldFrames.set(this.ctxSeq + 1, params.frameId);
        return { executionContextId: ++this.ctxSeq };
      case 'DOM.describeNode':
        return { node: { frameId: this.ownerFrames[String(params.objectId).replace(/^owner:/, '')] } };
      case 'Runtime.evaluate': {
        if (params.expression === `${PAGE_AGENT_SOURCE}, true`) return { result: { value: true } };
        // a frame element by its ref, and the frame it shows (tab.childFrame): `ownerFrames` maps refs to frame ids
        const el = OWNER_OF.exec(params.expression);
        if (el) return JSON.parse(el[1]) in this.ownerFrames ? { result: { objectId: `owner:${JSON.parse(el[1])}` } } : { result: {} };
        // an op in such a frame's world: ops see the session as `inproc:<frame id>`
        const inner = params.expression.startsWith(`${PAGE_AGENT_SOURCE}.call(`)
          ? INPROC_CALL.exec(params.expression.slice(PAGE_AGENT_SOURCE.length))
          : null;
        if (inner) {
          const op = JSON.parse(inner[1]);
          const sid = `inproc:${this.worldFrames.get(params.contextId)}`;
          this.agentCalls.push({
            op,
            args: JSON.parse(inner[2]),
            sessionId: sid,
            contextId: params.contextId,
            ...(inner[4] ? { hints: JSON.parse(inner[4]) } : {}),
          });
          const minted = this.mintedNext;
          this.mintedNext = null;
          return { result: { value: { value: this.ops[op]?.(JSON.parse(inner[2]), sid), seq: this.seq, ...minted } } };
        }
        const m = AGENT_CALL.exec(params.expression);
        if (m) {
          const op = JSON.parse(m[1]);
          const args = JSON.parse(m[2]);
          this.agentCalls.push({ op, args, sessionId, contextId: params.contextId, ...(m[4] ? { hints: JSON.parse(m[4]) } : {}) });
          const value = this.ops[op] ? this.ops[op](args, sessionId) : undefined;
          if (value && typeof value === 'object' && RAW in value) return value[RAW];
          const minted = this.mintedNext;
          this.mintedNext = null;
          return { result: { value: { value, seq: this.seq, ...minted } } };
        }
        return { result: { type: 'undefined' } };
      }
      default:
        return {};
    }
  }
}

/** A fake nativeImage; `black` makes every pixel black (BGRA), as an unpainted page captures. */
export function image(info: any, empty = false, black = false) {
  return {
    info,
    isEmpty: () => empty,
    toBitmap: () => Buffer.from(empty ? [] : black ? [0, 0, 0, 255, 8, 8, 8, 255] : [0, 0, 0, 255, 255, 255, 255, 255]),
    resize: (o: any) => ({
      getSize: () => ({ width: o.width, height: o.height }),
      toJPEG: (q: number) => Buffer.from(JSON.stringify({ q, info, ...o })),
    }),
  };
}

/** Settles `p` while virtual time advances `step` ms at a time. */
export async function drive<T = any>(t: any, p: Promise<T>, { step = 50, max = 2000 } = {}): Promise<T> {
  let done = false;
  let failed = false;
  let value: any;
  let error: any;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  await waitFor(() => done, 'the call to settle', {
    step: async () => {
      await flush();
      if (!done) t.mock.timers.tick(step);
    },
  });
  await flush();
  if (!done) throw new Error('did not settle');
  if (failed) throw error;
  return value;
}

const mocked = new WeakSet();
export function setup(t: any, o: any = {}) {
  if (!mocked.has(t)) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  mocked.add(t);
  const panelSession = { partition: 'persist:browser' };
  const owner: any = { id: 1, isDestroyed: () => false };
  const appContents = [owner];
  const log: any = { open: [], close: [], select: [], auto: [], onSelect: [], changes: [] };
  const h: any = { panelSession, owner, appContents, log, autoAttach: true };
  h.newWC = (opts: any = {}) => new FakeWC({ owner, session: panelSession, ...opts });
  h.popupWC = () => h.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } });
  h.tabs = new BrowserTabs({
    appContents: () => appContents,
    panelSession: () => panelSession,
    open: (chatId: string, req: any) => {
      log.open.push([chatId, req]);
      if (o.open) return o.open(chatId, req, h);
      if (h.autoAttach) {
        const wc = h.newWC();
        setTimeout(() => (h.tabs.attach(chatId, req.tabKey, wc, owner), h.tabs.layer(wc, 'front', owner)), 5);
      }
    },
    close: (tab: any) => {
      log.close.push(tab.id);
      if (o.close) return o.close(tab);
      setTimeout(() => tab.wc.destroy(), 5);
    },
    select: (tab: any, opts?: { auto?: boolean }) => {
      log.select.push(tab.id);
      // the selects at the agent's own pace, which never reopen a pane the user closed on a seen tab
      if (opts?.auto) log.auto.push(tab.id);
      if (o.select) o.select(tab);
    },
    ...(o.noOptional
      ? {}
      : {
          onSelect: (chatId: string, wc: any) => {
            log.onSelect.push([chatId, wc.id]);
            if (o.onSelectThrows) throw new Error('panel gone');
          },
          onChange: (chatId: string) => {
            log.changes.push(chatId);
            if (o.onChangeThrows) throw new Error('window gone');
          },
        }),
    // a view tab's page main opens with no window (views.cjs)
    ...(o.spawn ? { spawn: (chatId: string, history?: any) => o.spawn(chatId, h, history) } : {}),
    images: { fromBuffer: (buf: Buffer) => image({ src: 'cdp', bytes: buf.length }) },
    downloadsDir: o.downloadsDir,
    attachMs: o.attachMs,
    showMs: o.showMs,
    platform: o.platform ?? 'linux',
    ...(o.modelOf ? { modelOf: o.modelOf } : {}),
    ...(o.inputWhileHidden ? { inputWhileHidden: true } : {}),
    // the pages' own dialogs (pageDialogs.cjs) and pages that stop responding (pageHang.cjs)
    ...(o.dialogs ? { dialogs: o.dialogs } : {}),
    ...(o.hang ? { hang: o.hang } : {}),
  });
  return h;
}

/** Makes fake webContents view tabs, as main's PaneViews makes its pages (views.cjs): `asView(wc)` returns `wc`. */
export function viewTabs() {
  const { PaneViews } = require('../../electron/capabilities/browser/views.cjs');
  const v = new PaneViews({
    WebContentsView: class {
      webContents: any;
      constructor(o: any) {
        this.webContents = o.webContents;
      }
      setBounds() {}
    },
    BrowserWindow: class {
      contentView = { addChildView() {}, removeChildView() {} };
      isDestroyed() {
        return false;
      }
      setContentSize() {}
      destroy() {}
    },
    session: () => null,
    partition: () => 'persist:browser',
    windowOf: () => null,
  });
  return (wc: any) => v.adopt(wc).wc;
}

/** A tab of chat `c` attached from the pane, with key `key` (null: the chat's original tab), shown in front unless `layer` says otherwise. */
export function tabOf(h: any, key: string | null = 'tab_aaaaaa', chatId = 'c', wc = h.newWC(), layer: string | null = 'front') {
  const tab = h.tabs.attach(chatId, key, wc, h.owner);
  if (layer) h.tabs.layer(wc, layer, h.owner);
  return tab;
}

export function navTab(t: any, h: any) {
  const tab = tabOf(h);
  tab.wc.ops.state = () => ({ quietMs: 1000 });
  return tab;
}

/* ------------------------------------------------------------------ */
/* reading: tree, find, text                                           */
/* ------------------------------------------------------------------ */

/** A page with a cross-origin frame F1 (owner ref_10 in the top frame) holding another frame F2 (owner ref_20). */
export function framedTab(t: any, h: any) {
  const tab = tabOf(h);
  tab.frames.set('F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: 'ref_10' });
  tab.frames.set('F2', { sessionId: 'F2', parent: 'F1', frameId: 'frame-2', world: null, ownerRef: 'ref_20' });
  Object.assign(tab.wc.ownerFrames, { ref_10: 'frame-1', ref_20: 'frame-2' });
  return tab;
}

/* ------------------------------------------------------------------ */
/* the agent cursor (agentCursor.cjs) hooks                            */
/* ------------------------------------------------------------------ */

/** A cursor that records what BrowserTabs tells it, in order with the tab's CDP input. */
export function recordingCursor(h: any) {
  const seen: any[] = [];
  h.tabs.o.cursor = {
    act: async (tab: any, a: any) => void seen.push(['act', tab.id, a]),
    // the control frame (Chrome tabs only) draws nothing here
    hold: async () => null,
    conceal: async (tab: any) => void seen.push(['conceal', tab.id]),
    reveal: async (tab: any) => void seen.push(['reveal', tab.id]),
    clear: (tab: any) => void seen.push(['clear', tab.id, tab.wc.debugger.isAttached()]),
  };
  return seen;
}
