// The phone's native stack: which screens sit on which, and a late system dismissal never closes what is open now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
// through variables, so the desktop typecheck does not follow into React Native's global types
const stackPath = '../mobile/src/stack';
const nativeStackPath = '../mobile/src/components/NativeStack';
const { stackOf } = await import(stackPath);
const { NativeStack } = await import(nativeStackPath);

const closed = { momo: false, settings: false, newChat: false, scheduled: false, answer: null, chat: null, top: null, pairing: false };
const keys = (nav: object) => stackOf({ ...closed, ...nav }).map((route: { key: string }) => route.key);

test('the home list is always at the bottom, and one flow sits on it in the app’s order of precedence', () => {
  assert.deepEqual(keys({}), ['home']);
  assert.deepEqual(keys({ momo: true, settings: true, chat: 'c' }), ['home', 'momo']);
  assert.deepEqual(keys({ settings: true, newChat: true }), ['home', 'settings']);
  assert.deepEqual(keys({ newChat: true, scheduled: true }), ['home', 'newChat']);
  assert.equal(stackOf({ ...closed, newChat: true })[1].sheet, true, 'New chat is a sheet');
  assert.deepEqual(
    keys({ newChat: true, starting: 'start-1' }),
    ['home', 'newChat', 'starting:start-1'],
    'the starting page sits on New chat, which keeps its state',
  );
  assert.deepEqual(keys({ starting: 'start-1' }), ['home'], 'no New chat, no starting page');
  assert.deepEqual(keys({ scheduled: true, answer: 'w' }), ['home', 'scheduled']);
  assert.deepEqual(keys({ answer: 'w', chat: 'c' }), ['home', 'answer'], 'the quick review is one sheet, whichever chat it shows');
  assert.equal(stackOf({ ...closed, answer: 'w' })[1].sheet, true);
  assert.deepEqual(keys({ scheduled: false, chat: 'c' }), ['home', 'chat:c']);
  assert.deepEqual(keys({ chat: 'c', pairing: true }), ['home', 'chat:c']);
  assert.deepEqual(keys({ chat: 'c', top: 'review' }), ['home', 'chat:c', 'review:c'], 'a chat’s screen sits on the chat');
  assert.deepEqual(keys({ top: 'review' }), ['home'], 'no chat, no chat screen');
  assert.deepEqual(keys({ pairing: true }), ['home', 'pairing']);
});

test('a system dismissal closes the screen it names, and one reported after the app moved on closes nothing', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const popped: string[] = [];
  const show = (routes: { kind: string; key: string; sheet?: true }[]) =>
    act(async () =>
      root.render(
        createElement(NativeStack, {
          routes,
          render: (route: { key: string }) => createElement('span', null, route.key),
          popped: (route: { key: string }) => popped.push(route.key),
        }),
      ),
    );
  const home = { kind: 'home', key: 'home' };
  const dismiss = (key: string) => act(async () => (globalThis as any).__screenDismiss[key]({ nativeEvent: { dismissCount: 1 } }));
  await show([home, { kind: 'chat', key: 'chat:a' }]);
  assert.equal(host.querySelector('[data-screen="chat:a"]')?.getAttribute('data-presentation'), 'push');
  await dismiss('chat:a');
  assert.deepEqual(popped, ['chat:a']);
  // chat a's dismissal arrives late, after the app already closed it itself and opened chat b
  await show([home, { kind: 'chat', key: 'chat:b' }]);
  await dismiss('chat:a');
  assert.deepEqual(popped, ['chat:a'], 'a dismissal of a screen no longer open closes nothing');
  await dismiss('chat:b');
  assert.deepEqual(popped, ['chat:a', 'chat:b']);
  await show([home, { kind: 'newChat', key: 'newChat', sheet: true }]);
  const sheet = host.querySelector('[data-screen="newChat"]')!;
  assert.equal(sheet.getAttribute('data-presentation'), 'modal');
  assert.ok(host.querySelector('[data-screen="home"]'), 'the list stays visible under a sheet');
  await act(async () => root.unmount());
  host.remove();
});

test('a pushed screen keeps clear of the status bar and home indicator; Chats (which draws under them) and a page sheet do not', async () => {
  (globalThis as any).__safeAreaInsets = { top: 47, bottom: 34, left: 0, right: 0 };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (routes: { kind: string; key: string; sheet?: true }[]) =>
    act(async () => root.render(createElement(NativeStack, { routes, render: () => null, popped: () => {} })));
  const insetsOf = (key: string) => {
    const style = JSON.parse(host.querySelector(`[data-screen="${key}"]`)!.getAttribute('data-content-style')!);
    return [style.paddingTop, style.paddingBottom];
  };
  const home = { kind: 'home', key: 'home' };
  await show([home, { kind: 'chat', key: 'chat:a' }]);
  assert.deepEqual(insetsOf('chat:a'), [47, 34]);
  await show([home, { kind: 'settings', key: 'settings', sheet: true }]);
  assert.deepEqual(insetsOf('settings'), [undefined, undefined], 'a page sheet starts below the status bar already');
  assert.deepEqual(insetsOf('home'), [undefined, undefined], 'Chats keeps clear itself');
  // Android shows a sheet full screen, so it keeps clear like a pushed screen
  (globalThis as any).__phonePlatform = 'android';
  await show([home, { kind: 'pairing', key: 'pairing', sheet: true }]);
  delete (globalThis as any).__phonePlatform;
  assert.deepEqual(insetsOf('pairing'), [47, 34]);
  delete (globalThis as any).__safeAreaInsets;
  await act(async () => root.unmount());
  host.remove();
});
