// The sidebar availability reader owns coalescing, timeouts, changed paths and periodic/focus recovery.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, StrictMode, act } from 'react';
import { fx, reset, render, flush, named } from './support/shell-sidebar-kit.ts';
import { useFolderAvailability, FOLDER_RECHECK_MS, FOLDER_READ_TIMEOUT_MS } from '../src/components/sidebar/useFolderAvailability.ts';
import { pollKeyCount } from '../src/lib/visiblePoll.ts';

const deferred = () => {
  let resolve!: (value: Record<string, boolean | null>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, boolean | null>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const focus = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
const tick = (ms: number) => act(async () => mock.timers.tick(ms));

async function mount(paths: string[], strict = false) {
  let answer: ReturnType<typeof useFolderAvailability> = {};
  function Probe({ paths }: { paths: string[] }) {
    answer = useFolderAvailability(paths);
    return null;
  }
  const el = (p: string[]) => (strict ? h(StrictMode, null, h(Probe, { paths: p })) : h(Probe, { paths: p }));
  const view = await render(el(paths));
  return { view, get: () => answer, change: (p: string[]) => act(async () => view.root.render(el(p))) };
}

test('the shared poll rechecks hidden candidates and wakes on focus, without replacing unchanged answers', async () => {
  reset();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const paths = ['/one', '/two'];
  let result: Record<string, boolean | null> = { '/one': false, '/two': true };
  fx.folderAvailability = async () => result;
  const p = await mount([...paths, '/one', '']);
  try {
    assert.deepEqual(named('folderAvailability'), [[paths]]);
    const original = p.get();
    await tick(FOLDER_RECHECK_MS - 1);
    assert.equal(named('folderAvailability').length, 1);
    await tick(1);
    assert.equal(named('folderAvailability').length, 2);
    assert.equal(p.get(), original);
    result = { '/one': true, '/two': false };
    await focus();
    assert.deepEqual(p.get(), result);
    await p.change(['/two', '/one']);
    assert.equal(named('folderAvailability').length, 3, 'reordering the same paths does not restart polling');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(FOLDER_RECHECK_MS);
    assert.equal(named('folderAvailability').length, 3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(named('folderAvailability').length, 4);
  } finally {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await p.view.unmount();
    mock.timers.reset();
  }
  assert.equal(pollKeyCount(), 0);
});

test('unknown, malformed and rejected reads preserve decisions and remain retryable', async () => {
  reset();
  const pending = deferred();
  fx.folderAvailability = () => pending.promise;
  const p = await mount(['/a']);
  try {
    assert.equal(p.get()['/a'], undefined, 'pending first read is not missing');
    await focus();
    assert.equal(named('folderAvailability').length, 1, 'equivalent concurrent requests coalesce');
    await act(async () => pending.resolve({ '/a': null }));
    assert.equal(p.get()['/a'], undefined);
    fx.folderAvailability = async () => ({ '/a': false });
    await focus();
    for (const bad of [null, [], {}, { '/a': 'false' }, { '/a': null }]) {
      fx.folderAvailability = async () => bad as any;
      await focus();
      assert.equal(p.get()['/a'], false);
    }
    fx.folderAvailability = async () => {
      throw new Error('IPC unavailable');
    };
    await focus();
    assert.equal(p.get()['/a'], false);
    fx.folderAvailability = async () => ({ '/a': true, extra: null });
    await focus();
    assert.deepEqual(p.get(), { '/a': true });
  } finally {
    await p.view.unmount();
  }
});

test('one thousand candidates share a deduplicated batch and unchanged polls preserve the published snapshot', async () => {
  reset();
  const paths = Array.from({ length: 1000 }, (_, n) => `/work/folder-${n}`);
  fx.folderAvailability = async (asked) => Object.fromEntries(asked.map((p) => [p, true]));
  const started = performance.now();
  const p = await mount([...paths, ...paths]);
  try {
    const original = p.get();
    for (let n = 0; n < 10; n++) {
      await focus();
      assert.equal(p.get(), original);
    }
    assert.equal(named('folderAvailability').length, 11);
    assert.ok(named('folderAvailability').every(([asked]) => asked.length === 1000));
    console.log(`sidebar availability: 1000 folders, mount + 10 unchanged refreshes, ${(performance.now() - started).toFixed(1)}ms`);
  } finally {
    await p.view.unmount();
  }
});

for (const rejects of [false, true])
  test(`changed paths retire old ${rejects ? 'failures' : 'successes'} while the replacement is pending`, async () => {
    reset();
    const old = deferred();
    const replacement = deferred();
    fx.folderAvailability = (paths) => (paths.includes('/old') ? old.promise : replacement.promise);
    const p = await mount(['/old']);
    try {
      await p.change(['/new']);
      await act(async () => (rejects ? old.reject(new Error('old read')) : old.resolve({ '/old': false })));
      assert.equal(p.get()['/new'], undefined);
      await focus();
      assert.equal(named('folderAvailability').length, 2, 'old finally cannot clear the pending replacement');
      await act(async () => replacement.resolve({ '/new': true }));
      assert.deepEqual(p.get(), { '/new': true });
    } finally {
      await p.view.unmount();
    }
  });

test('a timed-out read cannot replace its retry or clear the retry timeout', async () => {
  reset();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const old = deferred();
  const fresh = deferred();
  fx.folderAvailability = () => old.promise;
  const p = await mount(['/same']);
  try {
    await tick(FOLDER_READ_TIMEOUT_MS);
    fx.folderAvailability = () => fresh.promise;
    await focus();
    await act(async () => old.resolve({ '/same': false }));
    assert.equal(p.get()['/same'], undefined);
    await focus();
    assert.equal(named('folderAvailability').length, 2);
    await tick(FOLDER_READ_TIMEOUT_MS);
    fx.folderAvailability = async () => ({ '/same': true });
    await focus();
    await act(async () => fresh.reject(new Error('late rejection')));
    assert.equal(p.get()['/same'], true);
  } finally {
    await p.view.unmount();
    mock.timers.reset();
  }
});

test('Strict Mode, empty candidates and disposal retire pending reads and leave no scheduler behind', async () => {
  reset();
  const pending: ReturnType<typeof deferred>[] = [];
  fx.folderAvailability = () => {
    const p = deferred();
    pending.push(p);
    return p.promise;
  };
  const p = await mount(['/same'], true);
  assert.equal(pending.length, 2);
  await act(async () => pending[1].resolve({ '/same': true }));
  await act(async () => pending[0].resolve({ '/same': false }));
  assert.equal(p.get()['/same'], true);
  await p.change([]);
  assert.equal(pollKeyCount(), 0);
  await p.change(['/next']);
  await p.view.unmount();
  await act(async () => pending[2].reject(new Error('disposed')));
  await focus();
  await flush();
  assert.equal(pending.length, 3);
  assert.equal(pollKeyCount(), 0);
});
