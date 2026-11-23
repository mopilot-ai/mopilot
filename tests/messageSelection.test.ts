import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { messageBodyRange } from '../src/lib/messageSelection.ts';
import { selectionRange, selectionSource } from '../src/lib/selectionAnchor.ts';

// the DOM typings describe what the components see; happy-dom provides it
const window = new Window() as unknown as typeof globalThis & Pick<Window, 'happyDOM'>;
Object.defineProperty(globalThis, 'Element', { configurable: true, value: window.Element });
Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: window.NodeFilter });
after(() => window.happyDOM.abort());

function fixture(html: string) {
  const root = window.document.createElement('div');
  root.innerHTML = html;
  window.document.body.append(root);
  return root;
}

function between(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const range = window.document.createRange();
  range.setStart(startNode as any, startOffset);
  range.setEnd(endNode as any, endOffset);
  return range as unknown as Range;
}
const whole = (node: Node) => between(node, 0, node, node.childNodes.length || (node as Text).length || 0);

for (const wrapper of [
  '<div class="user-bubble">BODY</div>',
  '<div class="assistant-message"><div data-selection-source="reply"><div class="md">BODY</div></div></div>',
  '<div class="commentary"><div data-selection-source="reply"><div class="md">BODY</div></div></div>',
  '<div class="plan-card"><div class="md">BODY</div></div>',
  '<div class="review-result"><div class="md">BODY</div></div>',
]) {
  test(`message selections allow inline markup, kept as they are: ${wrapper}`, () => {
    const root = fixture(wrapper.replace('BODY', '<span>first</span><em>second</em>'));
    const first = root.querySelector('span')!,
      second = root.querySelector('em')!;
    const range = between(first.firstChild!, 0, second.firstChild!, 6);
    assert.equal(messageBodyRange(range), range);
    const elements = between(first, 0, second, 1);
    assert.equal(messageBodyRange(elements), elements);
  });
}

test('system notices, activity labels, card headers and controls never qualify', () => {
  const root = fixture(`
    <div class="divider-label">Context automatically compacted</div>
    <div class="status-note">Model changed</div><button class="worked-for">Worked for 3s</button>
    <div class="error-banner">Error</div><div class="retry-banner">Retrying</div>
    <div class="plan-card"><div class="plan-card-head">Plan</div><button>Implement this plan</button></div>
    <div class="review-result"><div class="plan-card-head">Review</div></div>
    <div class="step-row"><div class="md">Tool output</div></div>
  `);
  for (const element of root.querySelectorAll('.divider-label, .status-note, button, .error-banner, .retry-banner, .plan-card-head, .md')) {
    assert.equal(messageBodyRange(whole(element.firstChild!)), null);
  }
});

test('selections spanning messages or crossing a system notice are rejected', () => {
  const root = fixture('<div class="user-bubble">first</div><div class="status-note">status</div><div class="user-bubble">second</div>');
  const [first, note, second] = Array.from(root.children).map((el) => el.firstChild!);
  assert.equal(messageBodyRange(between(first, 0, second, 3)), null);
  assert.equal(messageBodyRange(between(first, 0, note, 3)), null);
  // the notice's text sits between the first body and where the selection ends
  assert.equal(messageBodyRange(between(first, 0, second, 0)), null);
});

test('a paragraph selection that ends at the start of the next block is clamped to its body (#triple-click)', () => {
  // a triple click on a reply's last paragraph: Chromium ends the range at offset 0 of the action row below
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="reply"><div class="md"><p>first</p><p>last paragraph</p></div></div>
    <div class="message-actions"><button aria-label="Copy"><svg></svg></button></div></div>
  `);
  const md = root.querySelector('.md')!;
  const last = root.querySelectorAll('p')[1].firstChild!;
  const actions = root.querySelector('.message-actions')!;
  const clamped = messageBodyRange(between(last, 0, actions, 0))!;
  assert.ok(clamped);
  assert.equal(clamped.startContainer, last);
  assert.equal(clamped.endContainer, md);
  assert.equal(clamped.endOffset, md.childNodes.length);
  assert.equal(clamped.toString(), 'last paragraph');
  // the annotation's text offsets cover the paragraph alone, and find it again after a rerender
  const source = selectionSource(clamped);
  assert.deepEqual(source, { messageId: 'reply', start: 5, end: 19 });
  assert.equal(selectionRange(root, { kind: 'selection', text: 'last paragraph', source } as any)!.toString(), 'last paragraph');
  // icon-only controls inside the reach add no text either
  assert.equal(messageBodyRange(between(last, 0, actions.querySelector('button')!, 1))!.toString(), 'last paragraph');
});

test('a paragraph selection that ends at the start of the next message is clamped to its own message (#triple-click)', () => {
  // a triple click on a reply's last paragraph or list item: Chromium ends the range at offset 0 of the next message's first line
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="one"><div class="md"><p>head</p><ul><li>first</li><li>last bullet</li></ul></div></div></div>
    <div class="assistant-message"><div data-selection-source="two"><div class="md"><p>next reply</p></div></div></div>
  `);
  const [one, two] = Array.from(root.querySelectorAll('.md'));
  const bullet = root.querySelectorAll('li')[1].firstChild!;
  for (const [endNode, endOffset] of [
    [two.querySelector('p')!, 0],
    [two.querySelector('p')!.firstChild!, 0],
  ] as [Node, number][]) {
    const clamped = messageBodyRange(between(bullet, 0, endNode, endOffset))!;
    assert.ok(clamped, 'nothing of the next message is selected');
    assert.equal(clamped.startContainer, bullet);
    assert.equal(clamped.endContainer, one);
    assert.equal(clamped.endOffset, one.childNodes.length);
    assert.equal(clamped.toString(), 'last bullet');
    assert.deepEqual(selectionSource(clamped), { messageId: 'one', start: 9, end: 20 });
  }
  // a user bubble followed by a reply clamps the same way
  const asked = fixture(`
    <div class="user-message"><div class="user-bubble">question</div></div>
    <div class="assistant-message"><div data-selection-source="answer"><div class="md"><p>answer</p></div></div></div>
  `);
  const clampedBubble = messageBodyRange(between(asked.querySelector('.user-bubble')!.firstChild!, 0, asked.querySelector('p')!, 0))!;
  assert.equal(clampedBubble.toString(), 'question');
});

test('a selection that starts at the end of a message and reaches into the next one belongs to the next one', () => {
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="one"><div class="md"><p>previous reply</p></div></div></div>
    <div class="assistant-message"><div data-selection-source="two"><div class="md"><p>next reply</p></div></div></div>
  `);
  const [one, two] = Array.from(root.querySelectorAll('.md'));
  const previous = one.querySelector('p')!.firstChild as Text;
  const next = two.querySelector('p')!.firstChild!;
  const clamped = messageBodyRange(between(previous, previous.length, next, 4))!;
  assert.equal(clamped.startContainer, two);
  assert.equal(clamped.startOffset, 0);
  assert.equal(clamped.endContainer, next);
  assert.equal(clamped.toString(), 'next');
});

test('a selection with text of two messages, or system text between them, is still rejected', () => {
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="one"><div class="md"><p>previous reply</p></div></div></div>
    <div class="status-note">Model changed</div>
    <div class="assistant-message"><div data-selection-source="two"><div class="md"><p>next reply</p></div></div></div>
  `);
  const [one, two] = Array.from(root.querySelectorAll('.md'));
  const previous = one.querySelector('p')!.firstChild as Text;
  const next = two.querySelector('p')!.firstChild!;
  assert.equal(messageBodyRange(between(previous, 0, next, 0)), null, 'the previous reply is selected');
  assert.equal(messageBodyRange(between(previous, 0, next, 4)), null, 'both replies are selected');
  assert.equal(messageBodyRange(between(previous, previous.length, next, 4)), null, 'the notice lies between them');
  assert.equal(messageBodyRange(between(previous, previous.length, next, 0)), null);
});

test('a selection that starts just before a body with no text in between is clamped at its start', () => {
  const root = fixture('<div class="status-note">status</div>\n  <div class="user-bubble">question</div>');
  const note = root.querySelector('.status-note')!.firstChild!;
  const bubble = root.querySelector('.user-bubble')!;
  const clamped = messageBodyRange(between(note, (note as Text).length, bubble.firstChild!, 8))!;
  assert.equal(clamped.startContainer, bubble);
  assert.equal(clamped.startOffset, 0);
  assert.equal(clamped.toString(), 'question');
  // starting inside the notice's text quotes system UI, so it is refused
  assert.equal(messageBodyRange(between(note, 0, bubble.firstChild!, 8)), null);
});

test('selecting an entire reply through its wrapper boundaries still quotes that reply', () => {
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="whole"><div class="md"><p>first</p><p>last</p></div></div>
    <div class="message-actions"><button aria-label="Copy"><svg></svg></button></div></div>
  `);
  const reply = root.querySelector('.assistant-message')!;
  const md = root.querySelector('.md')!;
  for (const outer of [reply, reply.querySelector('[data-selection-source]')!, root]) {
    const selected = messageBodyRange(whole(outer));
    assert.ok(selected, 'both endpoints can be outside the message text');
    assert.equal(selected.startContainer, md);
    assert.equal(selected.endContainer, md);
    assert.equal(selected.toString(), 'firstlast');
    assert.deepEqual(selectionSource(selected), { messageId: 'whole', start: 0, end: 9 });
  }
});

test('wrapper selections still reject multiple messages, selected UI text and an unselected body', () => {
  for (const html of [
    '<div class="user-bubble">first</div><div class="user-bubble">second</div>',
    '<div class="status-note">status</div><div class="user-bubble">reply</div>',
    '<div class="user-bubble">reply</div><button>Copy</button>',
  ])
    assert.equal(messageBodyRange(whole(fixture(html))), null);
  const root = fixture('<div class="user-bubble">reply</div><span>outside</span>');
  assert.equal(messageBodyRange(between(root, 1, root, 2)), null);
});

test('a range with neither end in a body, or detached, does not qualify', () => {
  const detached = window.document.createTextNode('plain');
  assert.equal(messageBodyRange(whole(detached as unknown as Node)), null);
  const root = fixture('<div class="status-note">a</div><div class="user-bubble">reply</div><div class="status-note">b</div>');
  const [a, , b] = Array.from(root.children).map((el) => el.firstChild!);
  assert.equal(messageBodyRange(between(a, 0, b, 1)), null);
});

test('a paragraph selection that ends past a status row it never selected is clamped to its body (#3449)', () => {
  // a triple click on the last reply's last paragraph: Chromium ends the range past the transcript's status row
  // ("1 running task"), whose text is not selectable, so the selection's own text is only the paragraph
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="last"><div class="md"><p>first</p><p>last paragraph</p></div></div></div>
    <div class="turn-status-slot"><span class="turn-status">1 running task</span></div>
    <div class="thread-bottom-spacer"></div>
  `);
  const md = root.querySelector('.md')!;
  const last = md.lastElementChild!.firstChild!;
  const spacer = root.querySelector('.thread-bottom-spacer')!;
  const clamped = messageBodyRange(between(last, 0, spacer, 0), 'last paragraph\n\n')!;
  assert.ok(clamped, 'the status row is not part of the selection');
  assert.equal(clamped.startContainer, last);
  assert.equal(clamped.endContainer, md);
  assert.equal(clamped.endOffset, md.childNodes.length);
  assert.equal(clamped.toString(), 'last paragraph');
  // the same range whose selection did take in the status row's text quotes system UI
  assert.equal(messageBodyRange(between(last, 0, spacer, 0), 'last paragraph\n1 running task'), null);
  // without the selection's text, the DOM text between decides, as before
  assert.equal(messageBodyRange(between(last, 0, spacer, 0)), null);
});

test('a selection starting in an unselectable row before a body is clamped by what it selected (#3449)', () => {
  const root = fixture('<div class="status-note">Worked for 3s</div><div class="user-bubble">question</div>');
  const note = root.querySelector('.status-note')!.firstChild!;
  const bubble = root.querySelector('.user-bubble')!;
  const clamped = messageBodyRange(between(note, 0, bubble.firstChild!, 8), 'question')!;
  assert.equal(clamped.startContainer, bubble);
  assert.equal(clamped.toString(), 'question');
  assert.equal(messageBodyRange(between(note, 0, bubble.firstChild!, 8), 'Worked for 3s question'), null);
});

test('selections across two messages keep to the one whose text was selected, and reject text of both (#3449)', () => {
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="one"><div class="md"><p>previous reply</p></div></div></div>
    <div class="status-note">Model changed</div>
    <div class="assistant-message"><div data-selection-source="two"><div class="md"><p>next reply</p></div></div></div>
  `);
  const [one, two] = Array.from(root.querySelectorAll('.md'));
  const previous = one.querySelector('p')!.firstChild as Text;
  const next = two.querySelector('p')!.firstChild!;
  // the notice between them was not selected: the end's message keeps the selection
  assert.equal(messageBodyRange(between(previous, previous.length, next, 4), 'next')!.toString(), 'next');
  // the start's message, when the end only reaches an unselected notice
  assert.equal(messageBodyRange(between(previous, 0, next, 0), 'previous reply')!.toString(), 'previous reply');
  assert.equal(messageBodyRange(between(previous, 0, next, 4), 'previous reply\nnext'), null);
  assert.equal(messageBodyRange(between(previous, 0, next, 4), 'previous reply\nModel changed\nnext'), null);
});

test('a clamp past the status row still holds when the body has text of its own the selection left out (#3449)', () => {
  const root = fixture(`
    <div class="assistant-message"><div data-selection-source="r"><div class="md"><p>see</p><span class="hidden-label">x</span><p>last</p></div></div></div>
    <div class="turn-status-slot">1 running task</div><div class="thread-bottom-spacer"></div>
  `);
  const md = root.querySelector('.md')!;
  const spacer = root.querySelector('.thread-bottom-spacer')!;
  const first = md.querySelector('p')!.firstChild!;
  assert.equal(messageBodyRange(between(first, 0, spacer, 0), 'see\nlast')!.toString(), 'seexlast');
  // out of order, or with text the body does not hold, it is still another element's text
  assert.equal(messageBodyRange(between(first, 0, spacer, 0), 'last see'), null);
  assert.equal(messageBodyRange(between(first, 0, spacer, 0), 'see last 1 running task'), null);
});
