// Shared helpers for the composer package's component tests: a selector store, render/settle helpers and
// DOM event shorthands. Import after './dom.ts'.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore } from './stubs.ts';

// node:test's mock.module can't stand in for a .tsx module (it asks the default loader for the original's
// format), so .tsx stand-ins are served by a resolve hook instead. Register them before importing the unit.
const stubs = new Map<string, Record<string, any>>();
(globalThis as any).__composerStubs = stubs;
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    const s = stubs.get(r.url);
    if (!s) return r;
    const key = JSON.stringify(r.url);
    const code =
      `const m=globalThis.__composerStubs.get(${key});` +
      Object.keys(s)
        .map((n) => `export const ${n}=m[${JSON.stringify(n)}];`)
        .join('');
    return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
  },
});
/** Replace the .tsx module at `url` (an absolute file URL) with these named exports. */
export function mockTsx(url: string | URL, exports: Record<string, any>) {
  // a stand-in for a file that moved or never existed replaces nothing, and the real module loads in its place
  if (!existsSync(new URL(url))) throw new Error(`${url} does not exist; update its stub`);
  stubs.set(String(url), exports);
}

export { fakeStore };

export async function mount(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    host,
    renderInsideAct: (el: any) => root.render(el),
    render: (next: any) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Let pending promises and timers of `ms` (and the renders they trigger) settle. */
export const flush = (ms = 0, n = 3) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, ms));
  });

export const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement;
export const $$ = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];

export const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error('nothing to click');
    (el as HTMLElement).click();
  });

export const fire = (el: Element | Window | Document, ev: Event) => act(async () => void el.dispatchEvent(ev));

export const mouse = (el: Element, type: string, init: Record<string, any> = {}) =>
  fire(el, new (window as any).MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

export const key = (el: Element | Window | Document, k: string, init: Record<string, any> = {}) =>
  fire(el, new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

/** An element whose box is `r` (left/top/width/height). */
export function setRect(el: Element, r: { left?: number; top?: number; width?: number; height?: number }) {
  const left = r.left ?? 0,
    top = r.top ?? 0,
    width = r.width ?? 0,
    height = r.height ?? 0;
  (el as any).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
}

/** Text content of all matching elements. */
export const texts = (sel: string, root: ParentNode = document) => $$(sel, root).map((e) => e.textContent);
