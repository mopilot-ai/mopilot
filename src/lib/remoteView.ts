// The pane's handle on a tab on a Host (package 2.6): the <webview> surface BrowserPanel uses, answered from the last frame main pushed, and the user's pointer and keys as inputs for main to forward during a takeover.
import type { BrowserRemoteFrame, BrowserRemoteInput } from './native';

/** What the page looks like now: the last frame's picture and its facts. */
export interface RemoteFrameState {
  src: string;
  width: number;
  height: number;
  url: string;
  title: string;
  loading: boolean;
}

/**
 * A pane tab's view of a tab on a Host. It has the <webview> methods and events the panel reads, with the page's address, title and
 * loading state from the frames; the user cannot navigate it from the pane (the agent drives it), so loadURL is refused and the rest do nothing.
 */
export class RemoteViewHandle {
  state: RemoteFrameState | null = null;
  private listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string, detail: Record<string, unknown> = {}) {
    const e = Object.assign(new Event(type), detail);
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
  /** A frame from main: what changed since the last one is told as the <webview> would tell it. */
  receive(f: BrowserRemoteFrame) {
    if (f.error !== undefined || f.data === undefined) return;
    const before = this.state;
    this.state = {
      src: `data:${f.mime ?? 'image/jpeg'};base64,${f.data}`,
      width: f.width ?? before?.width ?? 0,
      height: f.height ?? before?.height ?? 0,
      url: f.url ?? '',
      title: f.title ?? '',
      loading: f.loading === true,
    };
    if (!before) this.fire('dom-ready');
    if (this.state.loading && !before?.loading) this.fire('did-start-loading');
    if (this.state.url !== (before?.url ?? '')) this.fire('did-navigate', { url: this.state.url, isMainFrame: true });
    if (this.state.title !== (before?.title ?? '')) this.fire('page-title-updated', { title: this.state.title });
    if (!this.state.loading && before?.loading) this.fire('did-stop-loading');
  }
  getURL() {
    return this.state?.url ?? '';
  }
  getTitle() {
    return this.state?.title ?? '';
  }
  isLoading() {
    return this.state?.loading === true;
  }
  canGoBack() {
    return false;
  }
  canGoForward() {
    return false;
  }
  getZoomFactor() {
    return 1;
  }
  /** A page on a Host is not a webContents of this app. */
  getWebContentsId(): number {
    throw new Error('This page is on another machine.');
  }
  loadURL(): Promise<void> {
    return Promise.reject(new Error('This page is on another machine; the agent drives it.'));
  }
  // the agent drives the page: reload, history and stop are not the pane's to do
  reload() {
    /* nothing */
  }
  reloadIgnoringCache() {
    /* nothing */
  }
  goBack() {
    /* nothing */
  }
  goForward() {
    /* nothing */
  }
  stop() {
    /* nothing */
  }
}

/** A page on a Host that is a server on that machine's own loopback: its scheme, port and the rest of its address. */
export interface LoopbackTarget {
  protocol: string;
  port: number;
  rest: string;
}

/** A page on a Host that is a server on that machine's own loopback: its scheme, port and the rest of its address; null for any other page. */
export function loopbackTarget(url: string): LoopbackTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  return {
    protocol: u.protocol,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    rest: `${u.pathname}${u.search}${u.hash}`,
  };
}

/** The address on this Mac that reaches a loopback page of the machine once its port is forwarded to `localPort`. */
export function forwardedUrl(target: LoopbackTarget, localPort: number): string {
  return `${target.protocol}//127.0.0.1:${localPort}${target.rest}`;
}

/** The CDP modifier bits of a pointer or key event: Alt 1, Control 2, Meta 4, Shift 8. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Where a point of the shown frame is on the page, in CSS pixels; null when the frame or the page has no size yet. */
export function pagePoint(
  box: { left: number; top: number; width: number; height: number },
  at: { x: number; y: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (!(box.width > 0) || !(box.height > 0) || !(page.width > 0) || !(page.height > 0)) return null;
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
  return {
    x: Math.round(clamp(((at.x - box.left) * page.width) / box.width, page.width)),
    y: Math.round(clamp(((at.y - box.top) * page.height) / box.height, page.height)),
  };
}

const BUTTON = ['left', 'middle', 'right'] as const;

/** One pointer event on the frame as an input for the page, or null for a button the page has no use for. */
export function mouseInput(
  type: 'down' | 'up' | 'move',
  point: { x: number; y: number },
  e: { button: number; detail: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): BrowserRemoteInput | null {
  const button = BUTTON[e.button];
  if (!button) return null;
  return { kind: 'mouse', type, x: point.x, y: point.y, button, clickCount: Math.min(3, Math.max(1, e.detail)), modifiers: modifiersOf(e) };
}

/** A key event as an input: a single printable character types itself unless Control or Meta make it a shortcut. */
export function keyInput(
  type: 'down' | 'up',
  e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): BrowserRemoteInput {
  const modifiers = modifiersOf(e);
  const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey;
  return { kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, modifiers, ...(printable ? { text: e.key } : {}) };
}
