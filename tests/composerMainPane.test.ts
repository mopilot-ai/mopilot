// With split view, only the focused pane's composer is the main one (data-composer-main), which untargeted composer
// events go to (tests/splitViewInvariants.test.ts checks their listeners); a composer inside a pane never is.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { act } = await import('react');
const { mountComposer, reset, store } = await import('./support/composer-setup.ts');

beforeEach(() => reset());

const mainOf = (host: HTMLElement) => host.querySelector('.composer-wrap')!.getAttribute('data-composer-main');

test('a composer is the main one only while its pane is focused', async () => {
  store.set({ route: { name: 'thread', id: 'a' }, split: { panes: [{ chatId: 'b' }], focus: 'primary' } });
  const primary = await mountComposer({ threadId: 'a' });
  const pane = await mountComposer({ threadId: 'b', inPane: true });
  assert.equal(mainOf(primary.host), 'true');
  assert.equal(mainOf(pane.host), 'false', "a pane's composer is never the main one");
  // the other pane takes focus: the primary composer stops being the main one
  await act(async () => store.set((s: any) => ({ split: { ...s.split, focus: 'b' } })));
  assert.equal(mainOf(primary.host), 'false');
  assert.equal(mainOf(pane.host), 'false');
  await pane.unmount();
  await primary.unmount();
});

test('without split panes the one composer is the main one', async () => {
  store.set({ route: { name: 'thread', id: 'a' }, split: null });
  const only = await mountComposer({ threadId: 'a' });
  assert.equal(mainOf(only.host), 'true');
  await only.unmount();
});
