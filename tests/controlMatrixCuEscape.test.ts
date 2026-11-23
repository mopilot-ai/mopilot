// Control matrix, computer use's Esc-to-stop shortcut (docs/control-plane/matrix.md, group Q): an Escape the agent
// sends itself never stops its own turn, even though the window server delivers the posted key after the helper has
// returned; the shortcut comes back once the key is through, and a person's Esc then stops the chat as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/'];

const require = createRequire(import.meta.url);
const { ControlIndicator, ESCAPE_SETTLE_MS } = require('../electron/capabilities/controlIndicator.cjs');

/** Electron's globalShortcut, and a window server that hands a posted Escape to the shortcut when one is bound. */
function rig() {
  const shortcuts = new Map<string, () => void>();
  const globalShortcut = {
    register: (accel: string, fn: () => void) => (shortcuts.set(accel, fn), true),
    unregister: (accel: string) => shortcuts.delete(accel),
  };
  const stops: string[] = [];
  const delivered: string[] = [];
  const ind = new ControlIndicator({ electron: { globalShortcut }, onEscape: (chatId: string) => stops.push(chatId) });
  /** the key reaches the window server `lagMs` after it was posted: the shortcut takes it if bound, else the app gets it */
  const deliver = (lagMs: number) =>
    setTimeout(() => {
      const hotkey = shortcuts.get('Escape');
      if (hotkey) hotkey();
      else delivered.push('app');
    }, lagMs);
  return { ind, shortcuts, stops, delivered, deliver };
}

test("CM-Q15: an Escape the agent posts reaches the app and never stops its own turn, though delivery lags the helper's return", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  r.ind.sync('c1');
  assert.ok(r.shortcuts.has('Escape'), 'Esc stops the chat while it holds control');
  // the helper posts the key and returns at once; the window server delivers it 120 ms later
  const out = await r.ind.suspendEscape(async () => {
    r.deliver(120);
    return 'posted';
  });
  assert.equal(out, 'posted', 'the call does not wait for the settle');
  assert.equal(r.shortcuts.has('Escape'), false, 'still lifted right after the press');
  t.mock.timers.tick(120);
  assert.deepEqual(r.delivered, ['app']);
  assert.deepEqual(r.stops, [], "the agent's own Escape did not stop the turn");
  t.mock.timers.tick(ESCAPE_SETTLE_MS - 120);
  assert.ok(r.shortcuts.has('Escape'), 'bound again once the key is through');
  // a person's Esc afterwards stops the chat as before
  r.deliver(0);
  t.mock.timers.tick(0);
  assert.deepEqual(r.stops, ['c1']);
  assert.ok(
    ESCAPE_SETTLE_MS >= 250 && ESCAPE_SETTLE_MS <= 1000,
    `a settle long enough for delivery and short for a person (${ESCAPE_SETTLE_MS} ms)`,
  );
});

test('CM-Q16: overlapping own Escapes keep Esc lifted until the last one settles; control ending meanwhile leaves it unbound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  r.ind.sync('c1');
  await r.ind.suspendEscape(async () => 'one');
  t.mock.timers.tick(ESCAPE_SETTLE_MS / 2);
  await r.ind.suspendEscape(async () => 'two');
  t.mock.timers.tick(ESCAPE_SETTLE_MS / 2);
  assert.equal(r.shortcuts.has('Escape'), false, 'the second Escape is still settling');
  // taking control while lifted does not bind Esc either
  r.ind.sync('c2');
  assert.equal(r.shortcuts.has('Escape'), false);
  t.mock.timers.tick(ESCAPE_SETTLE_MS / 2);
  assert.ok(r.shortcuts.has('Escape'));
  // a failed press settles the same way; control ended before the settle: not bound again
  await assert.rejects(
    r.ind.suspendEscape(async () => {
      throw new Error('key failed');
    }),
    /key failed/,
  );
  r.ind.sync(null);
  t.mock.timers.tick(ESCAPE_SETTLE_MS);
  assert.equal(r.shortcuts.has('Escape'), false);
});
