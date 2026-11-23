// Shared setup for the thread component tests: a happy-dom window, a stand-in preload bridge,
// a fake app store, module auto-mocks that record their calls, and a small render helper.
// Import this before any `await import()` of a unit under test.
import { window } from './dom.ts'; // first: react-dom decides what the DOM supports when it loads
import { mock, afterEach } from 'node:test';
import { registerHooks } from 'node:module';
import { sourceExports } from './source-modules.ts';
import { STORE_SLICES, storeSliceNames, stubSlice } from './stubs.ts';
import { inspect } from 'node:util';
import { createElement, act, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { native, calls as nativeCalls } from './thread-native.ts';

export { window, native, nativeCalls };

// A failing assertion on a DOM node would otherwise print (and diff) the whole node graph.
(window.Node.prototype as any)[inspect.custom] = function (this: any) {
  return `<${this.nodeName}${this.className ? ` class="${this.className}"` : ''}>`;
};

// Vite inlines CSS imports; under node they are empty modules. mock.module tags a mocked module's
// URL with ?node-test-mock=N, which hides a .tsx extension from register.ts: hand it the plain URL
// (the mock replaces the source anyway).
registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    const [base, query] = url.split('?');
    if (query?.includes('node-test-mock') && base.startsWith('file:') && base.endsWith('.tsx')) return next(base, context);
    return next(url, context);
  },
});

const root = new URL('../../', import.meta.url);

/** The names a module exports (tests/support/source-modules.ts). */
export const exportNames = (rel: string): string[] => sourceExports(new URL(rel, root));

/** Every call made to an auto-mocked export, as [`module:name`, args]. */
export const moduleCalls: [string, any[]][] = [];
export const callsTo = (name: string) => moduleCalls.filter(([n]) => n === name).map(([, a]) => a);
/** Replace what an auto-mocked export does: `impl['store:toast'] = (...) => ...`. */
export const impl: Record<string, (...args: any[]) => any> = {};

/**
 * Mock module `rel` (from the repository root) with every export recorded under `${tag}:${name}`;
 * `overrides` supplies real values (components, constants) for the exports that need them.
 */
export function autoMock(rel: string, tag: string, overrides: Record<string, unknown> = {}) {
  const exports: Record<string, unknown> = {};
  for (const name of exportNames(rel)) {
    exports[name] =
      name in overrides
        ? overrides[name]
        : (...args: any[]) => {
            moduleCalls.push([`${tag}:${name}`, args]);
            return impl[`${tag}:${name}`]?.(...args);
          };
  }
  for (const [k, v] of Object.entries(overrides)) exports[k] = v;
  // a store slice merges with what a test's store stub already put there (stubSlice), this call's names winning
  if (rel.startsWith('src/store/')) stubSlice(rel, exports);
  else mock.module(new URL(rel, root).href, { exports } as any);
  return exports;
}

/** A component stand-in that renders its props as data attributes, so tests can see what it was given. */
export const stubComponent = (name: string) => (props: any) =>
  createElement(
    'div',
    {
      'data-stub': name,
      ...Object.fromEntries(
        Object.entries(props)
          .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
          .map(([k, v]) => [`data-${k.toLowerCase()}`, String(v)]),
      ),
    },
    props.children,
  );

/* ---------------------------------------------------------------- the store */

export const baseState = () => ({
  threads: {} as Record<string, any>,
  runtime: {} as Record<string, any>,
  chatNotes: {} as Record<string, any>,
  pending: [] as any[],
  segments: {} as Record<string, any>,
  elsewhere: {} as Record<string, any>,
  prefs: { showReasoning: true, theme: 'dark', fontSize: 14 } as Record<string, any>,
  home: '/Users/me',
  navigationBookmarks: {} as Record<string, string[]>,
  drafts: {} as Record<string, any>,
});
export let state: any = baseState();
const listeners = new Set<() => void>();
export function setStore(patch: any) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function resetStore(patch: any = {}) {
  state = { ...baseState(), ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));
export const useStore: any = (selector: (s: any) => any = (s) => s) => useSyncExternalStore(subscribe, () => selector(state));
useStore.getState = () => state;
useStore.setState = setStore;
useStore.subscribe = subscribe;

/**
 * Mock the store's slices with the fake store: every action is recorded under `store:<name>`, and the names below (and
 * `overrides`) go to the slice that owns each, under its own name there (getState is core's get).
 */
export function mockStore(overrides: Record<string, unknown> = {}) {
  autoMockStore('store', {
    useStore,
    getState: () => state,
    setState: setStore,
    ELSEWHERE_LABEL: {
      'claude-desktop': 'Claude desktop',
      'claude-cli': 'Claude Code in a terminal',
      sage: 'another MoPilot window',
      codex: 'the Codex app',
    },
    ThreadLocked: class ThreadLocked extends Error {},
    withChatNotes: (turns: any[]) => turns,
    ...overrides,
  });
}

/**
 * autoMock every store slice: each export is recorded under `<tag>:<name>`, and `names` (store names, getState for core's
 * get) stand in on the slice that owns each.
 */
export function autoMockStore(tag: string, names: Record<string, unknown>) {
  const bySlice = storeSliceNames(names);
  for (const rel of STORE_SLICES) autoMock(`src/${rel}`, tag, bySlice[rel] ?? {});
}

/* ---------------------------------------------------------------- rendering */

const mounted = new Set<{ unmount(): void }>();
// A test that failed before unmounting must not leave its view behind: it would keep timers running
// and keep re-rendering on later tests' store updates (and claim their items in module state).
afterEach(() => {
  for (const r of mounted) act(() => r.unmount());
  mounted.clear();
});

export async function render(el: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  mounted.add(r);
  await act(async () => r.render(el));
  return {
    host,
    $: (sel: string) => host.querySelector(sel) as HTMLElement | null,
    $$: (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[],
    rerender: (next: ReactElement) => act(async () => r.render(next)),
    unmount: async () => {
      mounted.delete(r);
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

/** Run `fn` inside act and let effects and promises settle. */
export const settle = (fn: () => unknown = () => {}) =>
  act(async () => {
    await fn();
  });

/** Click with a trusted-looking native event (happy-dom events are untrusted by default). */
export function trustedClick(el: Element) {
  const e = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  return act(async () => {
    el.dispatchEvent(e as any);
  });
}

export function key(target: EventTarget, type: 'keydown' | 'keyup', init: Record<string, unknown>, trusted = true) {
  const e = new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init } as any);
  if (trusted) Object.defineProperty(e, 'isTrusted', { value: true });
  return act(async () => {
    target.dispatchEvent(e as any);
  });
}
