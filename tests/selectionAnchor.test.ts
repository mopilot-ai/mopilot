import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { selectionSource, selectionRange } from '../src/lib/selectionAnchor.ts';
import type { Attachment } from '../src/store/types.ts';

const window = new Window();
for (const name of ['window', 'document', 'Element', 'NodeFilter'])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : (window as any)[name] });
after(() => window.happyDOM.abort());

function setup() {
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-selection-source="other">other</div><div data-selection-source="reply"><span>first </span><em>中文 🙂</em><span> last</span></div>';
  const root = container.lastElementChild!;
  const range = document.createRange();
  range.setStart(root.firstElementChild!.firstChild!, 2);
  range.setEnd(root.children[1].firstChild!, 5);
  const attachment: Attachment = {
    kind: 'selection',
    path: '',
    name: 'Annotation',
    text: range.toString(),
    source: selectionSource(range),
  };
  return { container, root, range, attachment };
}

test('selection offsets identify the exact message and restore ranges across inline markdown nodes', () => {
  const { container, attachment } = setup();
  assert.deepEqual(attachment.source, { messageId: 'reply', start: 2, end: 11 });
  assert.equal(selectionRange(container, attachment)?.toString(), attachment.text);
});

test('text-node selections and exact end boundaries survive markdown node replacement', () => {
  const { container, root } = setup();
  const range = document.createRange();
  range.selectNodeContents(root.firstElementChild!.firstChild!);
  const attachment: Attachment = { kind: 'selection', name: '', path: '', text: range.toString(), source: selectionSource(range) };
  root.innerHTML = '<b>first</b><span> </span><i>中文 🙂 last</i>';
  assert.equal(selectionRange(container, attachment)?.toString(), 'first ');
});

test('selections outside a source message have no persistent anchor', () => {
  const range = document.createRange();
  assert.equal(selectionSource(range), undefined);
  const root = document.createElement('div');
  root.textContent = 'plain';
  range.selectNodeContents(root.firstChild!);
  assert.equal(selectionSource(range), undefined);
  root.setAttribute('data-selection-source', '');
  assert.equal(selectionSource(range), undefined);
});

test('a missing source, removed message or replaced quote hides the marker instead of selecting unrelated text', () => {
  const { container, root, attachment } = setup();
  assert.equal(selectionRange(container, { ...attachment, source: undefined }), null);
  root.textContent = 'different long enough text';
  assert.equal(selectionRange(container, attachment), null);
  root.remove();
  assert.equal(selectionRange(container, attachment), null);
});

test('offsets beyond the current text find the quote again in its message, and no quote finds nothing', () => {
  const { container, attachment } = setup();
  for (const moved of [{ end: 999 }, { start: 998, end: 999 }])
    assert.equal(selectionRange(container, { ...attachment, source: { ...attachment.source!, ...moved } })?.toString(), attachment.text);
  assert.equal(selectionRange(container, { ...attachment, text: undefined }), null);
});

test('empty text nodes and whitespace around a quote do not change its source position', () => {
  const { container, root } = setup();
  root.replaceChildren(document.createTextNode(''), document.createTextNode('  chosen  '));
  const range = document.createRange();
  range.selectNodeContents(root);
  const attachment: Attachment = { kind: 'selection', name: '', path: '', text: 'chosen', source: selectionSource(range) };
  assert.equal(selectionRange(container, attachment)?.toString(), '  chosen  ');
});

test('whole-message anchors survive native paragraph formatting and draft restoration without accepting changed content', () => {
  const container = document.createElement('div');
  container.innerHTML = '<div data-selection-source="reply"><p>first paragraph</p>\n<p>second paragraph</p></div>';
  const root = container.firstElementChild!;
  const range = document.createRange();
  range.selectNodeContents(root);
  // Chromium copies a blank line between paragraphs; the markdown DOM has one text-node newline.
  const text = 'first paragraph\n\nsecond paragraph';
  const attachment: Attachment = {
    kind: 'selection',
    name: 'Annotation',
    path: '',
    text,
    source: selectionSource(range, text),
  };
  const restored = JSON.parse(JSON.stringify(attachment));
  assert.equal(selectionRange(container, restored)?.toString(), 'first paragraph\nsecond paragraph');
  assert.equal(restored.text, text, 'the displayed and sent quote keeps its native formatting');
  root.innerHTML = '<p>first paragraph</p>\n<p>changed contents</p>';
  assert.equal(selectionRange(container, restored), null, 'equal length alone does not establish ownership');
});

test('a message re-read under a new id (a harness replaying its transcript) keeps its marker by its quoted text', () => {
  const { container, root, attachment } = setup();
  root.setAttribute('data-selection-source', 'replayed-id');
  const range = selectionRange(container, attachment);
  assert.equal(range?.toString(), attachment.text);
  assert.equal(range?.startContainer, root.firstElementChild!.firstChild, 'at the same place in the message');
});

test('with its id gone, the occurrence nearest the old offset wins and messages holding messages are skipped', () => {
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-selection-source="thread"><div data-selection-source="a">note one, note two</div><div data-selection-source="b">x note</div></div>';
  const attachment: Attachment = { kind: 'selection', name: '', path: '', text: 'note', source: { messageId: 'gone', start: 11, end: 15 } };
  const range = selectionRange(container, attachment)!;
  assert.equal(range.toString(), 'note');
  assert.equal(range.startOffset, 10, 'the second "note", nearest offset 11');
  assert.equal(range.startContainer.parentElement?.dataset.selectionSource, 'a');
  const far = selectionRange(container, { ...attachment, source: { ...attachment.source!, start: 2, end: 6 } })!;
  assert.equal([far.startContainer.parentElement?.dataset.selectionSource, far.startOffset].join(':'), 'b:2');
});

test('with its id gone and its text nowhere, a removed message still hides the marker', () => {
  const { container, attachment } = setup();
  assert.equal(
    selectionRange(container, { ...attachment, source: { ...attachment.source!, messageId: 'gone', text: 'absent quote' } }),
    null,
  );
  assert.equal(selectionRange(container, { ...attachment, text: '  ', source: { ...attachment.source!, messageId: 'gone' } }), null);
});

test('an id now naming another message, or a renumbered one, finds the quote in its own message first', () => {
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-selection-source="msg_B:t0">same words</div><div data-selection-source="msg_A:0">other text</div><div data-selection-source="msg_A:t1">xxxxxxxxxx same words</div>';
  const attachment: Attachment = {
    kind: 'selection',
    name: '',
    path: '',
    text: 'same words',
    source: { messageId: 'msg_A:0', start: 0, end: 10 },
  };
  const range = selectionRange(container, attachment)!;
  assert.equal(range.startContainer.parentElement?.dataset.selectionSource, 'msg_A:t1', 'the renumbered reply, not the nearer offset');
  const plain = selectionRange(container, { ...attachment, source: { ...attachment.source!, messageId: 'gone' } })!;
  assert.equal(plain.startContainer.parentElement?.dataset.selectionSource, 'msg_B:t0', 'without a stem, the nearest offset');
});
