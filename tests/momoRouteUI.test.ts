// MoMo's page slot (src/components/momo/MomoRoute.tsx, MomoPage.tsx) and the renderer's view of the gate (src/lib/momo.ts): nothing until main says the account was invited, a lazily loaded page showing Chat or Memory, and back to a new chat when main says no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
const h = createElement;
import { fakeStore, render, flush, press } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

// setup was finished: the page itself (tests/momoSetupUI.test.ts has setup)
const DONE = { momo: { onboarding: { done: true, step: 0 } } };
const store = fakeStore<any>({ route: { name: 'home' }, back: [], forward: [], prefs: DONE });
stubStore({
  useStore: store.useStore,
  navigate: (route: any) => store.setState({ route, back: [...store.getState().back, store.getState().route] }),
  getState: () => store.getState(),
  setState: (p: any) => store.setState(p),
  toast: () => {},
});
let pushMomo: (allowed: boolean) => void = () => {};
let reads = 0;
installNativeStub({
  momo: {
    // main is not ready yet: the first read fails, and its later push decides
    access: async () => {
      reads++;
      throw new Error('main not ready');
    },
    onAccess: (cb: (allowed: boolean) => void) => {
      pushMomo = cb;
      return () => {};
    },
  },
});

mockSource('src/components/momo/setup/MomoSetup.tsx', { MomoSetup: () => null });
// MoMo's tabs have their own tests (tests/momoPageUI.test.ts and each tab's)
mockSource('src/components/momo/MomoChatTab.tsx', {
  MomoChatTab: ({ chatId }: any) => h('div', { role: 'tabpanel' }, `chat ${chatId ?? 'main'}`),
});
mockSource('src/components/momo/MemoryTab.tsx', { MemoryTab: () => h('div', { role: 'tabpanel' }, 'memory') });
const { momoAllowedNow } = await import('../src/lib/momo.ts');
const { MomoRoute } = await import('../src/components/momo/MomoRoute.tsx');
// the routes are types alone: loading them is all a test can do (the momo route is exercised below)
await import('../src/store/route.ts');
const App = () => createElement(MomoRoute, { route: store.useStore((s: any) => s.route) });
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

test('MoMo’s page: hidden until main answers, loaded once invited, its views, ⌘., and home again when revoked', async () => {
  store.reset({ route: { name: 'momo' }, back: [], forward: [], prefs: DONE });
  const { host, unmount } = await render(createElement(App));
  await settle();
  assert.equal(reads, 1);
  assert.equal(host.innerHTML, '', 'no answer yet: nothing, and no redirect');
  assert.equal(momoAllowedNow(), false, 'not yet known counts as not allowed, for code outside React too');
  assert.deepEqual(store.getState().route, { name: 'momo' });

  await act(async () => pushMomo(true));
  await settle();
  assert.equal(momoAllowedNow(), true);
  // no page title or tabs: Chat by default, the other views when the route names them (MomoNav moves between them)
  assert.equal(host.querySelector('[role=tab], .page-title'), null);
  assert.equal(host.querySelector('[role=tabpanel]')!.textContent, 'chat main');
  await act(async () => store.setState({ route: { name: 'momo', tab: 'memory' } }));
  await settle();
  assert.equal(host.querySelector('h1')!.textContent, 'Memory');
  assert.equal(host.querySelector('[role=tabpanel]')!.textContent, 'memory');
  // a MoMo chat other than the main one, on the Chat tab
  await act(async () => store.setState({ route: { name: 'momo', tab: 'chat', chatId: 'run-1' } }));
  await settle();
  assert.equal(host.querySelector('[role=tabpanel]')!.textContent, 'chat run-1');
  await act(async () => store.setState({ route: { name: 'momo', tab: 'memory' } }));
  await settle();

  await act(async () => pushMomo(true));
  assert.deepEqual(store.getState().route, { name: 'momo', tab: 'memory' }, 'the same answer again changes nothing');

  // ⌘. opens MoMo from anywhere, the sidebar closed included (this slot is the app's, not the sidebar's)
  const w = (globalThis as any).window;
  await act(async () => store.setState({ route: { name: 'scheduled' } }));
  await press(w.document.body, '.', { metaKey: true, ctrlKey: true, shiftKey: true });
  assert.deepEqual(store.getState().route, { name: 'scheduled' }, '⇧⌘. stays the browser’s comment mode');
  await press(w.document.body, 'x', { metaKey: true, ctrlKey: true });
  await press(w.document.body, '.', {});
  assert.deepEqual(store.getState().route, { name: 'scheduled' });
  const taken = (e: KeyboardEvent) => e.preventDefault();
  w.document.body.addEventListener('keydown', taken);
  await press(w.document.body, '.', { metaKey: true, ctrlKey: true, cancelable: true });
  w.document.body.removeEventListener('keydown', taken);
  assert.deepEqual(store.getState().route, { name: 'scheduled' }, 'a handler that took the key first keeps it');
  await press(w.document.body, '.', { metaKey: true, ctrlKey: true });
  assert.deepEqual(store.getState().route, { name: 'momo' });
  await settle();

  store.setState({ forward: [{ name: 'momo' }, { name: 'projects' }] });
  await act(async () => pushMomo(false));
  await settle();
  assert.deepEqual(store.getState().route, { name: 'home' }, 'revoked: back to a new chat');
  assert.equal(momoAllowedNow(), false);
  assert.equal(host.innerHTML, '');
  assert.ok(!store.getState().back.some((r: any) => r.name === 'momo'), 'Back never leads into MoMo again');
  assert.deepEqual(store.getState().forward, [{ name: 'projects' }]);
  await press(w.document.body, '.', { metaKey: true, ctrlKey: true });
  assert.deepEqual(store.getState().route, { name: 'home' }, 'and ⌘. does nothing');

  // elsewhere in the app, a closed gate sends nowhere and leaves a history without MoMo alone
  const back = [{ name: 'projects' }];
  await act(async () => store.setState({ route: { name: 'scheduled' }, back }));
  await settle();
  assert.deepEqual(store.getState().route, { name: 'scheduled' });
  assert.equal(store.getState().back, back);
  await unmount();
});
