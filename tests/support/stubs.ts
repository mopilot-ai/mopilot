// Shared stand-ins for the app modules component tests replace most often: the store, the Popover
// primitives and the icons, plus `mockSource` to replace a module by its path. They live here so that
// renaming an export or moving a module needs one fix, not one per test.
import { readdirSync, readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { createContext, createElement as h, useCallback, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { sourceExports } from './source-modules.ts';

const root = new URL('../../', import.meta.url);

/**
 * Replace the module at `rel` (from the repository root, e.g. 'src/lib/native.ts') with `exports`. Every
 * name must be one the real module exports, so a renamed or removed export fails here, at its stub,
 * instead of stubbing a name nothing imports.
 */
export function mockSource(rel: string, exports: Record<string, unknown>) {
  const file = new URL(rel, root);
  const real = new Set(sourceExports(file));
  const unknown = Object.keys(exports).filter((name) => !real.has(name));
  if (unknown.length) throw new Error(`${rel} has no export named ${unknown.join(', ')}; update its stub`);
  return mock.module(file.href, { namedExports: exports });
}

/* ---------------------------------------------------------------- store */

/** Store names that are another layer's, which the store used to re-export: allowed in a stub, routed to no slice. */
const NOT_STORE_NAMES = new Set(['selectionAttachment', 'withChatNotes', 'turnFromServer', 'provisionalTitle']);
/** The store's old names for core's own: the store hook's getState and setState. */
const STORE_ALIASES: Record<string, string> = { getState: 'get', setState: 'set' };

/**
 * Each store name and the slice that owns it (`useStore` -> `{ rel: 'store/core.ts', own: 'useStore' }`), from the
 * slices STORE_SLICES finds: a new slice (its header says `@store-slice`) or export is found by its own file, not added here.
 */
/**
 * The store's slices, keyed from src/ (`'store/core.ts'`): the store's own files whose header says `@store-slice`. Its
 * other public modules (its session copies, split view, live actions) are not slices: a test's store stub leaves them real.
 */
export const STORE_SLICES = readdirSync(new URL('src/store/', root))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .filter((f) =>
    readFileSync(new URL(`src/store/${f}`, root), 'utf8')
      .split('\n', 3)
      .some((line) => line.includes('@store-slice')),
  )
  .sort()
  .map((f) => `store/${f}`);

const storeNames = (() => {
  const names = new Map<string, { rel: string; own: string }>();
  for (const rel of STORE_SLICES) for (const name of sourceExports(new URL(`src/${rel}`, root))) names.set(name, { rel, own: name });
  for (const [alias, own] of Object.entries(STORE_ALIASES)) names.set(alias, { rel: 'store/core.ts', own });
  return names;
})();

/**
 * Replace store names with `exports`: each goes to the slice that owns it, under its own name there, and the rest of
 * that slice throws when used, naming the export. A name no slice exports fails here (so a stub never outlives its
 * export); `__name` knobs a test keeps for its fakes to read pass through. `slices` adds a test's own slice stubs.
 */
export function stubStore(exports: Record<string, unknown>, slices: Record<string, Record<string, unknown>> = {}) {
  const unknown = Object.keys(exports).filter((name) => !storeNames.has(name) && !NOT_STORE_NAMES.has(name) && !name.startsWith('__'));
  if (unknown.length) throw new Error(`no store slice exports ${unknown.join(', ')}; update its stub`);
  for (const [rel, names] of Object.entries(storeSliceNames(exports))) stubSlice(`src/${rel}`, names);
  for (const [rel, given] of Object.entries(slices)) stubSlice(rel, given);
}

/** A store stub's names by the slice that owns each (`{ 'store/core.ts': { useStore } }`, from src/), under its own name there. */
export function storeSliceNames(exports: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(exports)) {
    const owner = storeNames.get(name);
    if (!owner) continue;
    out[owner.rel] ??= {};
    out[owner.rel][owner.own] = value;
  }
  return out;
}

/** What a stand-in for an export a test didn't stub does when used: says which one, instead of running for real. */
const notStubbed = (rel: string, name: string) => () => {
  throw new Error(`${rel}: ${name} is not stubbed`);
};

/**
 * For a kit that swaps modules itself (a path-keyed table, its own resolution hooks): each store slice a barrel stub's
 * names belong to, keyed from src/ (`'store/core.ts'`), with every export of that slice: the stubbed names in place and
 * a stand-in that throws for the rest. Merge it into the kit's own table, keeping any slice stubs the kit already has.
 */
export function storeSliceStubs(exports: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [rel, names] of Object.entries(storeSliceNames(exports))) {
    out[rel] = {};
    for (const name of sourceExports(new URL(`src/${rel}`, root))) out[rel][name] = name in names ? names[name] : notStubbed(rel, name);
  }
  return out;
}

/**
 * A kit's table of stubs keyed from src/, with its store names (under `store`) put on the slices that own them: the
 * `store` entry itself names no file.
 */
export function withStoreSlices(table: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const { store, ...out } = table;
  if (!store) return table;
  for (const [rel, all] of Object.entries(storeSliceStubs(store))) out[rel] = { ...all, ...table[rel] };
  return out;
}

/** Each stubbed store slice: the names given so far and the mock that serves them. */
const sliceStubs = new Map<string, { names: Record<string, unknown>; mock: { restore(): void } }>();

/**
 * Stub names on one of the store's slices (`'src/store/core.ts'`, from the repository root): what a component that
 * imports the slice itself, not the barrel, needs. Calls for one slice merge, in any order (a kit's, then the test's):
 * the slice is mocked once with every name given, a later call's winning. Any other export of the slice throws when
 * used, naming it, rather than running for real. A name the slice doesn't export fails here.
 */
export function stubSlice(slice: string, names: Record<string, unknown>) {
  const url = new URL(slice, root);
  const exported = sourceExports(url);
  const missing = Object.keys(names).filter((name) => !exported.includes(name));
  if (missing.length) throw new Error(`${slice} has no export named ${missing.join(', ')}; update its stub`);
  const earlier = sliceStubs.get(url.href);
  const merged = { ...earlier?.names, ...names };
  earlier?.mock.restore();
  const all: Record<string, unknown> = {};
  for (const name of exported) all[name] = name in merged ? merged[name] : notStubbed(url.pathname.split('/src/')[1], name);
  sliceStubs.set(url.href, { names: merged, mock: mock.module(url.href, { namedExports: all }) });
}

/**
 * A zustand-like store: `useStore(selector)` (with getState/setState/subscribe on it, like zustand's
 * hook), plus get/set/reset for tests. `notify` wraps listener calls, e.g. in React's act().
 */
export function fakeStore<S extends object>(initial: S, notify: (run: () => void) => void = (run) => run()) {
  let state = initial;
  const listeners = new Set<() => void>();
  const emit = () => notify(() => listeners.forEach((l) => l()));
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const getState = () => state;
  const setState = (patch: Partial<S> | ((s: S) => Partial<S>)) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    emit();
  };
  const useStore: any = (selector: (s: S) => any = (s) => s) => useSyncExternalStore(subscribe, () => selector(state));
  useStore.getState = getState;
  useStore.setState = setState;
  useStore.subscribe = subscribe;
  return {
    useStore,
    getState,
    setState,
    subscribe,
    get: getState,
    set: setState,
    reset(next: S) {
      state = next;
      emit();
    },
  };
}

/* ---------------------------------------------------------------- icons */

type Icon = (props: Record<string, unknown>) => ReactNode;
/** Every icon src/components/ui/icons.tsx exports: its own and lucide's, which it re-exports. */
export const iconNames = sourceExports(new URL('src/components/ui/icons.tsx', root)).filter((n) => /^[A-Z]/.test(n));
export const nullIcon: Icon = () => null;
/** An icon as `<i data-icon="Name">`, keeping its aria-label. */
export const taggedIcon =
  (name: string): Icon =>
  (p) =>
    h('i', { 'data-icon': name, 'aria-label': p?.['aria-label'] as string | undefined });
/**
 * Stand-ins for every export of src/components/ui/icons.tsx (`make(name)` builds each one; inert by
 * default), so a component that starts using another icon needs no test change. `overrides` replaces some.
 */
export function iconStubs(make: (name: string) => Icon = () => nullIcon, overrides: Record<string, Icon> = {}): Record<string, Icon> {
  return { ...Object.fromEntries(iconNames.map((n) => [n, make(n)])), ...overrides };
}

/* ---------------------------------------------------------------- Popover */

export type PopoverStubOptions = {
  /** MenuItem markup: a `<button>` (the default) or a `<div>`. */
  item?: 'button' | 'div';
  /** Picking a MenuItem closes its Menu, as the real one does (the default). */
  closeOnPick?: boolean;
  /** Each open Menu ends with a `[data-menu-close]` button that calls its onClose. */
  closeButton?: boolean;
  /** Tooltip renders `<span data-tooltip data-shortcut>` around its child instead of the child alone. */
  tooltipSpan?: boolean;
};

/**
 * Stand-ins for src/components/ui/Popover.tsx: a Menu or Popover renders inline only while open, a MenuItem
 * runs onSelect when clicked, a SubMenu shows its items, and useAnchor keeps real open state.
 */
export function popoverStubs({ item = 'button', closeOnPick = true, closeButton = false, tooltipSpan = false }: PopoverStubOptions = {}) {
  const MenuClose = createContext<() => void>(() => {});
  return {
    useAnchor() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      const [open, setOpen] = useState(false);
      const toggle = useCallback(() => setOpen((o) => !o), []);
      const close = useCallback(() => setOpen(false), []);
      return { ref: setAnchor, anchor, open, setOpen, toggle, close };
    },
    Popover: ({ open, children, placement }: { open: boolean; children: ReactNode; placement?: string }) =>
      open ? h('div', { 'data-popover': placement }, children) : null,
    Menu: ({
      open,
      onClose,
      children,
      placement,
      width,
    }: {
      open: boolean;
      onClose: () => void;
      children: ReactNode;
      placement?: string;
      width?: number;
    }) =>
      open
        ? h(
            MenuClose.Provider,
            { value: closeOnPick ? onClose : () => {} },
            h(
              'div',
              { role: 'menu', 'data-placement': placement, 'data-width': width },
              children,
              closeButton ? h('button', { 'data-menu-close': true, onClick: onClose }, 'close menu') : null,
            ),
          )
        : null,
    MenuItem: function MenuItem({
      children,
      onSelect,
      checked,
      danger,
      disabled,
      icon,
      shortcut,
      description,
      right,
      hint,
      title,
    }: {
      children?: ReactNode;
      onSelect?: () => void;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      icon?: ReactNode;
      shortcut?: string;
      description?: ReactNode;
      right?: ReactNode;
      hint?: ReactNode;
      title?: string;
    }) {
      const close = useContext(MenuClose);
      return h(
        item,
        {
          role: 'menuitem',
          disabled: item === 'button' ? disabled : undefined,
          'aria-checked': checked,
          'data-checked': checked === undefined ? undefined : String(checked),
          'data-danger': danger ? 'true' : undefined,
          'data-shortcut': shortcut,
          title,
          onClick: () => {
            onSelect?.();
            close();
          },
        },
        icon,
        children,
        hint ? h('span', { className: 'menu-hint' }, hint) : null,
        description ? h('span', { className: 'menu-desc' }, description) : null,
        right ? h('span', { className: 'menu-right' }, right) : null,
      );
    },
    SubMenu: ({ label, children }: { label: ReactNode; children: ReactNode }) => h('div', { 'data-submenu': label }, children),
    MenuSeparator: () => h('hr'),
    MenuLabel: ({ children }: { children: ReactNode }) => h('div', { className: 'menu-section-label' }, children),
    Tooltip: ({ label, shortcut, children }: { label?: ReactNode; shortcut?: string; children: ReactNode }) =>
      tooltipSpan ? h('span', { 'data-tooltip': typeof label === 'string' ? label : '', 'data-shortcut': shortcut }, children) : children,
  };
}

/** A fake store's side panels: open as given, with room for both at the window's width (src/lib/shellFit.ts). */
export const shellPanels = (open: { sidebarOpen?: boolean; summaryOpen?: boolean } = {}) => ({
  sidebarOpen: true,
  summaryOpen: true,
  ...open,
  shellFit: { sidebar: true, summary: true },
  shellForced: {},
});
