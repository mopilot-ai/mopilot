// After a restart to update the first main window opens on the chat it showed before; an ordinary launch opens as usual.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

after(() => unloadMain());
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

test('the first main window opens on the saved chat, once', async () => {
  const h = await loadMain({
    before: (h) => fs.writeFileSync(path.join(h.userData, 'restart-view.json'), JSON.stringify({ chatId: 'claude:s1', ts: Date.now() })),
  });
  await h.ready();
  assert.deepEqual(h.windows[0].loaded[0].slice(2), [{ hash: 'thread=claude%3As1' }]);
  assert.equal(fs.existsSync(path.join(h.userData, 'restart-view.json')), false);
});

test('an ordinary launch opens the main window with no chat named', async () => {
  const h = await loadMain();
  await h.ready();
  assert.deepEqual(h.windows[0].loaded[0].slice(2), [undefined]);
});

for (const [state, window, expected] of [
  ['shown', { visible: true, minimized: false }, 'showInactive'],
  ['minimized', { visible: false, minimized: true }, 'minimize'],
  ['hidden', { visible: false, minimized: false }, null],
] as const) {
  test(`after a stealth restart a window that was ${state} comes back ${state}, without taking focus`, async () => {
    const h = await loadMain({
      before: (h) => fs.writeFileSync(path.join(h.userData, 'restart-view.json'), JSON.stringify({ ts: Date.now(), window })),
    });
    await h.ready();
    const win: any = h.windows[0];
    assert.deepEqual(win.log, expected ? [expected] : [], 'restore visibility before first paint');
    assert.equal(win.isVisible(), window.visible);
    assert.equal(win.isMinimized(), window.minimized);
    win.emit('ready-to-show');
    mock.timers.tick(2500);
    assert.deepEqual(win.log, expected ? [expected] : [], 'no delayed reveal or focus');
    assert.deepEqual(win.loaded[0].slice(2), [undefined], 'no chat was in view');
  });
}

test('a visible stealth restore stays minimized if the user minimizes it before first paint', async () => {
  const h = await loadMain({
    before: (h) =>
      fs.writeFileSync(
        path.join(h.userData, 'restart-view.json'),
        JSON.stringify({ ts: Date.now(), window: { visible: true, minimized: false } }),
      ),
  });
  await h.ready();
  const win = h.windows[0];
  win.minimize();
  win.emit('ready-to-show');
  mock.timers.tick(2500);
  assert.equal(win.isMinimized(), true);
  assert.equal(win.isVisible(), false);
  assert.deepEqual(win.log, ['showInactive', 'minimize']);
});
