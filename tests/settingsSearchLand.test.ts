// A Settings search hit opens its page on the setting it matched: the route carries the word, the page scrolls to the row.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, resetCtl, defaultState, useStore, render, click, text, setValue, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('clicking a hit found by its words navigates with that word; one found by name carries none', async () => {
  useStore.setState({ route: { name: 'settings', section: 'appearance' } });
  const { host, unmount } = await render(h(Settings.Nav));
  const input = host.querySelector('.settings-search input')!;
  await setValue(input, 'queue');
  await click(host.querySelector('.sidebar-scroll .side-row')!);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'general', find: 'Follow-up behavior: Queue or Steer' }]);
  await setValue(input, 'appear');
  await click(host.querySelector('.sidebar-scroll .side-row')!);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'appearance' }]);
  await unmount();
});

test('the page opened by a hit scrolls to the matched row and flashes it; no find leaves it alone', async () => {
  const scrolled: Element[] = [];
  const scroll = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    scrolled.push(this);
  });
  try {
    useStore.setState({ route: { name: 'settings', section: 'general', find: 'Follow-up behavior: Queue or Steer' } });
    const { unmount } = await render(h(Settings, { section: 'general' }));
    await flush();
    assert.equal(scrolled.length, 1);
    assert.match(text(scrolled[0].querySelector('.settings-row-title')), /^Follow-up behavior$/);
    assert.ok(scrolled[0].classList.contains('settings-row-found'));

    // a second hit with the same word (another route) lands again
    scrolled.length = 0;
    useStore.setState({ route: { name: 'settings', section: 'general', find: 'Follow-up behavior: Queue or Steer' } });
    await flush();
    assert.equal(scrolled.length, 1);
    await unmount();

    scrolled.length = 0;
    useStore.setState({ route: { name: 'home' } });
    const plain = await render(h(Settings, { section: 'general' }));
    await flush();
    assert.equal(scrolled.length, 0);
    await plain.unmount();
  } finally {
    scroll.mock.restore();
  }
});
