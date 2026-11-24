// Desktop composer slash highlights retain draft text, native edits, and per-editor ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { mount } from './support/composer-list-editor.ts';
import type { Attachment } from '../src/store/types.ts';

const skill: Attachment = { kind: 'skill', name: 'notes', path: '/skills/notes/SKILL.md' };

test('command highlights color only editable text and cleanup preserves the other composer', async (t) => {
  const highlights = new Map<string, Set<Range>>();
  const css = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  const highlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
  Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true });
  Object.defineProperty(globalThis, 'Highlight', { value: Set, configurable: true });
  t.after(() => {
    if (css) Object.defineProperty(globalThis, 'CSS', css);
    else Reflect.deleteProperty(globalThis, 'CSS');
    if (highlight) Object.defineProperty(globalThis, 'Highlight', highlight);
    else Reflect.deleteProperty(globalThis, 'Highlight');
  });
  const ranges = () => [...(highlights.get('composer-slash-command') ?? [])];
  const first = await mount('/review ', [{ ...skill, textOffset: 3 }], {
    commandPresentation: { ranges: [{ start: 0, end: 7 }], hint: '[focus]' },
  });
  const reference = sessionToken('chat-2', 'Build chat');
  const text = `/notes ${reference} /notes`;
  const start = text.lastIndexOf('/notes');
  const presentation = () => ({
    ranges: [
      { start: 0, end: 6 },
      { start, end: start + 6 },
    ],
  });
  const secondProps = { commandPresentation: presentation() };
  const second = await mount(text, [], secondProps);
  try {
    assert.deepEqual(ranges().map(String), ['/re', 'view', '/notes', '/notes']);
    assert.equal(first.el.value, '/review ');
    assert.equal(first.el.dataset.commandHint, '[focus]');
    assert.equal(second.el.dataset.commandHint, undefined);
    const lastRange = ranges().at(-1);
    secondProps.commandPresentation = presentation();
    await second.update(text);
    assert.equal(ranges().at(-1), lastRange, 'equal offsets keep the existing browser ranges');
    const original = ranges()[0];
    original.startContainer.parentNode!.replaceChild(document.createTextNode('/re'), original.startContainer);
    await first.input();
    assert.ok(!ranges().includes(original), 'an edit must re-anchor ranges even when the serialized text is identical');
    assert.equal(first.el.value, '/review ');
  } finally {
    await first.close();
    try {
      assert.deepEqual(ranges().map(String), ['/notes', '/notes']);
    } finally {
      await second.close();
    }
  }
  assert.deepEqual(ranges(), []);
  assert.equal(highlights.size, 0);
});
