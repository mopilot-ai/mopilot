// The browser pane's Annotate overlay, as it runs inside the page (IAB-06). `annotateOverlay` is
// injected by its source text, so it must stay self-contained: it may use only its arguments and the
// window's globals. It covers the viewport and takes every pointer event, so the page under it is
// never clicked while the user annotates. Hover highlights the element under the pointer; every click
// marks an element and every drag marks a region, adding to the marks already made. Each mark has a
// number badge (a click selects it, and the pane focuses its note) and a × that removes it. It reports
// raw facts about marked elements (src/lib/pageAnnotations.ts decides what is sent) and never reads
// the value of a password or hidden input. Escape asks the pane to leave Annotate mode.
//
// Privacy (IAB-13): main runs these scripts in an isolated world of the page (electron/capabilities/
// browser/annotate.cjs, ANNOTATE_WORLD), never in the page's own world, so the overlay's state, its
// controller and the facts it collects are not reachable from page scripts. The notes never enter the
// page at all: they are typed in the pane's Annotate bar (src/components/panels/BrowserAnnotate.tsx)
// and joined to the marks there. What the page can still observe: that an element <mopilot-annotate>
// covers the viewport (its contents sit in a closed shadow root: boxes, number badges and × controls,
// no text of the user's), the pointer and key events that reach it (capture-phase listeners on the
// window or document see them before the overlay stops them; default actions never run), and that
// its focused element was blurred when Annotate mode started.

import { labelText } from '../../shared/labelText.mjs';
import type { Rect, RawPage } from './pageAnnotations';
import { parseJson } from '../../shared/jsonRecord.mjs';

export const ANNOTATE_KEY = '__mopilotAnnotate';

export interface OverlayOptions {
  /** the window property the controller is published on (in the isolated world) */
  key: string;
  /** console prefix the pane listens for (console-message), with a per-session nonce */
  signal: string;
}

/** A mark as the pane lists it: a stable id, its current number, and what it marks. */
export interface MarkSummary {
  id: number;
  n: number;
  kind: 'element' | 'region';
  /** the element's tag, or 'region' */
  label: string;
}

export type OverlaySignal = { type: 'marks'; marks: MarkSummary[] } | { type: 'select'; id: number } | { type: 'exit' };

type AnnotationElement = HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; value?: string; href?: string };
type OverlayMark = {
  id: number;
  kind: 'element' | 'region';
  rect: Rect;
  el?: AnnotationElement;
  box: HTMLElement;
  badge: HTMLElement;
  close: HTMLElement;
};
type OverlayWindow = Window & { console: Console } & Record<string, { destroy(): void }>;

export function annotateOverlay(win: OverlayWindow, opts: OverlayOptions, joinLabels: typeof labelText = labelText) {
  const doc = win.document;
  if (win[opts.key]) win[opts.key].destroy();
  const css = (el: HTMLElement, style: Record<string, string>) => {
    for (const k of Object.keys(style)) el.style.setProperty(k, style[k], 'important');
    return el;
  };
  const make = (tag: string, style: Record<string, string>, parent?: Node) => {
    const el = css(doc.createElement(tag), style);
    if (parent) parent.appendChild(el);
    return el;
  };
  const host = make('mopilot-annotate', {
    position: 'fixed',
    inset: '0',
    'z-index': '2147483647',
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    cursor: 'crosshair',
    'pointer-events': 'auto',
  });
  const root = host.attachShadow({ mode: 'closed' });
  const layer = make('div', { position: 'absolute', inset: '0', overflow: 'hidden', 'font-family': 'system-ui, sans-serif' }, root);
  const box = { position: 'absolute', display: 'none', 'pointer-events': 'none', 'box-sizing': 'border-box', 'border-radius': '3px' };
  const hover = make('div', { ...box, outline: '2px solid #3b82f6', background: 'rgba(59,130,246,0.12)' }, layer);
  const drag = make('div', { ...box, outline: '2px dashed #f97316', background: 'rgba(249,115,22,0.10)' }, layer);
  const marks: OverlayMark[] = [];
  // a mark's badge or ×, to what a click on it does
  const controls = new Map<EventTarget | null, { id: number; action: 'select' | 'remove' }>();
  let seq = 0;
  let selected = 0;
  let capture = false;
  let start: { x: number; y: number; control?: { id: number; action: 'select' | 'remove' } } | null = null;
  let dragging = false;

  const signal = (payload: OverlaySignal) => win.console.debug(opts.signal + JSON.stringify(payload));
  const docRect = (r: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) => ({
    x: r.left + win.scrollX,
    y: r.top + win.scrollY,
    width: r.width,
    height: r.height,
  });
  const place = (el: HTMLElement, r: Rect) =>
    css(el, {
      display: 'block',
      left: `${r.x - win.scrollX}px`,
      top: `${r.y - win.scrollY}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  const hide = (el: HTMLElement) => css(el, { display: 'none' });
  // the page element under a viewport point: the overlay stops taking the pointer for the lookup
  const at = (x: number, y: number) => {
    css(host, { 'pointer-events': 'none' });
    const el = doc.elementFromPoint(x, y);
    css(host, { 'pointer-events': 'auto' });
    return el && el !== doc.documentElement && el !== doc.body ? (el as AnnotationElement) : null;
  };
  const attr = (el: HTMLElement, name: string) => el.getAttribute(name) || undefined;
  const quote = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  const unique = (name: string, v: string | undefined) => (v ? doc.querySelectorAll(`[${name}=${quote(v)}]`).length === 1 : undefined);
  const describe = (el: AnnotationElement) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(attr(el, 'type') || 'text').toLowerCase() : undefined;
    const autocomplete = attr(el, 'autocomplete');
    // a password, hidden or card field: its value and text are never read
    const secret = type === 'password' || type === 'hidden' || /password|one-time-code|(^|\s)cc-/i.test(autocomplete || '');
    const chain: {
      tag: string;
      id: string | undefined;
      idUnique: boolean | undefined;
      testId: string | undefined;
      testIdUnique: boolean | undefined;
      nth: number;
      ofType: number;
    }[] = [];
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const siblings = n.parentElement ? Array.from(n.parentElement.children).filter((s) => s.tagName === n.tagName) : [n];
      const id = n.id || undefined;
      const testId = attr(n, 'data-testid');
      chain.push({
        tag: n.tagName.toLowerCase(),
        id,
        idUnique: unique('id', id),
        testId,
        testIdUnique: unique('data-testid', testId),
        nth: siblings.indexOf(n) + 1,
        ofType: siblings.length,
      });
    }
    const named = joinLabels(
      String(attr(el, 'aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => {
          const target = doc.getElementById(id);
          return target ? target.textContent : '';
        }),
    );
    const labels = joinLabels(Array.from(el.labels || []).map((l) => l.innerText || l.textContent));
    const editable = tag === 'input' || tag === 'textarea' || tag === 'select';
    return {
      tag,
      type,
      autocomplete,
      role: attr(el, 'role'),
      ariaLabel: attr(el, 'aria-label'),
      labelledBy: named || undefined,
      label: labels || undefined,
      alt: attr(el, 'alt'),
      title: attr(el, 'title'),
      placeholder: attr(el, 'placeholder'),
      href: tag === 'a' ? attr(el, 'href') && el.href : undefined,
      text: secret || editable ? undefined : String(el.innerText || el.textContent || '').slice(0, 2000),
      value: secret || !editable ? undefined : String(el.value).slice(0, 500),
      chain,
    };
  };
  const summary = (): MarkSummary[] =>
    marks.map((m, i) => ({ id: m.id, n: i + 1, kind: m.kind, label: m.el ? m.el.tagName.toLowerCase() : 'region' }));
  const changed = () => signal({ type: 'marks', marks: summary() });
  const render = () => {
    marks.forEach((m, i) => {
      if (m.el && m.el.isConnected) m.rect = docRect(m.el.getBoundingClientRect());
      place(m.box, m.rect);
      m.badge.textContent = String(i + 1);
      css(m.box, { 'outline-width': m.id === selected && !capture ? '3px' : '2px' });
      css(m.close, { display: capture ? 'none' : 'block' });
    });
    if (capture) hide(hover);
  };
  const drop = (m: OverlayMark) => {
    m.box.remove();
    controls.delete(m.badge);
    controls.delete(m.close);
  };
  const clear = () => {
    for (const m of marks.splice(0)) drop(m);
    selected = 0;
    changed();
  };
  const remove = (id: number) => {
    const i = marks.findIndex((m) => m.id === id);
    if (i < 0) return false;
    drop(marks.splice(i, 1)[0]);
    if (selected === id) selected = 0;
    render();
    changed();
    return true;
  };
  const select = (id: number) => {
    selected = marks.some((m) => m.id === id) ? id : 0;
    render();
    return selected !== 0;
  };
  // every click or drag adds a mark: the marks already made, and their notes, stay
  const add = (input: Pick<OverlayMark, 'kind' | 'rect' | 'el'>) => {
    const mark = { ...input, id: ++seq } as OverlayMark;
    const solid = mark.kind === 'element';
    mark.box = make('div', { ...box, outline: `2px ${solid ? 'solid' : 'dashed'} #f97316`, background: 'rgba(249,115,22,0.08)' }, layer);
    const chip = {
      position: 'absolute',
      top: '-11px',
      width: '20px',
      height: '20px',
      'border-radius': '10px',
      'text-align': 'center',
      'box-shadow': '0 1px 3px rgba(0,0,0,0.4)',
      'pointer-events': 'auto',
      cursor: 'pointer',
      'user-select': 'none',
    };
    mark.badge = make(
      'div',
      { ...chip, left: '-11px', background: '#f97316', color: '#fff', font: '700 11px/20px system-ui, sans-serif' },
      mark.box,
    );
    mark.close = make(
      'div',
      { ...chip, right: '-11px', background: '#fff', color: '#111', font: '600 13px/20px system-ui, sans-serif' },
      mark.box,
    );
    mark.close.textContent = '×';
    controls.set(mark.badge, { id: mark.id, action: 'select' });
    controls.set(mark.close, { id: mark.id, action: 'remove' });
    marks.push(mark);
    render();
    changed();
  };

  const down = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 0) {
      start = { x: e.clientX, y: e.clientY, control: controls.get(e.target) };
      dragging = false;
    }
  };
  const move = (e: PointerEvent) => {
    e.stopPropagation();
    if (start) {
      dragging = dragging || Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 4;
      if (dragging) {
        hide(hover);
        place(
          drag,
          docRect({
            left: Math.min(start.x, e.clientX),
            top: Math.min(start.y, e.clientY),
            width: Math.abs(e.clientX - start.x),
            height: Math.abs(e.clientY - start.y),
          }),
        );
      }
      return;
    }
    const el = controls.has(e.target) ? null : at(e.clientX, e.clientY);
    if (el) place(hover, docRect(el.getBoundingClientRect()));
    else hide(hover);
  };
  const up = (e: PointerEvent) => {
    e.stopPropagation();
    if (!start) return;
    const s = start;
    start = null;
    hide(drag);
    if (dragging) {
      add({
        kind: 'region',
        rect: docRect({
          left: Math.min(s.x, e.clientX),
          top: Math.min(s.y, e.clientY),
          width: Math.abs(e.clientX - s.x),
          height: Math.abs(e.clientY - s.y),
        }),
      });
      return;
    }
    // a mark's number selects it (the pane focuses its note); its × removes it
    if (s.control) {
      if (s.control.action === 'remove') remove(s.control.id);
      else if (select(s.control.id)) signal({ type: 'select', id: s.control.id });
      return;
    }
    const el = at(s.x, s.y);
    if (el) add({ kind: 'element', el, rect: docRect(el.getBoundingClientRect()) });
  };
  // the rest of the mouse family never reaches the page either
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  // Escape asks the pane to leave (the pane confirms first when a mark has a note)
  const key = (e: KeyboardEvent) => {
    // an input method's Escape (cancelling a candidate in the page's field) is the page's
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    signal({ type: 'exit' });
  };
  const leave = () => hide(hover);

  const pointer: [keyof HTMLElementEventMap, EventListener][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointerleave', leave],
  ];
  for (const [type, fn] of pointer) layer.addEventListener(type, fn);
  const mouse = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  for (const type of mouse) layer.addEventListener(type, swallow);
  win.addEventListener('keydown', key, true);
  win.addEventListener('scroll', render, true);
  win.addEventListener('resize', render);

  const api = {
    count: () => marks.length,
    /** The marks with their ids; the pane adds the notes it holds. */
    collect: (): RawPage => {
      render();
      return {
        url: String(win.location.href),
        title: String(doc.title),
        scrollX: win.scrollX,
        scrollY: win.scrollY,
        width: win.innerWidth,
        height: win.innerHeight,
        marks: marks.map((m, i) => ({ id: m.id, n: i + 1, kind: m.kind, rect: m.rect, element: m.el ? describe(m.el) : null })),
      };
    },
    // capture mode: no hover box, × or selection in the screenshot; resolves once painted
    capture: (on: boolean) => {
      capture = !!on;
      render();
      return new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve(true))));
    },
    clear,
    remove,
    select,
    destroy: () => {
      for (const [type, fn] of pointer) layer.removeEventListener(type, fn);
      for (const type of mouse) layer.removeEventListener(type, swallow);
      win.removeEventListener('keydown', key, true);
      win.removeEventListener('scroll', render, true);
      win.removeEventListener('resize', render);
      host.remove();
      delete win[opts.key];
    },
  };
  Object.defineProperty(win, opts.key, { value: api, configurable: true });
  doc.documentElement.appendChild(host);
  // keys typed while annotating must not land in a page field that had focus
  const active = doc.activeElement;
  if (active && active !== doc.body) (active as HTMLElement).blur();
  changed();
  return true;
}

const call = (expr: string) => `(() => { const a = window[${JSON.stringify(ANNOTATE_KEY)}]; return a ? ${expr} : null; })()`;
const idOf = (id: number) => JSON.stringify(Number.isInteger(id) ? id : 0);

/**
 * Overlay scripts, for main to run in the page's isolated Annotate world (native.browser.annotate).
 * None of them carries a note: notes stay in the pane.
 */
export const annotateScripts = {
  install: (signal: string) =>
    `(${annotateOverlay.toString()})(window, ${JSON.stringify({ key: ANNOTATE_KEY, signal } satisfies OverlayOptions)}, ${labelText.toString()})`,
  collect: () => call('a.collect()'),
  capture: (on: boolean) => call(`a.capture(${on})`),
  clear: () => call('a.clear()'),
  unmark: (id: number) => call(`a.remove(${idOf(id)})`),
  select: (id: number) => call(`a.select(${idOf(id)})`),
  destroy: () => call('a.destroy()'),
};

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isSummary = (value: unknown): value is MarkSummary => {
  const m = value as Partial<MarkSummary> | null;
  return !!m && isId(m.id) && isId(m.n) && (m.kind === 'element' || m.kind === 'region') && typeof m.label === 'string';
};

/** The overlay's console signal, or null for any other console line. */
export function readSignal(message: unknown, signal: string): OverlaySignal | null {
  if (typeof message !== 'string' || !message.startsWith(signal)) return null;
  // a line that is not JSON is not ours
  const parsed = parseJson(message.slice(signal.length));
  const p = parsed.ok ? (parsed.value as { type?: unknown; id?: unknown; marks?: unknown } | null) : null;
  if (p?.type === 'exit') return { type: 'exit' };
  if (p?.type === 'select' && isId(p.id)) return { type: 'select', id: p.id };
  if (p?.type === 'marks' && Array.isArray(p.marks) && p.marks.every(isSummary)) {
    return { type: 'marks', marks: p.marks.map((m: MarkSummary) => ({ id: m.id, n: m.n, kind: m.kind, label: m.label.slice(0, 40) })) };
  }
  return null;
}
