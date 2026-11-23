// electron/capabilities/controlIndicator.cjs while the person has taken over: the Esc shortcut is lifted so their Esc reaches their apps, and comes back when they hand control back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ControlIndicator } = require('../electron/capabilities/controlIndicator.cjs');

function rig() {
  const shortcuts = new Map<string, Function>();
  const globalShortcut = {
    register: (k: string, f: Function) => (shortcuts.set(k, f), true),
    unregister: (k: string) => void shortcuts.delete(k),
  };
  const state = { taken: false };
  const stops: string[] = [];
  const ind = new ControlIndicator({
    electron: { globalShortcut },
    onEscape: (c: string) => stops.push(c),
    takenOver: () => state.taken,
    escapeSettleMs: 0,
  });
  return { ind, shortcuts, state, stops };
}

test('taken over: Esc is lifted while the person works and bound again when they hand control back', () => {
  const r = rig();
  r.ind.sync('c1');
  assert.ok(r.shortcuts.has('Escape'));
  r.state.taken = true;
  r.ind.sync('c1');
  assert.equal(r.shortcuts.has('Escape'), false, "the person's Esc goes to their app");
  r.state.taken = false;
  r.ind.sync('c1');
  assert.ok(r.shortcuts.has('Escape'));
  r.shortcuts.get('Escape')!();
  assert.deepEqual(r.stops, ['c1']);
  r.ind.sync(null);
  assert.equal(r.shortcuts.has('Escape'), false);
});

test('taken over: a chat that takes the desktop while paused, or an agent Escape that settles meanwhile, leaves Esc lifted', async () => {
  const r = rig();
  r.state.taken = true;
  r.ind.sync('c2');
  assert.equal(r.shortcuts.has('Escape'), false);
  await r.ind.suspendEscape(async () => 'sent');
  assert.equal(r.shortcuts.has('Escape'), false);
  r.state.taken = false;
  await r.ind.suspendEscape(async () => 'sent');
  assert.ok(r.shortcuts.has('Escape'));
  // Codex Computer Use holds the desktop: its program doesn't pause on a takeover, so Esc still stops it
  const sky = new ControlIndicator({
    electron: { globalShortcut: { register: () => true, unregister: () => {} } },
    takenOver: () => true,
    heldNatively: () => true,
  });
  sky.sync('c4');
  assert.equal(sky.escape, true);
  sky.sync(null);
  // without the option nothing is ever taken over
  const plain = new ControlIndicator({ electron: { globalShortcut: { register: () => true, unregister: () => {} } } });
  plain.sync('c3');
  assert.equal(plain.escape, true);
  plain.sync(null);
});

test("wiring: the indicator reads the chat's session, so a takeover (and only a takeover) lifts Esc", async () => {
  const { rig: setupRig } = await import('./support/computer-use-setup-rig.ts');
  const r = setupRig();
  const takenOver = (r.runtime.indicator as any).takenOver as (id: string) => boolean;
  assert.equal(takenOver('c'), false, 'no session state yet');
  r.states.set('c', { computer: { app: 'Notes', state: 'active' } });
  assert.equal(takenOver('c'), false);
  r.states.set('c', { computer: { app: 'Notes', state: 'takeover' } });
  assert.equal(takenOver('c'), true);
});
