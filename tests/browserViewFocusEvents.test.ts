// Native page focus selects only the window actually showing it, including repeated focused input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWC, FakeWindow, setup } from './support/browser-view-fixture.ts';

test('input reselects an already focused shown page; background pages and passive events cannot select a tool', () => {
  const { views, sender } = setup();
  const bound = views.bind('active-input', sender, { url: 'about:blank' });
  const entry = views.entryOf(bound.id);
  let focused = true;
  entry.wc.isFocused = () => focused;
  const input = (type: string) =>
    entry.wc.emit(type === 'mouseDown' || type === 'mouseMove' ? 'before-mouse-event' : 'before-input-event', {}, { type });
  input('mouseDown');
  assert.equal(sender.sent.length, 0, 'a parked page cannot take selection');
  views.show(entry.id, sender, { x: 0, y: 0, width: 400, height: 300 });
  sender.sent.length = 0;
  input('mouseMove');
  input('keyUp');
  focused = false;
  input('mouseDown');
  input('keyDown');
  assert.equal(sender.sent.length, 0, 'passive and unfocused page input cannot take selection');
  focused = true;
  input('mouseDown');
  input('keyDown');
  assert.deepEqual(
    sender.sent.map(([, event]: any) => event.type),
    ['focus', 'focus'],
  );
});

test('only the window showing a shared page receives focus; page state still reaches every binder', () => {
  const second = new FakeWC();
  const otherWindow = new FakeWindow();
  const { views, sender } = setup({ windowOf: (s: any) => (s === second ? otherWindow : null) });
  const bound = views.bind('shared', sender, { url: 'about:blank' });
  views.bind('shared', second);
  const entry = views.entryOf(bound.id);
  entry.wc.isFocused = () => true;
  entry.wc.emit('focus');
  assert.deepEqual(sender.sent, [], 'a parked page has no window to select');
  assert.deepEqual(second.sent, []);
  views.show(entry.id, sender, { x: 0, y: 0, width: 400, height: 300 });
  views.show(entry.id, second, { x: 0, y: 0, width: 400, height: 300 });
  sender.sent.length = second.sent.length = 0;
  entry.wc.emit('focus');
  entry.wc.emit('before-mouse-event', {}, { type: 'mouseDown' });
  entry.wc.emit('before-input-event', {}, { type: 'keyDown' });
  entry.wc.emit('page-title-updated');
  assert.deepEqual(
    sender.sent.map(([, event]: any) => event.type),
    ['page-title-updated'],
  );
  assert.deepEqual(
    second.sent.map(([, event]: any) => event.type),
    ['focus', 'focus', 'focus', 'page-title-updated'],
  );
});
