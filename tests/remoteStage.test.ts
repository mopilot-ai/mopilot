// What the browser pane draws for an agent's tab on a Host (src/components/panels/browserPanel/RemoteStage.tsx): a page by its frames, or the Host's whole desktop, named by its machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mount } from './support/composer-kit.ts';
import { fakeStore, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const store = fakeStore<any>({
  agentTabs: {
    c1: [
      {
        tabId: 'desktop',
        tabKey: JSON.stringify(['host', 'h1', 'desktop']),
        kind: 'tab',
        active: true,
        takenOver: false,
        desktop: { machine: 'box' },
      },
    ],
  },
});
stubStore({ useStore: store.useStore });
const ok = async () => true;
installNativeStub({
  computer: { desktopWatch: ok, desktopView: ok, desktopStop: ok, desktopInput: ok, onDesktopFrame: () => () => undefined },
  browser: { remote: { watch: ok, view: ok, stop: ok, input: ok, onFrame: () => () => undefined } },
});
const { createElement } = await import('react');
const { RemoteStage } = await import('../src/components/panels/browserPanel/RemoteStage.tsx');

const props = { handleRef: { current: null }, paneId: 'p1', chatId: 'c1', shown: true, takenOver: false };

test('a Host’s desktop key draws the desktop under its machine’s name; a Host’s page key draws the page', async () => {
  const desktop = await mount(createElement(RemoteStage, { ...props, tabKey: JSON.stringify(['host', 'h1', 'desktop']) }));
  try {
    assert.ok($('.host-desktop'));
    assert.equal($('.remote-view-bar').textContent, "This is box's desktop, not this Mac.");
  } finally {
    await desktop.unmount();
  }
  const page = await mount(createElement(RemoteStage, { ...props, tabKey: JSON.stringify(['host', 'h1', 'tab_x']) }));
  try {
    assert.ok($('.remote-view'));
    assert.equal(document.querySelector('.host-desktop'), null);
  } finally {
    await page.unmount();
  }
});

test('a desktop whose machine the pane was not told yet says so in words', async () => {
  const m = await mount(createElement(RemoteStage, { ...props, chatId: 'c2', tabKey: JSON.stringify(['host', 'h1', 'desktop']) }));
  try {
    assert.equal($('.remote-view-bar').textContent, "This is the other machine's desktop, not this Mac.");
  } finally {
    await m.unmount();
  }
});
