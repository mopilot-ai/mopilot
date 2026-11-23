// A message sent from Quick Chat shows in Quick Chat's own view on every harness (#2316): main sends the display events
// (turnStarting, steered) of a Claude Code or ACP send to the window it came from even when that is Quick Chat, which is
// no step window; execution-bound events keep going to the step windows only.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

async function setup() {
  const h = await loadMain();
  await h.ready();
  const main = h.windows[0];
  await h.invoke('window:mini');
  const mini = h.windows[1];
  h.emitIpc('session:ready', main.webContents);
  h.emitIpc('session:ready', mini.webContents);
  return { h, main, mini };
}
const kinds = (w: any, ch: string) => w.webContents.on_(ch).map(([e]: any[]) => e.kind);

for (const [family, channel, adapter] of [
  ['Claude Code', 'claude:event', 'ClaudeAdapter'],
  ['ACP', 'acp:event', 'AcpTurns'],
] as const) {
  test(`${family}: a send from Quick Chat reaches Quick Chat's view as well as an app window`, async () => {
    const { h, main, mini } = await setup();
    const emit = h.one(adapter).opts.emit;
    assert.equal(emit({ kind: 'turnStarting', chatId: 'c' }, mini.webContents.id), true);
    assert.equal(emit({ kind: 'steered', chatId: 'c' }, mini.webContents.id), true);
    mock.timers.tick(100);
    assert.deepEqual(kinds(mini, channel), ['turnStarting', 'steered']);
    assert.deepEqual(kinds(main, channel), ['turnStarting', 'steered'], 'the app window keeps its event');
  });

  test(`${family}: execution-bound events and sends from an app window stay off Quick Chat`, async () => {
    const { h, main, mini } = await setup();
    const emit = h.one(adapter).opts.emit;
    emit({ kind: 'turnStarted', chatId: 'c' }, mini.webContents.id);
    emit({ kind: 'turnStarting', chatId: 'c2' }, main.webContents.id);
    emit({ kind: 'turnStarting', chatId: 'c3' }, 'any');
    mock.timers.tick(100);
    assert.deepEqual(kinds(mini, channel), []);
    assert.deepEqual(kinds(main, channel), ['turnStarted', 'turnStarting', 'turnStarting']);
  });

  test(`${family}: Quick Chat alone (no app window registered) still shows its own message`, async () => {
    const h = await loadMain();
    await h.ready();
    await h.invoke('window:mini');
    const mini = h.windows[1];
    h.windows[0].close();
    const emit = h.one(adapter).opts.emit;
    assert.equal(emit({ kind: 'turnStarting', chatId: 'c' }, mini.webContents.id), true);
    mock.timers.tick(100);
    assert.deepEqual(kinds(mini, channel), ['turnStarting']);
  });
}
