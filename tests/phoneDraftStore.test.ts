// The draft store keeps every chat's draft outside the React tree (#4986 F1): per-key handles, listeners only for their own key, and a clear that takes back only the text the computer accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDraftStore, draftKey } from '../mobile/src/presentation/drafts';

test('A: a draft is read back, per account, computer and chat, and the handle for a key is the same one each time', () => {
  const store = createDraftStore();
  const a = store.of(draftKey('u', 'p', 'c1'));
  const b = store.of(draftKey('u', 'p', 'c2'));
  assert.equal(store.of(draftKey('u', 'p', 'c1')), a, 'a stable handle: a screen holding it is not re-rendered by another chat');
  assert.equal(a.get(), '');
  a.set('first');
  assert.equal(a.get(), 'first');
  assert.equal(b.get(), '', 'another chat has its own draft');
});

test('A: only a draft’s own listeners are told, once per change, and a listener that stopped is not', () => {
  const store = createDraftStore();
  const a = store.of('a');
  const b = store.of('b');
  const told: string[] = [];
  const stopA = a.subscribe(() => told.push('a'));
  b.subscribe(() => told.push('b'));
  a.set('x');
  a.set('x');
  assert.deepEqual(told, ['a'], 'the same text again is no change');
  b.set('y');
  stopA();
  a.set('z');
  assert.deepEqual(told, ['a', 'b']);
});

test('W: the computer accepted the text sent: only that text is taken back, and words typed meanwhile stay', () => {
  const store = createDraftStore();
  const a = store.of('a');
  const told: number[] = [];
  a.subscribe(() => told.push(1));
  a.set('hello');
  a.set('hello there');
  a.clear('hello');
  assert.equal(a.get(), 'hello there', 'a send of the older text does not erase what was typed since');
  assert.equal(told.length, 2, 'nothing changed, nobody is told');
  a.clear('hello there');
  assert.equal(a.get(), '');
  assert.equal(told.length, 3);
});

test('B: a draft outlives the screen that showed it: a handle asked for again finds the text (a closed chat, a push reply added to it)', () => {
  const store = createDraftStore();
  store.of('chat').set('half a thought');
  const later = store.of('chat');
  later.set(later.get() ? `${later.get()}\nreply from the notification` : 'reply');
  assert.equal(store.of('chat').get(), 'half a thought\nreply from the notification');
});

test('I: a listener that stops itself while the others are told does not break the walk', () => {
  const store = createDraftStore();
  const a = store.of('a');
  const told: string[] = [];
  const stop = a.subscribe(() => (told.push('one'), stop()));
  a.subscribe(() => told.push('two'));
  a.set('x');
  a.set('y');
  assert.deepEqual(told, ['one', 'two', 'two']);
});
