// Dictated text lands at the composer's caret, spaced like typed words (src/components/ui/dictationTarget.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { spaced, dictateInto } from '../src/components/ui/dictationTarget.ts';

test('dictated words are spaced from their neighbours as typed words are; CJK text joins without spaces', () => {
  assert.equal(spaced('', ' hello world ', ''), 'hello world');
  assert.equal(spaced('Note:', 'hello', ''), ' hello');
  assert.equal(spaced('Note: ', 'hello', ''), 'hello');
  assert.equal(spaced('(', 'hello', ')'), 'hello');
  assert.equal(spaced('say', 'hello', 'now'), ' hello ');
  assert.equal(spaced('say', 'hello', '.'), ' hello');
  assert.equal(spaced('say', 'hello', ' now'), ' hello');
  assert.equal(spaced('你好', '世界', '。'), '世界');
  assert.equal(spaced('hello', '世界', ''), '世界');
  assert.equal(spaced('世界', 'hello', 'there'), 'hello ');
  assert.equal(spaced('a', '   ', 'b'), '');
});

function editor(value: string, caret: number | null) {
  const el = document.createElement('div') as any;
  document.body.append(el);
  const text = document.createTextNode(value);
  el.append(text);
  const calls: any[] = [];
  let current = value;
  Object.defineProperties(el, {
    value: { get: () => current },
    selectionStart: { get: () => caret ?? 0 },
  });
  el.replaceRange = (start: number, end: number, insert: string) => {
    calls.push(['replace', start, end, insert]);
    current = current.slice(0, start) + insert + current.slice(end);
  };
  el.setCaretAfter = (t: string, at: number) => calls.push(['caret', t, at]);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  if (caret !== null) {
    const range = document.createRange();
    range.setStart(text, caret);
    selection.addRange(range);
  }
  return { el, calls, value: () => current };
}

test('text goes in at the caret, or at the end when the caret is elsewhere, and the caret follows it', () => {
  const at = editor('Fix the bug today', 8);
  dictateInto(at.el, 'login', () => assert.fail('the editor is there'));
  assert.equal(at.value(), 'Fix the login bug today');
  assert.deepEqual(at.calls.at(-1), ['caret', 'Fix the login bug today', 14]);
  const away = editor('Draft', null);
  dictateInto(away.el, 'more', () => assert.fail('the editor is there'));
  assert.equal(away.value(), 'Draft more');
  const silent = editor('Draft', 5);
  dictateInto(silent.el, '  ', () => assert.fail('the editor is there'));
  assert.deepEqual(silent.calls, []);
  let draft = 'Kept';
  dictateInto(null, 'words', (update) => (draft = update(draft)));
  assert.equal(draft, 'Kept words');
  // the user moved on to another pane's composer: the text joins the draft, and the focus stays where they are
  const composer = document.createElement('div');
  composer.className = 'composer';
  const late = editor('Mine', 4);
  composer.append(late.el);
  const other = document.createElement('input');
  document.body.append(composer, other);
  other.focus();
  let kept = 'Mine';
  dictateInto(late.el, 'later', (update) => (kept = update(kept)));
  assert.deepEqual([kept, late.calls, document.activeElement], ['Mine later', [], other]);
  // the mic button in its own composer still counts as here
  const mic = document.createElement('button');
  composer.append(mic);
  mic.focus();
  dictateInto(late.el, 'here', () => assert.fail('the caret is in this composer'));
  assert.equal(late.value(), 'Mine here');
});
