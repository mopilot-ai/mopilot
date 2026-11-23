// Shared fakes for the harness Settings/Plugins page tests: a selector store, plain stand-ins for the
// Settings primitives, and a render helper. Import after './dom.ts'.
import { createElement as h, act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore as sharedFakeStore, iconStubs, nullIcon, popoverStubs as makePopoverStubs } from './stubs.ts';

/** A selector store (tests/support/stubs.ts) whose updates run inside act(). */
export const fakeStore = <S extends object>(initial: S) => sharedFakeStore(initial, (run) => act(run));

const text = (v: ReactNode) => v ?? null;

/** Stand-ins for the Settings primitives: titles and descriptions as plain text, controls as native elements. */
export const settingsStubs = {
  Group: ({ title, desc, action, children }: any) =>
    h(
      'section',
      { className: 'group' },
      title != null ? h('h3', null, text(title)) : null,
      desc != null ? h('p', { className: 'gdesc' }, text(desc)) : null,
      action || null,
      children,
    ),
  Row: ({ title, desc, children, onClick }: any) =>
    h('div', { className: 'row', onClick }, h('b', null, text(title)), desc != null ? h('i', null, text(desc)) : null, children),
  Select: ({ value, options, onChange }: any) =>
    h(
      'select',
      { value, onChange: (e: any) => onChange(e.target.value === '__null' ? null : e.target.value) },
      options.map((o: any) => h('option', { key: String(o.value), value: o.value ?? '__null' }, o.label)),
    ),
  Toggle: ({ on, onChange, disabled }: any) => h('button', { role: 'switch', 'aria-checked': on, disabled, onClick: () => onChange(!on) }),
  Segmented: ({ value, options, onChange }: any) =>
    h(
      'div',
      { className: 'seg' },
      options.map((o: any) =>
        h('button', { key: o.value, 'data-seg': o.value, 'aria-pressed': o.value === value, onClick: () => onChange(o.value) }, o.label),
      ),
    ),
  BinPathRow: ({ name, value, onChange }: any) =>
    h('input', { 'aria-label': `${name} path`, defaultValue: value ?? '', onBlur: (e: any) => onChange(e.target.value || null) }),
};

export { nullIcon, iconStubs };

export async function mount(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    host,
    render: (next: any) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Let pending promises (and the renders they trigger) settle. */
export const flush = (n = 3) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  });

export const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error('nothing to click');
    (el as HTMLElement).click();
  });

/** Set a controlled input/textarea/select value the way React notices. */
export async function change(el: Element | null | undefined, value: string) {
  if (!el) throw new Error('nothing to change');
  await act(async () => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : ((el as any).value = value);
    el.dispatchEvent(new (window as any).Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

export const byText = (root: ParentNode, sel: string, t: string | RegExp) =>
  [...root.querySelectorAll(sel)].find((e) => (typeof t === 'string' ? e.textContent?.trim() === t : t.test(e.textContent ?? ''))) as
    | HTMLElement
    | undefined;

export const rows = (root: ParentNode) => [...root.querySelectorAll('.row > b')].map((b) => b.textContent);

/** Stand-ins for ../components/Popover (tests/support/stubs.ts): items are buttons; choosing one closes the menu. */
export const popoverStubs = makePopoverStubs();

/** Call a rendered element's React onClick directly, as a click the browser would not deliver (a disabled button). */
export function reactProps(el: Element): any {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return key ? (el as any)[key] : undefined;
}
