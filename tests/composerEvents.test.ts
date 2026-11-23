import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../src/store/types.ts';

const { dispatchComposerFocus, dispatchComposerSelection, dispatchComposerText, focusComposer, receiveComposerSelection } = await import(
  '../src/lib/composerEvents.ts'
);

test("global focus shortcuts reach the main composer (the focused pane's), while targeted focus reaches only its chat", () => {
  for (const [event, id, main, expected] of [
    [new Event('focus-composer'), 'main', true, 1],
    [new Event('focus-composer'), 'side', false, 0],
    // a split pane that isn't focused
    [new Event('focus-composer'), 'pane', false, 0],
    [new CustomEvent('focus-composer', { detail: {} }), null, true, 1],
    [new CustomEvent('focus-composer', { detail: { threadId: 'side' } }), 'side', false, 1],
    [new CustomEvent('focus-composer', { detail: { threadId: 'pane' } }), 'pane', false, 1],
    [new CustomEvent('focus-composer', { detail: { threadId: 'side' } }), 'main', true, 0],
  ] as const) {
    let focused = 0;
    focusComposer(event, id, main, () => {
      focused++;
    });
    assert.equal(focused, expected);
  }
});

test('selection delivery preserves the latest unsaved text and attachments and acknowledges the matching composer', () => {
  const target = new EventTarget();
  const existing = { kind: 'selection', text: 'existing', path: '', name: 'Selection' } as Attachment;
  const live = { text: 'unsaved question', selections: [existing], focused: 0 };
  const actions = {
    retainSelection: () => assert.fail('current receiver needs no fallback'),
    current: () => true,
    appendSelection: (attachment: Attachment) => {
      live.selections.push(attachment);
      return { committed: true };
    },
    focus: () => {
      live.focused++;
    },
  };
  target.addEventListener('composer-add-selection', (event) => receiveComposerSelection(event, 'other', actions));
  assert.equal(dispatchComposerSelection(target, 'side', 'unhandled'), false);
  assert.deepEqual(live, { text: 'unsaved question', selections: [existing], focused: 0 });
  target.addEventListener('composer-add-selection', (event) => receiveComposerSelection(event, 'side', actions));
  assert.equal(dispatchComposerSelection(target, 'side', 'new passage'), true);
  assert.equal(live.text, 'unsaved question');
  assert.deepEqual(
    live.selections.map((a) => a.text),
    ['existing', 'new passage'],
  );
  assert.equal(live.focused, 1);
  target.dispatchEvent(
    new CustomEvent('composer-add-selection', { detail: { threadId: 'side', text: 'commented passage', comment: '  explain this  ' } }),
  );
  assert.equal(live.text, 'unsaved question');
  assert.equal(live.selections.at(-1)?.annotation, '  explain this  ');
  assert.deepEqual(
    live.selections.map((a) => a.text),
    ['existing', 'new passage', 'commented passage'],
  );
  target.dispatchEvent(new CustomEvent('composer-add-selection', { detail: { threadId: 'side', text: 'no comment', comment: '   ' } }));
  assert.equal(live.text, 'unsaved question');
  assert.equal(live.focused, 3);
});

test('an explicit annotation preserves its ID, source and focus preference', () => {
  const annotation: Attachment = {
    kind: 'selection',
    path: '',
    name: 'Annotation',
    text: 'passage',
    annotation: 'explain',
    annotationId: 'stable-id',
    source: { messageId: 'reply', start: 0, end: 7 },
  };
  const detail = { threadId: 'side', text: 'ignored fallback', attachment: annotation, focus: false, handled: false };
  let received: Attachment | undefined;
  receiveComposerSelection(new CustomEvent('composer-add-selection', { detail }), 'side', {
    retainSelection: () => assert.fail('current receiver needs no fallback'),
    current: () => true,
    appendSelection: (a) => {
      received = a;
      return { committed: true };
    },
    focus: () => assert.fail('focus:false must preserve the comment input focus'),
  });
  assert.equal(detail.handled, true);
  assert.strictEqual(received, annotation);
});

test('an unmounted composer does not acknowledge delivery, and deferred focus events name the side chat', () => {
  const target = new EventTarget();
  assert.equal(dispatchComposerSelection(target, 'side', 'passage'), false);
  let focused = 0;
  target.addEventListener('focus-composer', (event) =>
    focusComposer(event, 'side', false, () => {
      focused++;
    }),
  );
  dispatchComposerFocus(target, 'side');
  assert.equal(focused, 1);
});

test("text for a chat's composer reports whether a composer on screen took it", () => {
  const target = new EventTarget();
  assert.equal(dispatchComposerText(target, 'chat', 'review this'), false);
  const got: unknown[] = [];
  target.addEventListener('composer-insert', (event) => {
    const detail = (event as CustomEvent<{ threadId: string; text: string; handled: boolean }>).detail;
    got.push([detail.threadId, detail.text]);
    detail.handled = true;
  });
  assert.equal(dispatchComposerText(target, 'chat', 'review this'), true);
  assert.deepEqual(got, [['chat', 'review this']]);
});

test("scoped text receipt commits before acknowledging and legacy strings reach the focused pane's composer alone", async () => {
  const { receiveComposerText } = await import('../src/lib/composerEvents.ts');
  const calls: any[] = [];
  const insert = (...args: any[]) => {
    calls.push(args);
    return { committed: true };
  };
  receiveComposerText(new CustomEvent('composer-insert', { detail: 'legacy' }), 'chat', false, insert);
  assert.deepEqual(calls, []);
  receiveComposerText(new CustomEvent('composer-insert', { detail: 'legacy' }), 'chat', true, insert);
  assert.deepEqual(calls.pop(), ['legacy', [], false]);
  const detail = { threadId: 'chat', text: 'new', handled: false };
  receiveComposerText(new CustomEvent('composer-insert', { detail }), 'other', false, insert);
  assert.equal(detail.handled, false);
  receiveComposerText(new CustomEvent('composer-insert', { detail }), 'chat', false, (...args) => {
    assert.equal(detail.handled, false);
    return insert(...args);
  });
  assert.equal(detail.handled, true);
  assert.deepEqual(calls.pop(), ['new', [], false]);
});

test('a failed text receiver never acknowledges the offered input', async () => {
  const { receiveComposerText } = await import('../src/lib/composerEvents.ts');
  const detail = { threadId: 'chat', text: 'queued', handled: false };
  assert.throws(
    () =>
      receiveComposerText(new CustomEvent('composer-insert', { detail }), 'chat', false, () => {
        throw new Error('receiver failed');
      }),
    /receiver failed/,
  );
  assert.equal(detail.handled, false);
});

test('selection receipt refuses failure and retains input for a retired receiver', () => {
  const detail = { threadId: 'chat', text: 'quote', handled: false };
  const event = new CustomEvent('composer-add-selection', { detail });
  assert.throws(
    () =>
      receiveComposerSelection(event, 'chat', {
        appendSelection: () => {
          throw new Error('refused');
        },
        retainSelection: () => assert.fail('current receiver needs no fallback'),
        current: () => true,
        focus: () => assert.fail('no focus'),
      }),
    /refused/,
  );
  assert.equal(detail.handled, false);
  receiveComposerSelection(event, 'chat', {
    appendSelection: () => ({ committed: false }),
    retainSelection: () => {},
    current: () => false,
    focus: () => assert.fail('no focus'),
  });
  assert.equal(detail.handled, true);
});

test('selection receipt acknowledges only once and only after retained delivery succeeds', () => {
  const detail = { threadId: 'chat', text: 'quote', handled: false };
  const event = new CustomEvent('composer-add-selection', { detail });
  let appends = 0;
  const actions = {
    appendSelection: () => {
      appends++;
      return { committed: false };
    },
    current: () => false,
    focus: () => assert.fail('retired'),
    retainSelection: () => {
      throw Error('save failed');
    },
  };
  assert.throws(() => receiveComposerSelection(event, 'chat', actions), /save failed/);
  assert.equal(detail.handled, false);
  receiveComposerSelection(event, 'chat', { ...actions, retainSelection: () => {} });
  receiveComposerSelection(event, 'chat', actions);
  assert.equal(appends, 2);
  assert.equal(detail.handled, true);
});

test('a refused selection is distinct from an unmounted receiver and never falls back to persistence', () => {
  const target = new EventTarget();
  target.addEventListener('composer-add-selection', (event) =>
    receiveComposerSelection(event, 'c', {
      appendSelection: () => ({ committed: false, refused: true }),
      current: () => true,
      focus: () => assert.fail('refused input must not focus'),
      retainSelection: () => assert.fail('refused input must not be retained as unmounted'),
    }),
  );
  assert.equal(dispatchComposerSelection(target, 'c', 'quote'), 'refused');
});
