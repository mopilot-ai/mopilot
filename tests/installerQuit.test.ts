// A confirmed quit waits for actual installer retirement before hiding its recovery UI or entering timed general cleanup.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { flush, loadMain, unloadMain } from './support/electron-main-harness.ts';
after(() => unloadMain());

test('quitting waits beyond the ordinary cleanup timeout for the active registry install to retire', async (t) => {
  const drain = deferred<void>();
  t.after(() => drain.resolve());
  const h = await loadMain();
  await h.ready();
  const registry = h.inst.Admission[0].registry;
  registry.inflight.set('still-writing', drain.promise);
  registry.dispose = mock.fn(() => drain.promise);
  h.inst.exitGate[0].passed = true;
  const win = h.windows[0];
  win.show();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  await flush();
  assert.equal(registry.dispose.mock.callCount(), 1);
  assert.equal(e.preventDefault.mock.callCount(), 1);
  assert.equal(win.isVisible(), true, 'the installer recovery UI remains available while cleanup is unverified');
  t.mock.timers.tick(3500);
  await flush();
  assert.equal(h.app.quit.mock.callCount(), 0, 'the general cleanup timeout is not a receipt for process retirement');
  h.app.emit('before-quit', e);
  assert.equal(registry.dispose.mock.callCount(), 1, 'a repeated quit shares the drain');
  registry.inflight.clear();
  drain.resolve();
  await flush();
  assert.equal(h.app.quit.mock.callCount(), 1);
  h.app.emit('before-quit', e);
  assert.equal(win.isVisible(), false, 'after retirement the normal quit path hides windows');
  await flush();
});
