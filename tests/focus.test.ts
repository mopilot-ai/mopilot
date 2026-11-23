// The composer only takes focus when no other text field holds it; rows that hold buttons activate from the keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as focus from '../src/lib/focus.ts';

const { typingElsewhere } = focus;

test('another text field keeps the keyboard; the page body or a button does not', () => {
  const composer = { tagName: 'TEXTAREA' };
  assert.equal(typingElsewhere(composer, { tagName: 'TEXTAREA' }), true); // xterm's input
  assert.equal(typingElsewhere(composer, { tagName: 'INPUT' }), true);
  assert.equal(typingElsewhere(composer, { tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(typingElsewhere(composer, { tagName: 'BODY' }), false);
  assert.equal(typingElsewhere(composer, { tagName: 'BUTTON' }), false);
  assert.equal(typingElsewhere(composer, composer), false);
  assert.equal(typingElsewhere(composer, null), false);
});

test('onActivate: Enter or Space on the element runs it, as a click would, and keeps the key from scrolling', () => {
  const { onActivate } = focus;
  for (const key of ['Enter', ' ']) {
    let ran = 0;
    let prevented = false;
    const el = {};
    onActivate(() => ran++)({ key, target: el, currentTarget: el, preventDefault: () => (prevented = true) });
    assert.equal(ran, 1, key);
    assert.equal(prevented, true, key);
  }
});

test('onActivate: keys on a nested control, repeats, handled keys, IME and other keys do nothing', () => {
  const { onActivate } = focus;
  let ran = 0;
  const el = {};
  const run = onActivate(() => ran++);
  const press = (e: Record<string, unknown>) => run({ key: 'Enter', target: el, currentTarget: el, preventDefault() {}, ...e } as any);
  press({ target: {} }); // the row's own button handles its Enter
  press({ repeat: true });
  press({ defaultPrevented: true });
  press({ nativeEvent: { isComposing: true } }); // Enter confirming a candidate
  press({ key: ' ', nativeEvent: { isComposing: true } });
  press({ key: ' ', keyCode: 229 });
  press({ key: 'a' });
  press({ key: 'Escape' });
  assert.equal(ran, 0);
});

test('listKey: a menu list moves, jumps, picks, opens and goes back; a search field keeps Space, Home, End and the side arrows', () => {
  const { listKey } = focus;
  const k = (key: string, more: object = {}) => ({ key, ...more });
  for (const [key, move] of [
    ['ArrowDown', 'next'],
    ['ArrowUp', 'prev'],
    ['Home', 'first'],
    ['End', 'last'],
    ['Enter', 'pick'],
    [' ', 'pick'],
    ['ArrowRight', 'open'],
    ['ArrowLeft', 'back'],
    ['a', null],
  ] as const)
    assert.equal(listKey(k(key)), move, key);
  for (const [key, move] of [
    ['ArrowDown', 'next'],
    ['ArrowUp', 'prev'],
    ['Enter', 'pick'],
    [' ', null],
    ['Home', null],
    ['End', null],
    ['ArrowRight', null],
    ['ArrowLeft', null],
  ] as const)
    assert.equal(listKey(k(key), true), move, `text field: ${key}`);
});

test('listKey: an input method confirming a candidate, and a held Enter or Space, move nothing', () => {
  const { listKey } = focus;
  assert.equal(listKey({ key: 'Enter', nativeEvent: { isComposing: true } }), null);
  assert.equal(listKey({ key: 'ArrowDown', isComposing: true }), null);
  assert.equal(listKey({ key: 'Enter', keyCode: 229 }, true), null);
  assert.equal(listKey({ key: 'Enter', repeat: true }), null);
  assert.equal(listKey({ key: ' ', repeat: true }), null);
  assert.equal(listKey({ key: 'ArrowDown', repeat: true }), 'next', 'a held arrow keeps moving');
});

test('listKey: a key with a modifier is not a list move (Shift+Arrow selects text, Alt+Arrow and Cmd+Enter are shortcuts)', () => {
  const { listKey } = focus;
  for (const mod of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey']) {
    assert.equal(listKey({ key: 'ArrowDown', [mod]: true }, true), null, mod);
    assert.equal(listKey({ key: 'Enter', [mod]: true }), null, mod);
  }
});

test('stepIndex: menus wrap, filtered lists stop at their ends, and no active row starts from either end', () => {
  const { stepIndex } = focus;
  assert.equal(stepIndex('next', -1, 3), 0);
  assert.equal(stepIndex('prev', -1, 3), 2);
  assert.equal(stepIndex('next', 2, 3), 0);
  assert.equal(stepIndex('prev', 0, 3), 2);
  assert.equal(stepIndex('next', 0, 3), 1);
  assert.equal(stepIndex('first', 2, 3), 0);
  assert.equal(stepIndex('last', 0, 3), 2);
  assert.equal(stepIndex('next', 2, 3, false), 2);
  assert.equal(stepIndex('prev', 0, 3, false), 0);
  assert.equal(stepIndex('prev', 2, 3, false), 1);
});
