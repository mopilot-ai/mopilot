// The chat the thread view shows during a switch (src/lib/shownThread.ts): the old chat stays, stale, while the new
// one renders behind it, a switch that comes first replaces it, and other pages are never deferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useShownThread } = await import('../src/lib/shownThread.ts');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** A root rendering the hook for a routed chat, logging what each render showed. */
function harness() {
  const renders: string[] = [];
  const View = ({ routeId }: { routeId: string | null }) => {
    const shown = useShownThread(routeId);
    renders.push(`${shown.id}${shown.stale ? ' stale' : ''}`);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const show = (routeId: string | null) => root.render(h(View, { routeId }));
  return { renders, show, root };
}

test('a switch to another chat keeps the old one, stale, until the new one renders behind it', async () => {
  const { renders, show, root } = harness();
  await act(async () => show('a'));
  assert.deepEqual(renders, ['a']);
  renders.length = 0;
  await act(async () => show('b'));
  assert.deepEqual(renders, ['a stale', 'b']);
  act(() => root.unmount());
});

test('a switch that comes before the new chat rendered replaces it: the chat clicked past never renders', async () => {
  const { renders, show, root } = harness();
  await act(async () => show('a'));
  renders.length = 0;
  await act(async () => {
    // b's switch paints, then c's comes before b's view renders
    flushSync(() => show('b'));
    show('c');
  });
  assert.equal(renders[0], 'a stale');
  assert.equal(renders.at(-1), 'c');
  assert.ok(!renders.includes('b'), `b never renders: ${renders.join(', ')}`);
  act(() => root.unmount());
});

test('arriving from another page, or leaving for one, is not deferred', async () => {
  const { renders, show, root } = harness();
  await act(async () => show(null));
  await act(async () => show('a'));
  await act(async () => show(null));
  // (the deferred value catching up renders the same again, never a stale chat)
  assert.deepEqual(
    renders.filter((r, i) => r !== renders[i - 1]),
    ['null', 'a', 'null'],
  );
  act(() => root.unmount());
});
