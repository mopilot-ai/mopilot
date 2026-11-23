// Shared fakes for the page tests (tests/page-*.test.ts): a selector store, lightweight Popover and
// Settings primitives, and render/click/type helpers. Import './dom.ts' before this file.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore, popoverStubs } from './stubs.ts';
import { waitFor } from './waitFor.ts';

/** A zustand-like store and the Popover stand-ins (tests/support/stubs.ts): items are divs, menus end with a close button. */
export { fakeStore };
export const popoverExports = popoverStubs({ item: 'div', closeButton: true });

/** Settings primitives (Group, Row, Select, Toggle, Segmented, BinPathRow) as plain markup. */
export const settingsExports = {
  Group: ({ title, desc, action, children, id }: any) =>
    createElement(
      'section',
      { 'data-group': typeof title === 'string' ? title : '', id },
      title && createElement('h3', null, title),
      desc && createElement('p', { className: 'group-desc' }, desc),
      action,
      children,
    ),
  Row: ({ title, desc, children, onClick, mono }: any) =>
    createElement(
      'div',
      { 'data-row': typeof title === 'string' ? title : '', 'data-mono': mono ? 'true' : undefined, onClick },
      createElement('b', null, title),
      createElement('i', null, desc),
      children,
    ),
  Select: ({ value, options, onChange }: any) =>
    createElement(
      'select',
      { value, onChange: (e: any) => onChange(e.target.value) },
      options.map((o: any) => createElement('option', { key: o.value, value: o.value }, o.label)),
    ),
  Toggle: ({ on, onChange, disabled }: any) =>
    createElement('button', { role: 'switch', 'aria-checked': on, disabled, onClick: () => onChange(!on) }),
  Segmented: ({ value, options, onChange }: any) =>
    createElement(
      'span',
      { 'data-segmented': value },
      options.map((o: any) => createElement('button', { key: o.value, 'data-seg': o.value, onClick: () => onChange(o.value) }, o.label)),
    ),
  BinPathRow: ({ name, value, onChange }: any) =>
    createElement(
      'div',
      { 'data-binpath': name },
      value ?? '',
      createElement('button', { 'data-bin-set': true, onClick: () => onChange('/opt/bin/' + name) }),
      createElement('button', { 'data-bin-clear': true, onClick: () => onChange(null) }),
    ),
};

/**
 * The version row (components/harness/HarnessVersionRow.tsx) as markup that says what it was handed; its picks set
 * /opt/bin/<name> or clear it, like BinPathRow's.
 */
export const versionRowExports = {
  HarnessVersionRow: ({ kind, label, name, bin, version, manual, where, onPick, footer, managed }: any) =>
    createElement(
      'div',
      {
        'data-version-row': kind,
        'data-managed': String(!!managed),
        'data-binpath': name,
        'data-label': label,
        'data-bin': bin ?? '',
        'data-version': version ?? '',
        'data-offpath': where?.terminal ?? '',
      },
      manual ?? '',
      createElement('button', { 'data-bin-set': true, onClick: () => onPick('/opt/bin/' + name) }),
      createElement('button', { 'data-bin-clear': true, onClick: () => onPick(null) }),
      footer,
    ),
};

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

/** Lets pending promises and the effects they trigger settle. */
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Waits until `ok()` holds, polling for up to two seconds: for work a component starts on a timer. */
export async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await flush();
}

/** The first element matching `selector` whose text contains `text`. */
export function byText(root: ParentNode, text: string, selector = 'button, a, [role=menuitem], [role=radio]'): HTMLElement {
  const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (e.textContent ?? '').includes(text));
  if (!el) throw new Error(`no ${selector} with text ${JSON.stringify(text)}`);
  return el;
}

export function maybeText(root: ParentNode, text: string, selector = 'button, a, [role=menuitem], [role=radio]') {
  return [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (e.textContent ?? '').includes(text)) ?? null;
}

/** Sets a controlled input/textarea/select value the way a user edit does, so React's onChange fires. */
export async function type(el: Element | null, value: string) {
  if (!el) throw new Error('nothing to type into');
  const w = (globalThis as any).window;
  const proto =
    el.tagName === 'TEXTAREA'
      ? w.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? w.HTMLSelectElement.prototype
        : w.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new w.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
}

export async function press(el: Element | null, key: string) {
  if (!el) throw new Error('nothing to press on');
  const w = (globalThis as any).window;
  await act(async () => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true })));
  await flush();
}
