// The control matrix (docs/control-plane/matrix.md), group J, keys that press (#1384): Enter or Space on a focused
// button, a keypress Enter from the Codex Browser plugin, and a Tab that moves the focus before a key acts are judged as
// the action they perform, so "Pay" focused in a cross-origin checkout frame asks once in Full access on every executor.
// BrowserTabs, the page agent's intent, OriginGrants, siteRisk, the browser_* tools, IabBackend and the Your Chrome
// check are real; pages, CDP and Chrome are fakes (support/sensitive-frames-kit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive } from './support/browser-host-kit.ts';
import { PAY, CARD, checkout, harnesses, plugin, yourChrome, SNAPSHOT_FOCUS_IN_FRAME } from './support/sensitive-frames-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { sensitiveAction, fullAccessCovers } = require('../electron/capabilities/browser/siteRisk.cjs');

test('CM-J23: Enter or Space on a focused "Pay" button in a cross-origin checkout frame is the click it performs: it asks once in Full access, on every executor and harness (#1384)', async (t) => {
  // browser_* for every harness, the key named as each executor spells it
  for (const keys of ['Enter', 'Return', 'Space', 'space', 'shift+Enter']) {
    const { w, cards, answers } = checkout(t);
    answers[''] = { frame: true, owner: 'ref_10' };
    answers.F1 = PAY;
    for (const [harness, call] of Object.entries(await harnesses(w))) {
      cards.length = 0;
      await drive(t, call('browser_computer', { action: 'key', text: keys }));
      assert.deepEqual(
        cards.map((c: any) => c.sensitive?.verb),
        ['submit payment details'],
        `${harness}: ${JSON.stringify(keys)}`,
      );
    }
  }
  // the Codex Browser plugin's raw key events: Enter as keyDown or as the keypress a char event makes, Space as keyDown
  // with or without its text; the release of a key asks nothing
  for (const params of [
    { type: 'keyDown', key: 'Enter', text: '\r' },
    { type: 'rawKeyDown', key: 'Enter' },
    { type: 'char', text: '\r' },
    { type: 'keyDown', key: ' ', code: 'Space', text: ' ' },
    { type: 'rawKeyDown', key: ' ', code: 'Space' },
    { type: 'rawKeyDown', code: 'Space' },
  ]) {
    const p = plugin('full');
    p.answers[''] = { frame: true, owner: 'ref_10' };
    p.answers.F1 = PAY;
    await p.cdp('Input.dispatchKeyEvent', params);
    await p.cdp('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    // the card names what the key presses, as browser_*'s do: it is the payment's only ask (#1384)
    assert.match(p.cards[0].summary, /^key on https:\/\/shop\.test \("Pay \$49\.00"\)$/, JSON.stringify(params));
    assert.deepEqual(
      p.cards.map((c: any) => c.sensitive?.verb),
      ['submit payment details'],
      JSON.stringify(params),
    );
  }
  // browser_script's locator press and keyboard press reach the same gate as browser_computer (CM-J16) with these actions
  for (const action of [
    { kind: 'key', keys: 'Enter', target: { ref: 'ref_1' } },
    { kind: 'key', keys: 'Space' },
  ])
    assert.equal(sensitiveAction(PAY, action)?.verb, 'submit payment details', action.keys);
  // Your Chrome: the focused button Playwright marks active inside the frame
  const focusPay = SNAPSHOT_FOCUS_IN_FRAME.replace('[active] [ref=f1e2]', '[ref=f1e2]').replace('[ref=f1e3]', '[active] [ref=f1e3]');
  for (const key of ['Enter', 'Space', ' ']) {
    const r = await yourChrome('full', 'browser_press_key', { key }, (target) => (target ? PAY : { frame: true }), focusPay);
    assert.deepEqual(
      r.cards.map((c: any) => c.sensitive?.verb),
      ['submit payment details'],
      `Your Chrome: ${JSON.stringify(key)}`,
    );
  }
});

test('CM-J24: a keypress Enter (a char event) in a card field submits it: the plugin asks; keys that activate nothing stay as they were', async () => {
  // "\r" is the keypress Enter that submits; "\n" is a new line typed into the field (a textarea's newline sends nothing)
  for (const [text, verb] of [
    ['\r', 'submit payment details'],
    ['\n', 'enter payment details'],
  ]) {
    const p = plugin('full');
    p.answers[''] = { frame: true, owner: 'ref_10' };
    p.answers.F1 = CARD;
    await p.cdp('Input.dispatchKeyEvent', { type: 'char', text });
    assert.deepEqual(
      p.cards.map((c: any) => c.sensitive?.verb),
      [verb],
      JSON.stringify(text),
    );
  }
  const link = { tag: 'a', name: 'Buy now', role: 'link', button: true, submits: false, editable: false, form: null };
  const box = { tag: 'input', type: 'checkbox', name: 'Delete my data', role: 'checkbox', button: false, editable: false, form: null };
  const del = { tag: 'button', name: 'Delete account', role: 'button', button: true, submits: false, editable: false, form: null };
  // Enter follows a link, Space does not; Space toggles a checkbox, which deletes nothing
  assert.equal(sensitiveAction(link, { kind: 'key', keys: 'Enter' })?.kind, 'purchase');
  assert.equal(sensitiveAction(link, { kind: 'key', keys: 'Space' }), null);
  assert.equal(sensitiveAction(box, { kind: 'key', keys: 'Space' }), null);
  // a modifier, another key, or a key that only types leaves a button alone; with modifiers Enter still presses it
  assert.equal(sensitiveAction(del, { kind: 'key', keys: 'Tab' }), null);
  assert.equal(sensitiveAction(del, { kind: 'key', keys: 'a' }), null);
  assert.equal(sensitiveAction(del, { kind: 'key', keys: 'shift+Enter' })?.kind, 'delete');
  // a Tab first moves the focus: what the later key presses or types into was never read, so it asks, in Full access too
  for (const keys of ['Tab Enter', 'shift+Tab space', 'Tab 4', 'Tab Tab Return']) {
    const s = sensitiveAction(link, { kind: 'key', keys });
    assert.deepEqual([s?.kind, fullAccessCovers(s)], ['unread_target', false], keys);
  }
  assert.equal(sensitiveAction(del, { kind: 'key', keys: 'Enter Tab' })?.kind, 'delete');
  assert.equal(sensitiveAction(del, { kind: 'key', keys: 'Tab Tab' }), null);
  assert.equal(sensitiveAction(null, { kind: 'key', keys: 'Tab Enter' })?.verb, 'press keys on a control the focus moves to');
  // typing a space into the card field is still entering payment details, not a press
  assert.equal(sensitiveAction(CARD, { kind: 'key', keys: 'Space' })?.kind, 'payment_entry');
  // in Ask mode the press asks once, as the click does
  const ask = plugin('ask');
  ask.answers[''] = { frame: true, owner: 'ref_10' };
  ask.answers.F1 = PAY;
  await ask.cdp('Input.dispatchKeyEvent', { type: 'char', text: '\r' });
  assert.equal(ask.cards.length, 1);
});
