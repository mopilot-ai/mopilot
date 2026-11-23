// Native WebContentsView focus reaches the owning renderer tile instead of another split tool's shortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, createRef } from 'react';
import { act } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
let event: (e: any) => void = () => {};
let removed = 0;
installNativeStub({
  browser: {
    view: {
      onEvent: (cb: any) => {
        event = cb;
        return () => {
          removed++;
        };
      },
      bind: async () => ({ id: 7, state: { url: 'https://local.test', title: 'Page', loading: false, back: false, forward: false } }),
      bounds: async () => true,
    },
  },
});
const { ViewSurface } = await import('../src/components/panels/browserPanel/ViewSurface.tsx');
test('native focus bubbles once from its own stage; foreign, navigation and closed events cannot focus another tile', async () => {
  const handle = createRef<any>();
  let focused = 0,
    closed = 0;
  const v = await render(
    h(
      'div',
      {
        onFocusCapture: () => {
          focused++;
        },
      },
      h(ViewSurface, {
        handleRef: handle,
        paneId: 'b',
        url: 'https://local.test',
        partition: 'persist:test',
        chatId: null,
        chat: 'a',
        tabKey: null,
        shown: true,
        onClosed: () => {
          closed++;
        },
      }),
    ),
  );
  await act(() => event({ id: 8, type: 'focus', state: null, detail: null }));
  assert.equal(focused, 0);
  await act(() => event({ id: 7, type: 'focus', state: null, detail: null }));
  assert.equal(focused, 1);
  await act(() => event({ id: 7, type: 'page-title-updated', state: null, detail: null }));
  assert.equal(focused, 1);
  await act(() => event({ id: 7, type: 'closed', state: null, detail: null }));
  assert.equal(closed, 1);
  assert.equal(focused, 1);
  await v.unmount();
  assert.equal(removed, 1);
  await act(() => event({ id: 7, type: 'focus', state: null, detail: null }));
  assert.equal(focused, 1);
});
