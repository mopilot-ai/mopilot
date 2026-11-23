// The production duplicate singleton and Stop entrypoint use the shared store and native bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/lib/native/browser.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubSlice } from './support/stubs.ts';
let state: any = {
  route: { name: 'thread', id: 'stable' },
  paneTabs: [{ id: 'blank', kind: 'browser', url: '', ownerChat: 'native' }],
  paneActive: 'blank',
  diffPanel: { open: false },
};
stubSlice('src/store/core.ts', {
  get: () => state,
  set: (fn: any) => {
    state = { ...state, ...fn(state) };
  },
});
stubSlice('src/store/chats.ts', { chatOf: () => 'stable' });
const browser: any = {};
installNativeStub({ browser });
const { browserDuplication } = await import('../src/store/browserDuplicate.ts');
const { stopBrowserLoad } = await import('../src/lib/browserStop.ts');

test('the shared store singleton inserts a same-stable-chat blank copy', async () => {
  await browserDuplication.duplicate('blank');
  assert.equal(state.paneTabs.length, 2);
  assert.equal(state.paneTabs[1].ownerChat, 'stable');
  assert.equal(state.paneActive, state.paneTabs[1].id);
  assert.equal(state.diffPanel.open, true);
  // on another chat (or a page with no chat) the copy mounts behind
  // a split pane showing the tab's chat, focused: the side pane is that chat's, so the copy comes to the front
  state = { ...state, route: { name: 'thread', id: 'elsewhere' }, split: { panes: [{ chatId: 'stable', weight: 1 }], focus: 'stable' } };
  state = { ...state, paneActive: 'blank', diffPanel: { open: false } };
  await browserDuplication.duplicate('blank');
  assert.equal(state.diffPanel.open, true);
  state = { ...state, split: undefined };
  for (const route of [{ name: 'thread', id: 'elsewhere' }, { name: 'home' }]) {
    state = { ...state, route, paneActive: 'blank', diffPanel: { open: false } };
    const before = state.paneTabs.length;
    await browserDuplication.duplicate('blank');
    assert.equal(state.paneTabs.length, before + 1);
    assert.equal(state.paneActive, 'blank');
    assert.equal(state.diffPanel.open, false);
  }
});
test('Stop reports absent/unready pages, synchronous refusal and async rejection; success goes to the requested page only', async () => {
  let failed = 0;
  const failure = () => {
    failed++;
  };
  stopBrowserLoad(null, failure);
  stopBrowserLoad(
    {
      getWebContentsId: () => {
        throw new Error('not attached');
      },
    },
    failure,
  );
  browser.stopLoading = () => {
    throw new Error('bridge unavailable');
  };
  stopBrowserLoad({ getWebContentsId: () => 1 }, failure);
  browser.stopLoading = async () => {
    throw new Error('refused');
  };
  stopBrowserLoad({ getWebContentsId: () => 1 }, failure);
  await Promise.resolve();
  assert.equal(failed, 4);
  let received = 0;
  browser.stopLoading = async (id: number) => {
    received = id;
  };
  stopBrowserLoad({ getWebContentsId: () => 2 }, failure);
  await Promise.resolve();
  assert.equal(received, 2);
  assert.equal(failed, 4);
});
