// Shared fakes for the shell-chrome tests (the sidebar nav and footer, TitleBar, SearchPalette, ProjectMenu, MoreChats): a
// selector store, Popover/Menu stand-ins, and render/click/type/press helpers. Import './dom.ts' first.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore, popoverStubs } from './stubs.ts';

/** A zustand-like store and the Popover stand-ins (tests/support/stubs.ts): items are buttons that leave
 * their menu open, menus end with a close button, and tooltips carry their label. */
export { fakeStore };
export const popoverExports = popoverStubs({ item: 'button', closeOnPick: false, closeButton: true, tooltipSpan: true });

export async function render(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    host,
    rerender: (next: any) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Lets pending promises, timers and the effects they trigger settle. */
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await flush();
}

/** The first element matching `selector` whose text contains `text`. */
export function byText(
  root: ParentNode,
  text: string,
  selector = 'button, [role=menuitem], .menu-item, .palette-item, .tb-tab',
): HTMLElement {
  const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (e.textContent ?? '').includes(text));
  if (!el) throw new Error(`no ${selector} with text ${JSON.stringify(text)}`);
  return el;
}

export function maybeText(root: ParentNode, text: string, selector = 'button, [role=menuitem], .menu-item, .palette-item, .tb-tab') {
  return [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (e.textContent ?? '').includes(text)) ?? null;
}

/** Sets a controlled input value the way a user edit does, so React's onChange fires. */
export async function type(el: Element | null, value: string) {
  if (!el) throw new Error('nothing to type into');
  const w = (globalThis as any).window;
  await act(async () => {
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await flush();
}

export async function press(el: Element | null, key: string, init: Record<string, unknown> = {}) {
  if (!el) throw new Error('nothing to press on');
  const w = (globalThis as any).window;
  await act(async () => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, ...init })));
  await flush();
}
