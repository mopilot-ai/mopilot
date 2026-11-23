// Exit animations (src/components/ui/Presence.tsx): usePresence keeps content mounted while it leaves; Collapse animates height.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Collapse, COLLAPSE_MS, usePresence, usePresentList } = await import('../src/components/ui/Presence.tsx');

test('usePresence mounts at once, stays while leaving, then unmounts; showing again cancels the exit', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const seen: any[] = [];
    const Probe = ({ show, ms }: { show: boolean; ms?: number }) => (seen.push(usePresence(show, ms)), null);
    const root = createRoot(document.createElement('div'));
    await act(() => root.render(createElement(Probe, { show: false })));
    assert.deepEqual(seen.at(-1), { mounted: false, leaving: true });
    await act(() => root.render(createElement(Probe, { show: true })));
    assert.deepEqual(seen.at(-1), { mounted: true, leaving: false });
    await act(() => root.render(createElement(Probe, { show: false })));
    assert.deepEqual(seen.at(-1), { mounted: true, leaving: true });
    await act(async () => mock.timers.tick(100));
    await act(() => root.render(createElement(Probe, { show: true })));
    await act(async () => mock.timers.tick(100));
    assert.deepEqual(seen.at(-1), { mounted: true, leaving: false });
    await act(() => root.render(createElement(Probe, { show: false, ms: 300 })));
    await act(async () => mock.timers.tick(299));
    assert.equal(seen.at(-1).mounted, true);
    await act(async () => mock.timers.tick(1));
    assert.deepEqual(seen.at(-1), { mounted: false, leaving: true });
    await act(() => root.unmount());
  } finally {
    mock.timers.reset();
  }
});

test('Collapse opens after a frame and unmounts after closing', async () => {
  const frames: (() => void)[] = [];
  const g = globalThis as any;
  const [raf, caf] = [g.requestAnimationFrame, g.cancelAnimationFrame];
  g.requestAnimationFrame = (cb: () => void) => frames.push(cb);
  g.cancelAnimationFrame = (id: number) => {
    frames[id - 1] = () => {};
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (open: boolean) => act(() => root.render(createElement(Collapse, { open, className: 'x' } as any, 'body')));
    await render(true);
    assert.equal(host.querySelector('.collapse')!.className, 'collapse x open');
    await render(false);
    assert.equal(host.querySelector('.collapse')!.className, 'collapse x ');
    // still mounted while its height closes, gone once it has
    await act(async () => mock.timers.tick(COLLAPSE_MS - 1));
    assert.ok(host.querySelector('.collapse'));
    await act(async () => mock.timers.tick(1));
    assert.equal(host.innerHTML, '');
    await render(true);
    assert.equal(host.querySelector('.collapse')!.className, 'collapse x ');
    await act(() => frames.shift()!());
    await act(() => frames.shift()!());
    assert.equal(host.querySelector('.collapse')!.className, 'collapse x open');
    // closing before the frame runs cancels it
    await render(false);
    await render(true);
    await render(false);
    await act(async () => mock.timers.tick(COLLAPSE_MS));
    assert.equal(host.innerHTML, '');
    await act(() => root.unmount());
    const closed = createRoot(document.createElement('div'));
    await act(() => closed.render(createElement(Collapse, { open: false } as any, 'x')));
    await act(() => closed.unmount());
  } finally {
    mock.timers.reset();
    g.requestAnimationFrame = raf;
    g.cancelAnimationFrame = caf;
  }
});

test('usePresentList keeps each removed entry at its place for its own exit; one that comes back stays; 0 ms drops at once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let seen: { key: string; leaving: boolean }[] = [];
    const keyOf = (s: string) => s;
    const Probe = ({ items, ms }: { items: string[]; ms: number }) => {
      seen = usePresentList(items, keyOf, ms).map(({ key, leaving }) => ({ key, leaving }));
      return null;
    };
    const root = createRoot(document.createElement('div'));
    const show = (items: string[], ms = 200) => act(() => root.render(createElement(Probe, { items, ms })));
    const view = () => seen.map((e) => (e.leaving ? `(${e.key})` : e.key)).join(' ');
    await show(['a', 'b', 'c']);
    assert.equal(view(), 'a b c');
    await show(['a', 'c']);
    assert.equal(view(), 'a (b) c', 'b leaves where it was');
    await act(async () => mock.timers.tick(100));
    await show(['c']);
    assert.equal(view(), '(a) (b) c', 'a second removal does not cut the first one short');
    await act(async () => mock.timers.tick(100));
    assert.equal(view(), '(a) c', 'b has had its 200 ms');
    await show(['a', 'c']);
    assert.equal(view(), 'a c', 'a came back: shown as itself');
    await act(async () => mock.timers.tick(200));
    assert.equal(view(), 'a c', 'its old timer leaves it alone');
    await show(['c'], 0);
    assert.equal(view(), 'c', 'no exit time: gone at once');
    await show(['c'], 0);
    assert.equal(view(), 'c');
    await act(() => root.unmount());
  } finally {
    mock.timers.reset();
  }
});
