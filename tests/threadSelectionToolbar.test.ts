// The floating bar over selected conversation text: where it sits, when it hides, and what
// "Reply" (an annotation with an optional comment) and "Start a side chat" send.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, createRef } from 'react';
import {
  mockStore,
  autoMock,
  render,
  settle,
  callsTo,
  moduleCalls,
  resetStore,
  setStore,
  useStore,
  impl,
  window,
} from './support/thread-kit.ts';

mockStore();
let dictate: ((t: string) => void) | null = null;
autoMock('src/components/ui/Dictation.tsx', 'dictation', {
  Dictation: ({ onText }: any) => {
    dictate = onText;
    return h('i', { 'data-stub': 'Dictation' });
  },
});
const { SelectionToolbar } = await import('../src/components/thread/SelectionToolbar.tsx');

(globalThis as any).DOMRect = window.DOMRect;
const frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb) => frames.push(cb);
globalThis.cancelAnimationFrame = () => {};
const flush = () =>
  settle(() => {
    for (const cb of frames.splice(0)) cb(0);
  });

const rect = (left: number, top: number, width: number, height: number) => new window.DOMRect(left, top, width, height);
let selection: any = null;
let removed = 0;
Object.defineProperty(window, 'getSelection', { configurable: true, value: () => selection });
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });

// only message text can be quoted: the selection sits in a message body
const container = document.createElement('div');
const body = document.createElement('div');
body.className = 'user-bubble';
const textNode = document.createTextNode('selected words');
body.append(textNode);
container.append(body);
document.body.append(container);
container.getBoundingClientRect = () => rect(0, 0, 800, 600) as any;
const ref = createRef<HTMLElement>() as any;
ref.current = container;

/** A selection of `text` whose line boxes are `rects`. */
function select(text: string, rects: DOMRect[], node: Node = textNode) {
  const range: any = {
    getClientRects: () => rects,
    cloneRange: () => range,
    commonAncestorContainer: node,
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 0,
  };
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: () => removed++,
  };
}
const fire = (target: EventTarget, type: string, init: any = {}) =>
  settle(() => target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true, ...init }) as any));
const keydown = (target: EventTarget, key: string, extra: any = {}) =>
  settle(() => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.assign(e, extra);
    target.dispatchEvent(e as any);
  });
const bar = () => document.querySelector('.selection-toolbar') as HTMLElement | null;
const button = (label: string) =>
  [...document.querySelectorAll('.selection-toolbar button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  ) as HTMLElement;
const changes = async () => {
  await fire(document, 'selectionchange');
  await flush();
};

beforeEach(() => {
  resetStore({ drafts: {} });
  impl['store:openSideChat'] = async () => 'side-chat';
  selection = null;
  removed = 0;
  moduleCalls.length = 0;
  frames.length = 0;
});

test('text already selected when the toolbar mounts gets its bar, with no further event', async () => {
  // a remount while the reader holds a selection: an approval card that cleared, or the bar's own chat re-keyed
  select('selected words', [rect(10, 100, 200, 20)]);
  const a = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  await flush();
  assert.ok(bar(), 'the reader still has the selection, so the bar belongs on it');
  await a.unmount();
});

test('a read that found nothing is taken again when the transcript itself changes', async () => {
  // the one read after a selectionchange lands while the selection's line box is outside the conversation viewport
  select('selected words', [rect(10, 700, 200, 20)]);
  const a = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  await changes();
  assert.ok(!bar(), 'nothing to place the bar on yet');
  // the transcript settles where it is: a reply that finished growing, a card that appeared below it. No scroll
  // and no window resize, so only the transcript's own change can make the bar look again.
  select('selected words', [rect(10, 100, 200, 20)]);
  const grown = document.createElement('span');
  await settle(() => body.append(grown));
  await flush();
  const placed = bar();
  assert.ok(placed, 'the bar is placed once the selection is back in view');
  // a further change that moves nothing keeps the bar that is already there
  await settle(() => body.append(document.createElement('span')));
  await flush();
  assert.equal(bar(), placed);
  grown.remove();
  body.querySelectorAll('span').forEach((el) => el.remove());
  await a.unmount();
});

test('no bar without a container or a usable selection inside it', async () => {
  const empty = createRef<HTMLElement>();
  const a = await render(h(SelectionToolbar, { containerRef: empty, threadId: 't' }));
  await changes();
  assert.ok(!bar());
  await a.unmount();

  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  await changes(); // no selection at all
  assert.ok(!bar());
  const outside = document.createTextNode('elsewhere');
  document.body.append(outside);
  for (const s of [
    () => {
      select('x', [rect(10, 100, 50, 20)]);
      selection.isCollapsed = true;
    },
    () => {
      select('x', [rect(10, 100, 50, 20)]);
      selection.rangeCount = 0;
    },
    () => select('x', [rect(10, 100, 50, 20)], outside),
    () => {
      // the range ends in text outside every message body, and the selection holds that text
      select('selected words\nelsewhere', [rect(10, 100, 50, 20)]);
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(outside, outside.length);
      selection.getRangeAt = () => range;
    },
    () => {
      // the same range with no text of its own selected
      select('', [rect(10, 100, 50, 20)]);
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(outside, outside.length);
      selection.getRangeAt = () => range;
    },
    () => select('   ', [rect(10, 100, 50, 20)]),
    () => select('x', [rect(10, -100, 50, 20), rect(900, 100, 50, 20)]), // scrolled out above, beyond the right edge
  ]) {
    s();
    await changes();
    assert.ok(!bar());
  }
  await v.unmount();
});

test('a whole paragraph selected to the start of the action row below still gets its bar', async () => {
  // a triple click on a message's last paragraph: Chromium ends the range at offset 0 of the next block
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.append(document.createElement('button'));
  container.append(actions);
  const proto = (window as any).Range.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = () => [rect(10, 100, 200, 20)];
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(actions, 0);
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: actions,
    toString: () => 'selected words\n',
    getRangeAt: () => range,
    removeAllRanges: () => removed++,
  };
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  await changes();
  try {
    assert.ok(bar(), 'the selection is all message text, so the bar is offered');
    assert.ok(button('Reply'));
    assert.ok(button('Start a side chat'));
  } finally {
    proto.getClientRects = original;
    actions.remove();
    await v.unmount();
  }
});

test('a whole paragraph selected to the start of the next message still gets its bar', async () => {
  // a triple click on a reply's last paragraph with another reply right below: the range ends at offset 0 of that reply's first line
  const reply = (id: string, text: string) => {
    const message = document.createElement('div');
    message.className = 'assistant-message';
    message.innerHTML = `<div data-selection-source="${id}"><div class="md"><p>${text}</p></div></div>`;
    container.append(message);
    return message;
  };
  const first = reply('one', 'last paragraph');
  const second = reply('two', 'next reply');
  const proto = (window as any).Range.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = () => [rect(10, 100, 200, 20)];
  const start = first.querySelector('p')!.firstChild!;
  const end = second.querySelector('p')!.firstChild!;
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, 0);
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: start,
    focusNode: end,
    // the selection's text is what the range covers, as the browser's is for selectable text
    toString: () => range.toString(),
    getRangeAt: () => range,
    removeAllRanges: () => removed++,
  };
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  await changes();
  try {
    assert.ok(bar(), 'the next reply has no selected text, so the bar is offered for this one');
    assert.ok(button('Reply'));
    // text of the next reply inside the selection makes it a selection of two messages: no bar
    range.setEnd(end, 4);
    await changes();
    assert.ok(!bar());
  } finally {
    proto.getClientRects = original;
    first.remove();
    second.remove();
    await v.unmount();
  }
});

test('the bar sits above the first visible line, hides while the mouse is down and on Esc', async () => {
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  select('selected words', [rect(10, -40, 50, 20), rect(100, 200, 200, 20)]);
  await changes();
  const style = bar()!.style;
  assert.equal(style.left, '200px');
  assert.equal(style.top, '192px');
  assert.equal(style.maxWidth, '784px', 'the popup fits the transcript, beside the other panes');
  assert.match(style.transform, /clamp\(-192px, -50%, calc\(592px - 100%\)\)/);
  // a line near the top keeps the bar on screen
  select('selected words', [rect(100, 10, 200, 20)]);
  await changes();
  assert.equal(bar()!.style.top, '38px');

  // pressing on the bar itself keeps it
  await fire(button('Reply'), 'pointerdown');
  assert.ok(bar());
  await fire(document.body, 'pointerdown');
  assert.ok(!bar());
  await changes(); // still pressing
  assert.ok(!bar());
  await fire(window as any, 'pointerup');
  await flush();
  assert.ok(bar());

  await keydown(window as any, 'a');
  assert.ok(bar());
  await keydown(window as any, 'Escape');
  assert.ok(!bar());
  assert.equal(removed, 1);
  selection = null;
  await keydown(window as any, 'Escape'); // no selection object: nothing to clear
  await v.unmount();
});

test('a whole reply selected through surrounding elements attaches the complete text and source to its chat', async (t) => {
  const reply = document.createElement('div');
  reply.className = 'assistant-message';
  reply.innerHTML = '<div data-selection-source="whole"><div class="md">whole reply</div></div>';
  container.append(reply);
  const proto = window.Range.prototype as any;
  const original = proto.getClientRects;
  proto.getClientRects = () => [rect(10, 100, 200, 20)];
  const range = document.createRange();
  range.selectNodeContents(reply);
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => 'whole reply',
    getRangeAt: () => range,
    removeAllRanges: () => removed++,
  };
  const added: any[] = [];
  const listen = (e: any) => added.push(e.detail);
  window.addEventListener('composer-add-selection', listen);
  const view = await render(h(SelectionToolbar, { containerRef: ref, threadId: 'whole-chat' }));
  t.after(async () => {
    await view.unmount();
    window.removeEventListener('composer-add-selection', listen);
    proto.getClientRects = original;
    reply.remove();
  });
  await changes();
  assert.ok(button('Start a side chat'));
  // A replacement reply can have the same words and line boxes; it still owns a different source.
  reply.querySelector<HTMLElement>('[data-selection-source]')!.dataset.selectionSource = 'replacement';
  await changes();
  await settle(() => button('Reply').click());
  assert.equal(added[0].threadId, 'whole-chat');
  assert.equal(added[0].attachment.text, 'whole reply');
  assert.deepEqual(added[0].attachment.source, { messageId: 'replacement', start: 0, end: 11 });
});

test('mousedown on a button keeps the selection; Start a side chat opens one with the text', async () => {
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  select('selected words', [rect(100, 200, 200, 20)]);
  await changes();
  const md = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button('Start a side chat').dispatchEvent(md as any);
  assert.equal(md.defaultPrevented, true);
  await settle(() => button('Start a side chat').click());
  assert.deepEqual(callsTo('store:openSideChat'), [['t', 'selected words']]);
  assert.equal(removed, 1);
  assert.ok(!bar());
  await v.unmount();
});

for (const boundary of ['startContainer', 'startOffset', 'endContainer', 'endOffset'] as const) {
  test(`equal text and geometry still replace an anchor with a different ${boundary}`, async (t) => {
    const other = document.createTextNode('selected words');
    body.append(other);
    const view = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
    t.after(async () => {
      await view.unmount();
      other.remove();
    });
    select('selected words', [rect(100, 200, 200, 20)]);
    await changes();
    const old = selection.getRangeAt(0);
    select('selected words', [rect(100, 200, 200, 20)]);
    selection.getRangeAt(0)[boundary] = boundary.endsWith('Container') ? other : 1;
    await changes();
    // Only the current range stays visible once the old DOM layout is retired.
    old.getClientRects = () => [];
    await settle(() => button('Reply').click());
    await flush();
    assert.ok(document.querySelector('.annotation-comment-toolbar'), 'the annotation edits the current range');
  });
}

test('Reply attaches an annotation at once; its optional comment takes dictation and is saved', async () => {
  const added: any[] = [];
  const updated: any[] = [];
  const onAdd = (e: any) => added.push(e.detail);
  const onUpdate = (e: any) => updated.push(e.detail);
  window.addEventListener('composer-add-selection', onAdd);
  window.addEventListener('composer-update-selection', onUpdate);
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  select('selected words', [rect(100, 200, 200, 20)]);
  await changes();
  await settle(() => button('Reply').click());
  assert.equal(added.length, 1);
  assert.deepEqual(
    [added[0].attachment.text, added[0].threadId, added[0].focus, added[0].attachment.kind],
    ['selected words', 't', false, 'selection'],
  );
  const id = added[0].attachment.annotationId;
  await flush();
  const input = document.querySelector('.annotation-comment-input input') as HTMLInputElement;
  assert.ok(input);
  assert.equal(bar()!.style.top, '192px');
  // the saved range anchors the comment bar while the selection itself is gone
  selection = null;
  await changes();
  assert.ok(bar());
  await settle(() => dictate!('hello'));
  assert.equal(input.value, 'hello');
  await settle(() => dictate!('world'));
  assert.equal(input.value, 'hello world');
  await settle(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'note');
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  assert.deepEqual(
    updated.map((u) => [u.threadId, u.annotationId, u.annotation]),
    [
      ['t', id, 'hello'],
      ['t', id, 'hello world'],
      ['t', id, 'note'],
    ],
  );
  const focused: any[] = [];
  const onFocus = (e: any) => focused.push(e.detail);
  window.addEventListener('focus-composer', onFocus);
  await fire(input.form!, 'submit');
  window.removeEventListener('focus-composer', onFocus);
  assert.ok(!bar());
  assert.equal(added.length, 1, 'saving the comment adds nothing more');
  assert.deepEqual(focused, [{ threadId: 't' }], 'the composer takes focus, so a second Enter sends');
  window.removeEventListener('composer-add-selection', onAdd);
  window.removeEventListener('composer-update-selection', onUpdate);
  await v.unmount();
});

test('the comment bar cancels with Escape and hides while its range is scrolled away', async () => {
  const added: any[] = [];
  const onAdd = (e: any) => added.push(e.detail);
  window.addEventListener('composer-add-selection', onAdd);
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  const open = async () => {
    select('selected words', [rect(100, 200, 200, 20)]);
    await changes();
    await settle(() => button('Reply').click());
    await flush();
  };
  await open();
  const input = document.querySelector('.annotation-comment-input input') as HTMLInputElement;
  await keydown(input, 'Escape');
  assert.ok(!bar());
  assert.equal(added.length, 1, 'the annotation stays in the composer');

  await open();
  const range = selection.getRangeAt(0);
  range.getClientRects = () => [rect(100, -300, 200, 20)];
  await fire(container, 'scroll');
  await flush();
  assert.ok(!bar());
  range.getClientRects = () => [rect(100, 200, 200, 20)];
  await fire(container, 'scroll');
  await flush();
  assert.ok(bar(), 'back in view');
  await fire(document.body, 'pointerdown');
  await fire(window as any, 'pointerup');
  await flush();
  window.removeEventListener('composer-add-selection', onAdd);
  await v.unmount();
});

for (const initiallyAbsent of [true, false])
  test(`source comments retain input with no composer (absent initially: ${initiallyAbsent})`, async () => {
    impl['store:setDraft'] = (id: string, draft: unknown) => setStore((s: any) => ({ drafts: { ...s.drafts, [id]: draft } }));
    const receive = (e: any) => {
      e.detail.handled = true;
      impl['store:setDraft']('t', { text: '', attachments: [e.detail.attachment] });
    };
    if (!initiallyAbsent) window.addEventListener('composer-add-selection', receive);
    const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
    try {
      select('selected words', [rect(100, 200, 200, 20)]);
      await changes();
      await settle(() => button('Reply').click());
      await flush();
      window.removeEventListener('composer-add-selection', receive);
      const field = document.querySelector('.annotation-comment-input input') as HTMLInputElement;
      await settle(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
          field,
          'Retained after approval replaced composer',
        );
        field.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
      });
      await keydown(field, 'Escape');
      assert.equal(useStore.getState().drafts.t.attachments[0].annotation, 'Retained after approval replaced composer');
      assert.equal(useStore.getState().drafts.t.attachments[0].text, 'selected words');
    } finally {
      window.removeEventListener('composer-add-selection', receive);
      delete impl['store:setDraft'];
      await v.unmount();
    }
  });
