// The live-label motion every agent surface uses: useMinDwell (src/lib/minDwell.ts, Claude Desktop's 650 ms label
// dwell with a fall hold back to the summary) and MorphText (src/components/ui/MorphText.tsx, the 180 ms crossfade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement, act } from 'react';

const { createRoot } = await import('react-dom/client');
const { useMinDwell } = await import('../src/lib/minDwell.ts');
const { MorphText, MORPH_MS } = await import('../src/components/ui/MorphText.tsx');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  return { host, root };
}

/**
 * useMinDwell's timers and its performance.now() on one mocked clock, well past start as on a running app: real dwells
 * of 30-40 ms can pass between two renders on a busy machine and show a label early.
 */
function clock(t: any) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.mock.method(performance, 'now', () => Date.now());
}

test('useMinDwell keeps each label up for its minimum and holds before returning to rest', async (t) => {
  clock(t);
  const { host, root } = mount();
  const Probe = ({ v, reset, adv }: { v: string; reset?: string; adv?: boolean }) =>
    createElement('i', null, useMinDwell(v, 40, { restKey: 'settled', fallHoldMs: 40, isAdvance: adv ? () => true : undefined }, reset));
  const render = (v: string, reset?: string, adv?: boolean) => act(() => root.render(createElement(Probe, { v, reset, adv })));
  const text = () => host.textContent;
  await render('settled');
  // leaving rest is immediate
  await render('a');
  assert.equal(text(), 'a');
  // a new label waits for the shown one's dwell
  await render('b');
  assert.equal(text(), 'a');
  await act(async () => t.mock.timers.tick(60));
  assert.equal(text(), 'b');
  // an advance shows at once
  await render('c', undefined, true);
  assert.equal(text(), 'c');
  // back to rest waits the dwell and the fall hold
  await render('settled');
  assert.equal(text(), 'c');
  await act(async () => t.mock.timers.tick(70));
  assert.equal(text(), 'settled');
  // a new reset key shows the value at once
  await render('d', 'k2');
  await render('e', 'k3');
  assert.equal(text(), 'e');
  // a change that already waited its dwell shows on the next effect
  await act(async () => t.mock.timers.tick(60));
  await render('f', 'k3');
  assert.equal(text(), 'f');
  // a change superseded before its timer fires is cancelled cleanly
  await render('g', 'k3');
  await render('f', 'k3');
  assert.equal(text(), 'f');
  await act(() => root.unmount());
});

test('useMinDwell without options still dwells (the mounted value counts as long shown, as in Claude Desktop)', async (t) => {
  clock(t);
  const { host, root } = mount();
  const Probe = ({ v }: { v: string }) => createElement('i', null, useMinDwell(v, 30));
  await act(() => root.render(createElement(Probe, { v: 'a' })));
  await act(() => root.render(createElement(Probe, { v: 'b' })));
  assert.equal(host.textContent, 'b');
  await act(() => root.render(createElement(Probe, { v: 'c' })));
  assert.equal(host.textContent, 'b');
  await act(async () => t.mock.timers.tick(50));
  assert.equal(host.textContent, 'c');
  await act(() => root.unmount());
});

test('MorphText crossfades on a key change and updates in place otherwise', async () => {
  const { host, root } = mount();
  const render = (k: string, t: string) => act(() => root.render(createElement(MorphText, { morphKey: k, className: 'x', children: t })));
  await render('a', 'Alpha');
  const box = () => host.querySelector('.morph-text') as any;
  assert.equal(box().className, 'morph-text x');
  assert.equal(host.querySelectorAll('.morph-layer').length, 1);
  assert.equal(host.querySelector('.morph-enter'), null);
  await render('a', 'Alpha 2');
  assert.equal(host.textContent, 'Alpha 2');
  await render('b', 'Beta');
  assert.ok(host.querySelector('.morph-out'));
  assert.equal(host.querySelector('.morph-out')!.getAttribute('aria-hidden'), 'true');
  assert.ok(host.querySelector('.morph-enter'));
  assert.ok(box().style.width !== undefined);
  await act(() => sleep(MORPH_MS + 30));
  assert.equal(host.querySelector('.morph-out'), null);
  assert.equal(host.querySelector('.morph-enter'), null);
  assert.equal(box().getAttribute('style'), null);
  assert.equal(host.textContent, 'Beta');
  // a change mid-animation restarts it cleanly
  await render('c', 'Gamma');
  await render('d', 'Delta');
  await act(() => root.unmount());
});
