// Renderer boot restores this window's active machine side pane, reloading its authoritative transcript and session.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootImpls, callsOf, flush, impl, loadStore } from './support/store-harness.ts';
import { chatPaneForView } from '../src/store/chatPanes.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

test('boot reconnects the same side chat and marks only its interactive pane visible', async () => {
  const { store } = await loadStore();
  const parent = 'acp:kimi:parent';
  const child = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const expired = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const key = 'mopilot:remoteSidePanes';
  const items = new Map([
    [
      key,
      JSON.stringify([
        { sourceChatId: parent, threadId: child },
        { sourceChatId: parent, threadId: expired },
        { sourceChatId: parent, threadId: child },
        null,
      ]),
    ],
  ]);
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key),
      setItem: (key: string, text: string) => items.set(key, text),
    },
  });
  bootImpls();
  impl['acp.openAcpThread'] = async () => undefined;
  impl['host.openSideChat'] = (_source, restore) => (restore === child ? { chatId: child, hostId: 'box', cwd: '/p', config: {} } : null);
  location.hash = `#thread=${encodeURIComponent(parent)}`;
  await store.boot();
  await flush();
  const s = store.useStore.getState();
  const pane = s.paneTabs.find((t: any) => t.threadId === child);
  assert.equal(pane?.sourceChatId, parent);
  assert.equal(s.threads[child].ephemeral, true);
  assert.equal(s.threads[expired], undefined);
  assert.deepEqual(callsOf('host.openSideChat'), [
    [parent, child],
    [parent, expired],
    [parent, child],
  ]);
  assert.deepEqual(
    callsOf('acp.openAcpThread').filter(([id]) => id === child),
    [[child]],
  );
  assert.deepEqual(JSON.parse(items.get(key)!), [{ threadId: child, sourceChatId: parent }]);

  const { windowView } = await import('../src/store/boot.ts');
  const view = { ...s, route: { name: 'thread', id: parent }, paneTabs: [pane], paneActive: pane.id, diffPanel: { open: true } };
  assert.deepEqual(windowView(view).visible, [parent, child]);
  assert.deepEqual(windowView({ ...view, paneTabs: [{ ...pane, readOnly: true }] }).visible, [parent]);
  assert.deepEqual(windowView({ ...view, diffPanel: { open: false } }).visible, [parent]);
  store.useStore.setState({ dark: !s.dark });
  const switchTo = (id: string) => {
    const state = store.useStore.getState();
    const next = { route: { name: 'thread' as const, id }, split: state.split };
    store.useStore.setState({ ...next, ...chatPaneForView(state, next) });
  };
  switchTo('another-chat');
  assert.deepEqual(JSON.parse(items.get(key)!), [{ threadId: child, sourceChatId: parent }]);
  switchTo(parent);
  store.closePaneTab(pane.id);
  assert.equal(store.useStore.getState().paneTabs.length, 0);
  assert.deepEqual(JSON.parse(items.get(key)!), []);
});

test('corrupt or unavailable window storage leaves startup and other window state usable', async () => {
  const { restoreRemoteSidePanes } = await import('../src/store/remoteSidePanes.ts');
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('Window storage denied');
    },
  });
  await restoreRemoteSidePanes();
  for (const raw of [null, '{}', '{']) {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => raw,
        setItem() {
          throw new Error('Window storage full');
        },
      },
    });
    await restoreRemoteSidePanes();
  }
});
