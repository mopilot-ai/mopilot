// A sidebar row's PR badge reads (its chat's whole history in main, attachments, git and gh) only while the row is on
// screen: every row reading at launch made main's heap reach gigabytes on a long sidebar.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

/** A fake IntersectionObserver: the test says when an observed element is on screen. */
const observed = new Set<Element>();
let report: ((el: Element, on: boolean) => void) | null = null;
let observers = 0;
class FakeObserver {
  constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    observers++;
    report = (el, on) => callback([{ target: el, isIntersecting: on }]);
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {}
}
const realObserver = globalThis.IntersectionObserver;
(globalThis as any).IntersectionObserver = FakeObserver;

const reads: string[] = [];
let known: unknown;
installNativeStub({ peer: { referenceHistory: async () => ({}) } });
mock.module('../src/session/open.ts', { namedExports: { openLink: () => {} } });
// the real helpers, loaded under their own URL before the reader is mocked
const realModule = '../src/lib/threadPullRequest.ts?real';
const real = await import(realModule);
mock.module('../src/lib/threadPullRequest.ts', {
  namedExports: {
    createPullRequestReader: () =>
      Object.assign(async (id: string) => (reads.push(id), { url: 'https://github.com/o/r/pull/7', number: 7, state: 'open' }), {
        known: () => known,
      }),
    savedReplies: real.savedReplies,
    historyVersion: real.historyVersion,
    anyChatLoading: real.anyChatLoading,
  },
});
mock.module('../src/harness/adapters/codexApi.ts', { namedExports: { codexApi: { threadAttachments: async () => ({ data: [] }) } } });
stubStore({
  nativeOf: () => 'native',
  useStore: Object.assign((fn: any) => fn({ conn: 'ready', runtime: {} }), { getState: () => ({ home: '/h', runtime: {} }) }),
});
const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ThreadPullRequestBadge } = await import('../src/components/sidebar/ThreadPullRequestBadge.tsx');

/** A row holding the badge, as ThreadRow passes its own element. */
function Row({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return createElement('div', { ref, 'data-row': id }, createElement(ThreadPullRequestBadge, { threadId: id, updatedAt: 1, row: ref }));
}

async function mount(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(el));
  return {
    host,
    row: (id: string) => host.querySelector(`[data-row="${id}"]`)!,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a row off screen reads nothing, not even on a poll, until it comes on screen', async () => {
  reads.length = 0;
  known = undefined;
  const view = await mount(createElement('div', null, createElement(Row, { id: 'a' }), createElement(Row, { id: 'b' })));
  try {
    assert.deepEqual(reads, [], 'no row reads before the observer reports');
    assert.equal(observed.size, 2, 'every row is observed by one shared observer');
    assert.equal(observers, 1);
    await act(async () => report!(view.row('b'), false));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.deepEqual(reads, [], 'an off-screen row takes no part in the shared poll');
    await act(async () => report!(view.row('a'), true));
    assert.deepEqual(reads, ['a']);
    assert.ok(view.host.querySelector('[data-row="a"] button'), 'the row on screen shows its PR');
    assert.equal(view.host.querySelector('[data-row="b"] button'), null);
    // scrolled away and back within a minute of its answer: the row shows what it read instead of reading again
    known = { url: 'https://github.com/o/r/pull/7', number: 7, state: 'open' };
    await act(async () => report!(view.row('a'), false));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => report!(view.row('a'), true));
    assert.deepEqual(reads, ['a']);
    // back after its answer went stale: it reads again
    known = undefined;
    await act(async () => report!(view.row('a'), false));
    await act(async () => report!(view.row('a'), true));
    assert.deepEqual(reads, ['a', 'a']);
    await act(async () => report!(view.row('b'), true));
    assert.deepEqual(reads, ['a', 'a', 'b']);
  } finally {
    await view.unmount();
  }
  assert.equal(observed.size, 0, 'an unmounted row is no longer observed');
});

test('a late report for an unmounted row reads nothing', async () => {
  reads.length = 0;
  const view = await mount(createElement(Row, { id: 'gone' }));
  const el = view.row('gone');
  await view.unmount();
  await act(async () => report!(el, true));
  assert.deepEqual(reads, []);
});

test('a badge with no row, or where no IntersectionObserver exists, reads at once', async () => {
  reads.length = 0;
  known = undefined;
  const loose = await mount(createElement(ThreadPullRequestBadge, { threadId: 'loose', updatedAt: 1 }));
  assert.deepEqual(reads, ['loose']);
  await loose.unmount();
  (globalThis as any).IntersectionObserver = undefined;
  try {
    const view = await mount(createElement(Row, { id: 'noObserver' }));
    assert.deepEqual(reads, ['loose', 'noObserver']);
    await view.unmount();
  } finally {
    (globalThis as any).IntersectionObserver = realObserver;
  }
});

test('two callers watching one row each get its reports, and one leaving keeps the other watching', async () => {
  const { useOnScreen } = await import('../src/lib/onScreen.ts');
  const seen: Record<string, boolean[]> = { first: [], second: [] };
  const Watcher = ({ name, row }: { name: string; row: { current: Element | null } }) => {
    seen[name].push(useOnScreen(row));
    return null;
  };
  const row = { current: document.createElement('div') as Element };
  document.body.append(row.current!);
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    const watchers = (...names: string[]) =>
      createElement('div', null, ...names.map((name) => createElement(Watcher, { key: name, name, row })));
    await act(async () => root.render(watchers('first')));
    await act(async () => report!(row.current!, true));
    assert.equal(seen.first.at(-1), true);
    // a second caller on the same row starts from the observer's last report: observing again reports nothing
    await act(async () => root.render(watchers('first', 'second')));
    assert.equal(seen.second.at(-1), true);
    await act(async () => root.render(watchers('second')));
    assert.ok(observed.has(row.current!), 'the remaining caller keeps the row observed');
    await act(async () => report!(row.current!, false));
    assert.equal(seen.second.at(-1), false);
  } finally {
    await act(async () => root.unmount());
    row.current!.remove();
  }
  assert.equal(observed.has(row.current!), false);
});
