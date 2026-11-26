// Desktop composer slash highlights retain draft text, native edits, and per-editor ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { mount, act } from './support/composer-list-editor.ts';
import { window } from './support/dom.ts';
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

function installHighlights(t: { after: (fn: () => void) => void }) {
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
  return { highlights, ranges: () => [...(highlights.get('composer-slash-command') ?? [])].map(String) };
}

type Target = { dispatchEvent(event: any): unknown };
const compose = (el: Target, type: 'compositionstart' | 'compositionend') =>
  act(() => el.dispatchEvent(new window.CompositionEvent(type, { bubbles: true })));
const typeInput = (el: Target) =>
  act(() => el.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' })));
/** Marked text appended after the token in its own node, the way a browser draws a composition. */
const markText = (el: HTMLElement, text: string) => el.append(document.createTextNode(text));

test('a recognized token keeps its highlight while an input method composes after it, and is rebuilt when the composition ends', async (t) => {
  const { highlights, ranges } = installHighlights(t);
  const m = await mount('/notes ', [], { commandPresentation: { ranges: [{ start: 0, end: 6 }] } });
  try {
    assert.deepEqual(ranges(), ['/notes']);
    await compose(m.el, 'compositionstart');
    assert.deepEqual(ranges(), ['/notes'], 'composition start keeps the range');
    markText(m.el, 'ni');
    await typeInput(m.el);
    assert.deepEqual(ranges(), ['/notes'], 'marked text outside the token never colors it or leaves the token plain');
    assert.equal(m.el.dataset.commandHint, undefined);
    await compose(m.el, 'compositionend');
    assert.deepEqual(ranges(), ['/notes'], 'recomputed from the committed draft');
  } finally {
    await m.close();
  }
  assert.equal(highlights.size, 0);
});

test('a range whose text stops being its token is dropped during composition, and only that range', async (t) => {
  const { highlights, ranges } = installHighlights(t);
  // the reference is its own element, so each token lives in its own text node (happy-dom ranges do not shift with edits)
  const text = `/notes ${sessionToken('chat-2', 'Build chat')} /notes`;
  const start = text.lastIndexOf('/notes');
  const m = await mount(text, [], {
    commandPresentation: {
      ranges: [
        { start: 0, end: 6 },
        { start, end: start + 6 },
      ],
    },
  });
  try {
    assert.deepEqual(ranges(), ['/notes', '/notes']);
    await compose(m.el, 'compositionstart');
    const textNode = m.el.firstChild as Text;
    // composing inside the first token: the browser inserts the marked text within its range
    textNode.insertData(3, 'zz');
    await typeInput(m.el);
    assert.deepEqual(ranges(), ['/notes'], 'the edited token is no longer colored, the other still is');
    assert.ok(!ranges().includes('/nozznotes'));
  } finally {
    await m.close();
  }
  assert.equal(highlights.size, 0);
});

test('a range whose text node was replaced during composition is dropped', async (t) => {
  const { ranges } = installHighlights(t);
  const m = await mount('/notes ', [], { commandPresentation: { ranges: [{ start: 0, end: 6 }] } });
  try {
    await compose(m.el, 'compositionstart');
    const node = m.el.firstChild!;
    node.parentNode!.replaceChild(document.createTextNode('/notes '), node);
    await typeInput(m.el);
    assert.deepEqual(ranges(), []);
  } finally {
    await m.close();
  }
});

test('unmounting mid-composition removes this composer ranges and leaves the other composer colored', async (t) => {
  const { highlights, ranges } = installHighlights(t);
  const first = await mount('/review ', [], { commandPresentation: { ranges: [{ start: 0, end: 7 }] } });
  const second = await mount('/notes ', [], { commandPresentation: { ranges: [{ start: 0, end: 6 }] } });
  try {
    await compose(first.el, 'compositionstart');
    assert.deepEqual(ranges().sort(), ['/notes', '/review']);
    await first.close();
    assert.deepEqual(ranges(), ['/notes']);
  } finally {
    await second.close();
  }
  assert.equal(highlights.size, 0);
});

test('a draft or catalog change during composition retires the held ranges', async (t) => {
  const { ranges } = installHighlights(t);
  const props = { commandPresentation: { ranges: [{ start: 0, end: 6 }] } as { ranges: { start: number; end: number }[] } };
  const m = await mount('/notes ', [], props);
  try {
    await compose(m.el, 'compositionstart');
    props.commandPresentation = { ranges: [] };
    await m.update('/notes ');
    assert.deepEqual(ranges(), [], 'a catalog change that no longer recognizes the token removes it');
  } finally {
    await m.close();
  }
});

test('goal and MoMo inputs and a composer without a highlight API color nothing during composition', async (t) => {
  const { highlights } = installHighlights(t);
  const plain = await mount('/notes ', []);
  try {
    await compose(plain.el, 'compositionstart');
    assert.equal(highlights.size, 0);
    await compose(plain.el, 'compositionend');
  } finally {
    await plain.close();
  }
  Reflect.deleteProperty(globalThis, 'CSS');
  const unsupported = await mount('/notes ', [], { commandPresentation: { ranges: [{ start: 0, end: 6 }] } });
  try {
    await compose(unsupported.el, 'compositionstart');
    await typeInput(unsupported.el);
  } finally {
    await unsupported.close();
  }
});

test('a draft change during composition releases the held ranges even when the spans keep their identity, and the end rebuilds them', async (t) => {
  const { ranges } = installHighlights(t);
  const m = await mount('/notes ', [], { commandPresentation: { ranges: [{ start: 0, end: 6 }] } });
  try {
    await compose(m.el, 'compositionstart');
    assert.deepEqual(ranges(), ['/notes']);
    await m.update('/notes later');
    assert.deepEqual(ranges(), [], 'ranges built for the old draft are not kept');
    await compose(m.el, 'compositionend');
    assert.deepEqual(ranges(), ['/notes'], 'rebuilt from the committed draft');
  } finally {
    await m.close();
  }
});

test('new spans during composition build nothing from un-synced offsets, and are colored when it ends', async (t) => {
  const { ranges } = installHighlights(t);
  const props = { commandPresentation: { ranges: [{ start: 0, end: 6 }] } };
  const m = await mount('/notes ', [], props);
  try {
    await compose(m.el, 'compositionstart');
    props.commandPresentation = { ranges: [{ start: 0, end: 3 }] };
    await m.update('/notes ');
    assert.deepEqual(ranges(), [], 'no range is created while composing');
    await compose(m.el, 'compositionend');
    assert.deepEqual(ranges(), ['/no']);
  } finally {
    await m.close();
  }
});
