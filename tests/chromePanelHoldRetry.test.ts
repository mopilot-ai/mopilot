// A rejected irreversible answer cannot restart from keyboard auto-repeat without a new deliberate hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { fixture, card, tick, trusted } from './support/panel-card-controls.ts';
test('keyboard auto-repeat cannot re-arm an irreversible hold after its answer fails', async () => {
  const f = fixture();
  f.reply(() => {
    throw new Error('Delivery failed');
  });
  f.view.render('chat', [card({ choices: [{ key: 'once', label: 'Hold', hold: true }] })]);
  const b = f.container.querySelector('button')!;
  const key = (repeat: boolean) => b.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, repeat })));
  key(false);
  [...f.timeouts.values()][0]();
  await tick();
  assert.equal(f.calls.length, 1);
  key(true);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.calls.length, 1);
  key(false);
  assert.equal(f.timeouts.size, 1);
});
