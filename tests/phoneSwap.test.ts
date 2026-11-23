// Content that replaces other content in the same place fades in over dur.base on the enter curve; the first draw does not animate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const swapPath = '../mobile/src/components/Swap';
const { Swap } = await import(swapPath);

test('a new id remounts its children under a fade-in that skips the first draw; the same id keeps them', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (id: string, text: string) => act(async () => root.render(createElement(Swap, { id }, createElement('span', null, text))));
  await show('mac', 'one');
  const first = host.querySelector('span')!;
  assert.ok(
    host.querySelector('[data-skip-entering="true"] [data-entering="FadeIn"]'),
    'the first draw does not run the entrance; later ones do',
  );
  await show('mac', 'one again');
  assert.equal(host.querySelector('span'), first, 'the same id keeps what is shown');
  await show('host', 'two');
  assert.notEqual(host.querySelector('span'), first, 'a new id replaces it');
  assert.equal(host.textContent, 'two');
  await act(async () => root.unmount());
  host.remove();
});
