// In the whole app, typing in a chat re-renders nothing outside the composer (#4986 F1), and the draft outlives the screen: it is in the field again when the chat is reopened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const appPath = '../mobile/src/MobileApp';
const cachePath = '../mobile/src/presentation/threadCache';
const { MobileApp } = await import(appPath);
const { forgetRows } = await import(cachePath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
};

test('A: 30 keys typed in an open chat render neither the app root nor the chat screen, and the draft is there when the chat is reopened', async () => {
  forgetRows();
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c1', title: 'Build' }] }
        : m === 'chat.follow'
          ? {
              rev: 1,
              feedSeq: 0,
              session: { turn: 'idle', cards: [] },
              itemsShape: 'rows',
              items: [{ role: 'user', text: 'Fix the build' }],
            }
          : undefined,
    online,
  );
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Open chat Build');
  const field = () => host.querySelector('[aria-label="Message this chat"]') as HTMLInputElement;
  assert.ok(field());
  // the chat screen draws its scroll view on each of its own renders (new events object each time); the root re-rendering would render the screen too
  const before = (globalThis as any).__scrollEvents;
  let text = '';
  for (let i = 0; i < 30; i += 1) {
    text += 'k';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text);
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  assert.equal(field().value, text);
  assert.equal((globalThis as any).__scrollEvents, before, 'no render of the chat screen, so none of the root either');
  // leave the chat and open it again: the draft is kept by the app
  await click('Back');
  await click('Open chat Build');
  assert.equal(field().value, text);
  await act(async () => root.unmount());
  host.remove();
});
