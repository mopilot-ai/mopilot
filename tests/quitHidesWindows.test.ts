// A confirmed quit hides every window at once, while its cleanup still runs; a quit the exit gate holds keeps them.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { flush, loadMain, unloadMain } from './support/electron-main-harness.ts';

after(() => unloadMain());

test('the windows stay while the exit gate asks, and go as soon as the quit is confirmed, before its cleanup ends', async () => {
  const cleanup = deferred<void>();
  const h = await loadMain({ before: (h) => h.claude.closeAll.mock.mockImplementation(() => cleanup.promise) });
  await h.ready();
  const win = h.windows[0];
  win.show();
  const gate = h.inst.exitGate[0];
  gate.request = mock.fn(async () => false);
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  await flush();
  assert.equal(win.isVisible(), true, "the gate's question is shown in the window");
  gate.passed = true;
  h.app.emit('before-quit', e);
  assert.equal(win.isVisible(), false, 'confirmed: the window goes at once');
  assert.equal(h.app.quit.mock.callCount(), 0, 'while the cleanup still holds the quit');
  // a second launch or a notification click meanwhile brings no window back
  h.app.emit('second-instance');
  assert.equal(win.isVisible(), false);
  // a window already hidden, or already gone, is left alone
  win.hide = mock.fn();
  h.app.emit('before-quit', e);
  assert.equal(win.hide.mock.callCount(), 0);
  win.destroyed = true;
  h.app.emit('before-quit', e);
  // with the window gone, one made for a second launch stays hidden too
  h.app.emit('second-instance');
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].isVisible(), false);
  cleanup.resolve();
  await flush();
  assert.equal(h.app.quit.mock.callCount(), 1);
  // the quit goes on: what main holds in memory and writes behind is written before the process ends, and not before the quit is confirmed
  const chats = h.inst.ChatsStore[0];
  assert.equal(chats.flush.mock.callCount(), 0);
  h.app.emit('before-quit', e);
  await flush();
  assert.equal(chats.flush.mock.callCount(), 1);
});

test('confirmed quit gives the Host its cleanup window before closing the connection', async () => {
  const retired = deferred<void>();
  const retireHostSideChats = mock.fn(() => retired.promise);
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/app/ipc/host.cjs'] = {
        register: (_ipc: unknown, { live }: any) => {
          live.acpHost.items.drain = () => Promise.resolve();
          live.retireHostSideChats = retireHostSideChats;
        },
      };
    },
  });
  await h.ready();
  h.inst.exitGate[0].passed = true;
  h.app.emit('before-quit', { preventDefault: mock.fn() });
  await flush();
  assert.deepEqual(retireHostSideChats.mock.calls[0]?.arguments, [3000]);
  assert.equal(h.app.quit.mock.callCount(), 0);
  retired.resolve();
  await flush();
  assert.equal(h.app.quit.mock.callCount(), 1);
});
