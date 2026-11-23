// Mention and slash menus keep the same keyboard, wraparound and input-method behavior through their public key handlers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelMention } from '../electron/chrome-extension/src/panelMention.mjs';
import { PanelSlash } from '../electron/chrome-extension/src/panelSlash.mjs';

for (const Menu of [PanelMention, PanelSlash]) {
  const rig = () => {
    const calls: unknown[] = [];
    const menu = Object.create(Menu.prototype);
    Object.defineProperty(menu, 'open', { value: true, writable: true });
    Object.assign(menu, {
      rows: ['first', 'second'],
      at: 0,
      close: () => calls.push('close'),
      render: () => calls.push('render'),
      pick: (row: string) => calls.push(row),
    });
    const key = (value: string, extra = {}) => menu.key({ key: value, preventDefault: () => calls.push('prevent'), ...extra });
    return { menu, calls, key };
  };

  test(`${Menu.name}: arrows wrap and render the selected row`, () => {
    const r = rig();
    assert.equal(r.key('ArrowUp'), true);
    assert.equal(r.menu.at, 1);
    assert.equal(r.key('ArrowDown'), true);
    assert.equal(r.menu.at, 0);
    assert.deepEqual(r.calls, ['render', 'prevent', 'render', 'prevent']);
  });

  test(`${Menu.name}: Enter and Tab choose the current row`, () => {
    const r = rig();
    assert.equal(r.key('Enter'), true);
    r.menu.at = 1;
    assert.equal(r.key('Tab'), true);
    assert.deepEqual(r.calls, ['first', 'prevent', 'second', 'prevent']);
  });

  test(`${Menu.name}: Escape closes even an empty menu`, () => {
    const r = rig();
    r.menu.rows = [];
    assert.equal(r.key('Escape'), true);
    assert.deepEqual(r.calls, ['close', 'prevent']);
  });

  test(`${Menu.name}: no rows, another key, a closed menu or IME input leaves the event alone`, () => {
    const r = rig();
    assert.equal(r.key('Enter', { isComposing: true }), false);
    assert.equal(r.key('Escape', { keyCode: 229 }), false);
    assert.equal(r.key('x'), false);
    r.menu.open = false;
    assert.equal(r.key('Enter'), false);
    r.menu.open = true;
    r.menu.rows = [];
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab']) assert.equal(r.key(key), false);
    assert.deepEqual(r.calls, []);
  });
}
