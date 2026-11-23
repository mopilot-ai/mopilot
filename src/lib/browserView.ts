// The browser pane's side of main-owned tab views (shared.browser.viewTabs, electron/capabilities/browser/views.cjs): a handle with the <webview> API the pane uses, where the page goes on screen, and which pane tabs closed.
import type { BrowserViewApi, BrowserViewEvent, BrowserViewState } from './native';
import { noteIgnored } from './ignored';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * App UI that draws over the pane: a native view paints above the window's DOM, so while one of these
 * intersects the page the page is hidden (docs/browser.md). Tooltips and toasts are left out: hiding the
 * page on every hover or notice would flash it.
 */
export const OVERLAY_SELECTOR =
  '.popover-layer, .menu, .dialog, .palette-backdrop, .sketch-backdrop, .sched-dialog-backdrop, [role="dialog"], [role="alertdialog"], [role="menu"]';
/** Bands over the top or bottom edge of the page (Annotate's bar, full view's floating composer): the page is laid out around them. */
export const BAND_SELECTOR = '.browser-annotate-bar, .pane-float-composer';

const EMPTY: BrowserViewState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false, zoom: 1 };

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const visible = (r: Rect) => r.width > 0 && r.height > 0;

/**
 * Where the page goes, in CSS pixels: the stage, less the bands over its top or bottom edge; null
 * (hidden) for an empty stage or while an overlay intersects it.
 */
export function viewBounds(stage: Rect, overlays: Rect[] = [], bands: Rect[] = []): Rect | null {
  if (!visible(stage)) return null;
  if (overlays.some((o) => visible(o) && intersects(o, stage))) return null;
  let top = stage.y;
  let bottom = stage.y + stage.height;
  const middle = stage.y + stage.height / 2;
  for (const b of bands) {
    if (!visible(b) || !intersects(b, stage)) continue;
    if (b.y + b.height / 2 < middle) top = Math.max(top, b.y + b.height);
    else bottom = Math.min(bottom, b.y);
  }
  if (bottom - top < 1) return null;
  return { x: Math.round(stage.x), y: Math.round(top), width: Math.round(stage.width), height: Math.round(bottom - top) };
}

export const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/** Where the page in `stage` goes now, given the app UI drawn over it; null to hide it. */
export function measure(stage: Element, doc: Document = document): Rect | null {
  const outside = (el: Element) => !stage.contains(el);
  const overlays = [...doc.querySelectorAll(OVERLAY_SELECTOR)].filter(outside).map(rectOf);
  const bands = [...doc.querySelectorAll(BAND_SELECTOR)].filter(outside).map(rectOf);
  return viewBounds(rectOf(stage), overlays, bands);
}

/**
 * A pane tab's view as the pane sees it: the <webview> methods and events BrowserPanel and Annotate
 * use, answered from main's last report and sent to main. getWebContentsId throws until bound, as a
 * guest's does before it attaches.
 */
export class ViewHandle {
  id: number | null = null;
  state: BrowserViewState = EMPTY;
  private api: BrowserViewApi;
  private listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(api: BrowserViewApi) {
    this.api = api;
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string, detail: Record<string, unknown> | null = null) {
    const e = Object.assign(new Event(type), detail ?? {});
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
  /** Main bound the pane tab to its view. */
  bound(id: number, state: BrowserViewState) {
    this.id = id;
    this.state = state;
    this.fire('did-attach');
  }
  /** A page event from main, fired as the <webview> would fire it. */
  receive(e: BrowserViewEvent) {
    if (e.id !== this.id) return;
    if (e.state) this.state = e.state;
    this.fire(e.type, e.detail);
  }
  getWebContentsId(): number {
    if (this.id == null) throw new Error('The page is not bound yet.');
    return this.id;
  }
  getZoomFactor() {
    return this.state.zoom || 1;
  }
  /** Whether the page's zoom fits the pane, rather than one the user chose for its site. */
  isZoomAuto() {
    return this.state.zoomAuto !== false;
  }
  /** Zoom In, Zoom Out, or fit the pane again ('reset'), for the page's site. */
  zoom(action: 'in' | 'out' | 'reset') {
    void this.api.nav(this.getWebContentsId(), `zoom-${action}`).catch((error) => noteIgnored(`zoom ${action} a browser pane page`, error));
  }
  getURL() {
    return this.state.url;
  }
  getTitle() {
    return this.state.title;
  }
  canGoBack() {
    return this.state.canGoBack;
  }
  canGoForward() {
    return this.state.canGoForward;
  }
  isLoading() {
    return this.state.loading;
  }
  loadURL(url: string) {
    return this.api.nav(this.getWebContentsId(), 'load', url);
  }
  #nav(action: 'back' | 'forward' | 'reload' | 'stop') {
    // the page went: its closed event takes the tab away
    void this.api.nav(this.getWebContentsId(), action).catch((error) => noteIgnored(`${action} a browser pane page`, error));
  }
  reload() {
    this.#nav('reload');
  }
  reloadIgnoringCache() {
    return this.api.nav(this.getWebContentsId(), 'reloadIgnoringCache');
  }
  /** The find bar's search (browserPanel/FindBar.tsx): its result comes back as a found-in-page event. */
  findInPage(text: string, options: { forward: boolean; findNext: boolean }) {
    return this.api.nav(this.getWebContentsId(), 'find', { text, ...options });
  }
  stopFindInPage() {
    void this.api.nav(this.getWebContentsId(), 'stop-find').catch((error) => noteIgnored('end a find in a browser pane page', error));
  }
  goBack() {
    this.#nav('back');
  }
  goForward() {
    this.#nav('forward');
  }
  stop() {
    this.#nav('stop');
  }
}

/** The pane tabs whose page is a main-owned view: browser tabs and the claude.ai pages artifact tabs show. */
const VIEW_KINDS = new Set(['browser', 'artifact']);
/** The browser pane tabs in `prev` that `next` no longer has (closed, or turned into another kind of tab). */
export function closedBrowserPanes(prev: { id: string; kind: string }[], next: { id: string; kind: string }[]): string[] {
  const still = new Set(next.filter((t) => VIEW_KINDS.has(t.kind)).map((t) => t.id));
  return prev.filter((t) => VIEW_KINDS.has(t.kind) && !still.has(t.id)).map((t) => t.id);
}
