// Shared fixture for the PR rows' UI tests: a fake monitor api, store, clipboard and Popover, and row helpers.
import { mock } from 'node:test';
import './dom.ts';
import { fakeStore } from './shell-panels-kit.ts';
export { settle } from './shell-panels-kit.ts';
import { popoverStubs, stubStore } from './stubs.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PrCreateResult, PrDraft, PrMergeResult, PrMonitorState } from '../../src/lib/native/prMonitor.ts';
import { installNativeStub } from './ports/native.ts';
export { deferred } from './async-scenarios.ts';

export const url = 'https://github.com/o/r/pull/12';
/** What the fake monitor holds and who listens: tests set `fx.stored` and fire `listener`. */
export const fx: { stored: PrMonitorState | null; listener: (id: string) => void; unsubscribed: number } = {
  stored: null,
  listener: () => {},
  unsubscribed: 0,
};
export const calls: unknown[][] = [];
export const api = {
  stackCandidates: async () => [],
  stack: async () => {},
  // the create form and the Merge item have their own suites (tests/prCreateForm.test.ts, tests/prMergeUI.test.ts)
  createDraft: async (): Promise<PrDraft> => ({ status: 'refused', reason: 'unused', text: 'unused' }),
  create: async (): Promise<PrCreateResult> => ({ status: 'refused', reason: 'unused', text: 'unused' }),
  merge: async (): Promise<PrMergeResult> => ({ status: 'refused', reason: 'unused', text: 'unused' }),
  snapshot: async (_id: string): Promise<PrMonitorState | null> => fx.stored,
  configure: async (id: string, patch: any) => {
    calls.push([id, patch]);
    fx.stored = { chatId: id, url, autoFix: false, addressComments: false, uncertain: false, limited: false, ...fx.stored, ...patch };
    return fx.stored!;
  },
  refresh: async (id: string) => {
    calls.push(['refresh', id]);
    return fx.stored;
  },
  onChanged: (fn: (id: string) => void) => {
    fx.listener = fn;
    return () => {
      fx.unsubscribed++;
    };
  },
};
export const store = fakeStore({});
stubStore(store.exports);
export const clipboard = {
  fail: false,
  write: async (t: string) => {
    calls.push(['copy', t]);
    if (clipboard.fail) throw new Error('denied');
  },
};
installNativeStub({ prMonitor: api, clipboard });
mock.module('../../src/session/open.ts', { namedExports: { openLink: (link: string) => calls.push(['openLink', link]) } });
mock.module('../../src/components/ui/Popover.tsx', { namedExports: popoverStubs({ item: 'button' }) });
export const { PrMonitorRows, prChecks, prRows, VISIBLE_ROWS } = await import('../../src/components/thread/PrMonitor.tsx');
export const { usePrMonitor, prNumber } = await import('../../src/components/thread/usePrMonitor.ts');
/** The rows over their own monitor read, as the Changes card gives them one. */
export function PrMonitorControls({ chatId, api, open }: { chatId: string; api: any; open: (url: string) => void }) {
  return h(PrMonitorRows, { chatId, api, open, monitor: usePrMonitor(chatId, api) });
}
await import('../../src/lib/native/prMonitor.ts');
export const { markWindowReady, resetWindowReady } = await import('../../src/lib/windowReady.ts');
// boot has told main this window is ready, as in a window that finished starting
markWindowReady();

export const base = (extra: Partial<PrMonitorState> = {}): PrMonitorState => ({
  chatId: 'chat',
  url,
  autoFix: false,
  addressComments: false,
  uncertain: false,
  limited: false,
  ...extra,
});
export const pr = (extra: Partial<NonNullable<PrMonitorState['pr']>> = {}) => ({
  title: 'Fix CI',
  state: 'OPEN',
  failed: 0,
  pending: 0,
  headRefName: 'feature/child',
  baseRefName: 'feature/parent',
  ...extra,
});
export async function mount(custom: any = api) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(PrMonitorControls, { chatId: 'chat', api: custom, open: (u: string) => calls.push(['open', u]) })));
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
export const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
// the rows' classes are a CSS Module's (hashed in the app), so their parts are found by role, label and data attribute
export const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('ul[aria-label="Pull requests"] > li')];
export const earlierRows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('ul[aria-label="Earlier pull requests"] > li')];
export const rowLink = (row: Element) => row.querySelector<HTMLButtonElement>('button[aria-label^="Open pull request"]')!;
export const rowText = (row: Element) => rowLink(row).textContent;
export const ci = (row: Element) => row.querySelector<HTMLElement>('[aria-label^="CI: "]');
/** A row's state icon's state: `open`, `merged` or `closed`. */
export const rowState = (row: Element) => row.querySelector<HTMLElement>('svg[data-state]')?.dataset.state;
/** The "N earlier pull requests" fold, if there is one. */
export const earlierButton = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => / earlier pull /.test(b.textContent!));
/** The "Show N more" / "Show less" button, if the stack folds. */
export const moreRows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => /^Show (\d+ more|less)$/.test(b.textContent!));
/** The note under the rows (in the card, not the stack picker's): the monitor's news (`status`) or its error (`alert`). */
export const note = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[aria-label="Pull request controls"] > div > :is([role="status"], [role="alert"])');
export async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  });
}
export const parent = (n: number, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: `Parent ${n}`,
  state: 'OPEN',
  failed: 0,
  pending: 0,
  headRefName: `p${n}`,
  baseRefName: `p${n + 1}`,
  ...extra,
});
export const menuItem = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
export async function openMenu(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More PR options"]')!.click());
}
/** The tracked PR's Auto-fix item, in its ⋯ menu as Claude Desktop keeps it: opens the menu and returns the item. */
export async function autoFixItem(host: HTMLElement) {
  if (!menuItem(host, 'Auto-fix')) await openMenu(host);
  return menuItem(host, 'Auto-fix')!;
}
