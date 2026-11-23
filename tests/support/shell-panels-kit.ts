// Shared fakes for the side/bottom pane tests: a tiny external store standing in for the zustand
// store, a recording `native` bridge, and light stand-ins for Popover/Markdown/DiffView.
// Import after './dom.ts' and BEFORE any mock.module call.
import { registerHooks } from 'node:module';
import { afterEach } from 'node:test';
import { act, createElement, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { popoverStubs } from './stubs.ts';

// mock.module tags a mocked module's URL with ?node-test-mock=N, which hides the .tsx extension from
// tests/support/register.ts; hand it the plain URL so a mocked .tsx still loads (its exports are replaced).
registerHooks({
  load(url, context, next) {
    const u = new URL(url);
    if (u.protocol === 'file:' && u.pathname.endsWith('.tsx') && u.searchParams.has('node-test-mock'))
      return next(url.split('?')[0], context);
    // a stylesheet import (xterm.css) is an empty module here
    if (u.protocol === 'file:' && u.pathname.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});

export type Calls = unknown[][];

/** An external store with the store module's surface the panels use; every action is recorded. */
export function fakeStore(initial: Record<string, any>) {
  // the window's room for its side panels (src/lib/shellFit.ts): both fit unless a test says otherwise
  let state: Record<string, any> = { shellFit: { sidebar: true, summary: true }, shellForced: {}, ...initial };
  const listeners = new Set<() => void>();
  const calls: Calls = [];
  const emit = () => listeners.forEach((cb) => cb());
  const set = (patch: any) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    emit();
  };
  const useStore: any = (selector: (s: any) => any) =>
    useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      () => selector(state),
    );
  useStore.getState = () => state;
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const exports = {
    useStore,
    setState: (patch: any) => {
      calls.push(['setState', typeof patch === 'function' ? 'fn' : patch]);
      set(patch);
    },
    toast: record('toast'),
    toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
    setPrefs: (p: any) => {
      calls.push(['setPrefs', p]);
      set((s: any) => ({ prefs: { ...s.prefs, ...p } }));
    },
    openChanges: record('openChanges'),
    giveBackToComposer: record('giveBackToComposer'),
    // a chat's stored draft (src/session/composerAttach.ts adds to it when no composer is open)
    getState: () => state,
    setDraft: (key: string, draft: any) => {
      calls.push(['setDraft', key, draft]);
      set((s: any) => ({ drafts: { ...s.drafts, [key]: draft } }));
    },
    // the Changes pane's review findings (src/components/panels/useFindingNotes.tsx)
    askFixes: record('askFixes'),
    answerReviewComments: record('answerReviewComments'),
    dismissFinding: record('dismissFinding'),
    focusFinding: record('focusFinding'),
    closeFindingsWalk: record('closeFindingsWalk'),
    rerunReview: record('rerunReview'),
    setUnanchored: record('setUnanchored'),
    // as src/store/reviews.ts does it, so the pane reads the walk's new scope
    widenFindingsWalk: () => {
      calls.push(['widenFindingsWalk']);
      set((s: any) => ({ diffPanel: { ...s.diffPanel, scope: 'branch', walk: { ...s.diffPanel.walk, settled: true } } }));
    },
    chatFamily: () => (exports.__basic ? 'acp' : exports.__harness),
    chatBasicHarness: () => exports.__basic,
    chatHarnessLabel: () => 'Claude Code',
    __harness: 'claude' as string,
    __basic: null as string | null,
    openPaneTab: record('openPaneTab'),
    openSideChat: record('openSideChat'),
    openSubThread: record('openSubThread'),
    closePaneTab: record('closePaneTab'),
    listBackgroundTerminals: async (_id: string) => exports.__terminals,
    terminateBackgroundTerminal: async (id: string, pid: string) => {
      calls.push(['terminate', id, pid]);
      return exports.__terminateOk;
    },
    __terminals: [] as any[],
    __terminateOk: true,
  };
  return { exports, calls, set, get: () => state };
}

/** Popover stand-ins (tests/support/stubs.ts): menus render inline while open and close after a pick; items are divs. */
export const popoverStub = popoverStubs({ item: 'div' });

/** Markdown stand-ins; `dark` is read at render time. */
export function markdownStub(theme: { dark: boolean }) {
  return {
    Markdown: ({ text, cwd }: { text: string; cwd?: string }) => createElement('div', { 'data-markdown': cwd }, text),
    CodeBlock: ({ code, lang }: { code: string; lang: string }) => createElement('pre', { 'data-lang': lang }, code),
    useResolvedDark: () => theme.dark,
  };
}

export async function settle(act: (fn: () => Promise<void> | void) => Promise<void>, ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Elements matching `selector` whose text includes `text`. */
export function byText(root: ParentNode, selector: string, text: string) {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((e) => (e.textContent ?? '').includes(text));
}

export function one(root: ParentNode, selector: string, text?: string) {
  const list = text == null ? [...root.querySelectorAll<HTMLElement>(selector)] : byText(root, selector, text);
  if (!list.length) throw new Error(`no ${selector}${text == null ? '' : ` with "${text}"`}`);
  return list[0];
}

/** Set a controlled input's value the way React notices. */
export function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new (globalThis as any).window.Event('input', { bubbles: true }));
}

const mounted = new Set<Root>();
/** Render into a fresh host; every root still mounted is unmounted after each test, so a failed
 * assertion never leaves an interval or listener running. */
export async function render(el: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.add(root);
  await act(async () => root.render(el));
  return {
    host,
    root,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
    unmount: async () => {
      mounted.delete(root);
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
afterEach(async () => {
  for (const root of mounted) await act(async () => root.unmount());
  mounted.clear();
});
