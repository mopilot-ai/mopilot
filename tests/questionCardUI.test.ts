// The question card as Claude Code's own (src/components/thread/QuestionCard.tsx), its choices: numbered tiles, an
// Other tile and its field, typed answers, several choices and the arrows. tests/questionCardFlowUI.test.ts has the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, draftAnswers, mount, one, question } from './support/question-card.ts';

const { renderToStaticMarkup } = await import('react-dom/server');
const { QuestionReplyBubble } = await import('../src/components/thread/QuestionReplyBubble.tsx');
const { OTHER_UNTYPED } = await import('../src/lib/answeredQuestions.ts');

test("Claude's layout: the question as the title, numbered tiles, an Other tile with its field, and Submit held until a pick", async () => {
  const f = await mount();
  try {
    assert.equal(f.title(), 'Which view?');
    assert.equal(f.host.querySelector('.question-card')?.getAttribute('aria-labelledby'), f.host.querySelector('.question-title')?.id);
    // one question: no count, and the short header chip is not drawn (Claude Code shows neither)
    assert.equal(f.host.querySelector('.question-count'), null);
    assert.equal(f.host.textContent?.includes('View'), false);
    assert.deepEqual(
      f.tiles().map((t) => t.querySelector('.question-option-label')?.textContent),
      ['First', 'Second'],
    );
    assert.equal(f.tiles()[0].querySelector('.question-option-desc')?.textContent, 'One option');
    assert.deepEqual(
      [...f.host.querySelectorAll('kbd.question-option-key')].map((k) => k.textContent),
      ['1', '2', '3'],
    );
    assert.equal(f.host.querySelector('.question-other-pick')?.textContent, 'Other3');
    assert.equal(f.field().getAttribute('placeholder'), 'Type your own answer here');
    assert.equal(f.field().getAttribute('aria-label'), 'Other option');
    assert.equal(f.host.querySelectorAll('.question-option.sel').length, 0);
    assert.equal(f.button('Back'), undefined);
    assert.equal(f.button('Submit').disabled, true);
    assert.equal(f.button('Submit').querySelector('kbd')?.textContent, '⌘↵');
    await f.click(f.button('Submit'));
    await f.key('Enter');
    assert.deepEqual(f.replies, []);
  } finally {
    await f.dispose();
  }
});

test('a single-choice click or number key answers at once with that label', async () => {
  const f = await mount();
  try {
    await f.click(f.tiles()[1]);
    assert.deepEqual(f.replies, [['request', one('q', ['Second'])]]);
  } finally {
    await f.dispose();
  }
  const g = await mount();
  try {
    for (const init of [{ repeat: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }])
      await g.key('2', window, init);
    // past the choices (3 is Other, 9 is nothing): no answer
    await g.key('9');
    assert.deepEqual(g.replies, []);
    await g.key('1');
    assert.deepEqual(g.replies, [['request', one('q', ['First'])]]);
  } finally {
    await g.dispose();
  }
});

test('Other: its tile or key picks it and focuses the field; typed text is the answer, an empty one says Something else', async () => {
  const f = await mount();
  try {
    await f.key('3');
    assert.ok(f.host.querySelector('.question-other.sel'));
    assert.equal(document.activeElement, f.field());
    assert.equal(f.button('Submit').disabled, false);
    await f.click(f.button('Submit'));
    assert.deepEqual(f.replies, [['request', one('q', [OTHER_UNTYPED])]]);
  } finally {
    await f.dispose();
  }
  const g = await mount();
  try {
    // typing picks Other by itself
    await g.input('  first line\nsecond line  ');
    assert.ok(g.host.querySelector('.question-other.sel'));
    for (const init of [{ shiftKey: true }, { isComposing: true }, { repeat: true }]) await g.key('Enter', g.field(), init);
    // digits typed in the field are text, not choices
    await g.key('1', g.field());
    assert.deepEqual(g.replies, []);
    await g.key('Enter', g.field());
    assert.deepEqual(g.replies, [['request', one('q', ['first line\nsecond line'])]]);
  } finally {
    await g.dispose();
  }
});

test('a question with no options takes typed text alone, labelled by the question; Codex can withhold Other', async () => {
  const f = await mount([{ id: 'free', question: 'Anything else?', options: null }]);
  try {
    assert.equal(f.tiles().length, 0);
    assert.equal(f.host.querySelector('.question-other-pick'), null);
    assert.equal(f.field().getAttribute('aria-label'), 'Anything else?');
    await f.key('1');
    await f.input('   ');
    assert.equal(f.button('Submit').disabled, true);
    await f.input(' note ');
    await f.click(f.button('Submit'));
    assert.deepEqual(f.replies, [['request', one('free', ['note'])]]);
  } finally {
    await f.dispose();
  }
  const g = await mount([{ ...question, isOther: false }]);
  try {
    assert.equal(g.field(), null);
    assert.deepEqual(
      [...g.host.querySelectorAll('kbd.question-option-key')].map((k) => k.textContent),
      ['1', '2'],
    );
    await g.key('3');
    assert.deepEqual(g.replies, []);
  } finally {
    await g.dispose();
  }
});

test('a secret question types into a masked field', async () => {
  const f = await mount([{ id: 'token', question: 'API token?', isSecret: true, options: null }]);
  try {
    assert.equal((f.field() as HTMLInputElement).type, 'password');
    await f.input('s3cret');
    await f.key('Enter', f.field());
    assert.deepEqual(f.replies, [['request', one('token', ['s3cret'])]]);
  } finally {
    await f.dispose();
  }
});

test('multi-select toggles tiles with check boxes and sends picks in order, then Other, with ⌘↵ or Submit', async () => {
  const f = await mount([{ ...question, multiSelect: true }]);
  try {
    assert.equal(f.host.querySelectorAll('kbd.question-option-key').length, 0);
    assert.equal(f.host.querySelectorAll('.question-check').length, 3);
    for (const i of [1, 0, 0, 0]) await f.click(f.tiles()[i]);
    assert.deepEqual(
      f.tiles().map((t) => t.getAttribute('aria-pressed')),
      ['true', 'true'],
    );
    assert.equal(f.host.querySelectorAll('.question-check.on').length, 2);
    await f.input('  Custom  ');
    // plain Enter in the field leaves the line to the field; ⌘↵ sends
    await f.key('Enter', f.field());
    assert.deepEqual(f.replies, []);
    await f.key('Enter', f.field(), { metaKey: true });
    assert.deepEqual(f.replies, [['request', one('q', ['First', 'Second', 'Custom'])]]);
  } finally {
    await f.dispose();
  }
  const g = await mount([{ ...question, multiSelect: true }]);
  try {
    // number keys toggle, ↓ walks, Enter toggles the one walked to; Other toggles off too
    await g.key('2');
    await g.key('3');
    await g.key('3');
    await g.key('ArrowDown');
    assert.ok(g.tiles()[0].classList.contains('hl'));
    await g.key('Enter');
    await g.click(g.button('Submit'));
    assert.deepEqual(g.replies, [['request', one('q', ['First', 'Second'])]]);
  } finally {
    await g.dispose();
  }
});

test('the Other tile picks Other by a click; typing keeps several picks and Other once; ↑↓ skip what is not offered', async () => {
  const f = await mount([{ ...question, multiSelect: true }]);
  try {
    await f.click(f.host.querySelector('.question-other-pick'));
    assert.equal(f.host.querySelector('.question-other-pick')?.getAttribute('aria-pressed'), 'true');
    await f.input('mine');
    await f.input('mine too');
    await f.key('Enter', f.field(), { ctrlKey: true, metaKey: true });
    assert.deepEqual(f.replies, [['request', one('q', ['mine too'])]]);
  } finally {
    await f.dispose();
  }
  // without Other, the arrows walk the options alone; a question with only a field has nothing to walk
  const g = await mount([
    { ...question, isOther: false },
    { id: 'free', question: 'Free?' },
  ]);
  try {
    await g.key('ArrowUp');
    assert.deepEqual(
      g.tiles().map((t) => t.classList.contains('sel')),
      [false, true],
    );
    await g.key('Enter');
    await g.key('ArrowDown');
    assert.equal(g.title(), 'Free?');
    assert.equal(g.host.querySelector('.sel'), null);
  } finally {
    await g.dispose();
  }
});

test('↑↓ walk the choices, Other last: one choice takes the tile walked to and Enter sends it', async () => {
  const f = await mount();
  try {
    await f.key('ArrowDown');
    await f.key('ArrowDown');
    assert.deepEqual(
      f.tiles().map((t) => t.classList.contains('sel')),
      [false, true],
    );
    await f.key('ArrowDown');
    assert.equal(document.activeElement, f.field());
    await f.key('ArrowUp', document.body);
    await f.key('Enter');
    assert.deepEqual(f.replies, [['request', one('q', ['Second'])]]);
  } finally {
    await f.dispose();
  }
  const g = await mount();
  try {
    await g.key('ArrowUp');
    assert.ok(g.host.querySelector('.question-other.sel'));
    await g.key('Enter', g.tiles()[0]);
    assert.deepEqual(g.replies, [], 'a focused button keeps its own Enter');
  } finally {
    await g.dispose();
  }
});

test('draftAnswers: picks in option order, Other last, one for a single choice, typed text for a free one', () => {
  const multi = { ...question, multiSelect: true };
  assert.deepEqual(draftAnswers(multi, { picked: [-1, 1, 0, 7], text: ' x ' }), ['First', 'Second', 'x']);
  assert.deepEqual(draftAnswers(multi, { picked: [1, -1], text: '' }), ['Second', OTHER_UNTYPED]);
  assert.deepEqual(draftAnswers(question, { picked: [1, 0], text: '' }), ['First']);
  assert.deepEqual(draftAnswers({ id: 'f', question: 'Free?' }, { picked: [], text: '  ' }), []);
});

test('question reply renders summary and answer inside one bubble with an escaped full title', () => {
  const question = 'Question <script> & "quoted"?';
  const markup = renderToStaticMarkup(createElement(QuestionReplyBubble, { question } as any, 'Answer'));
  const host = document.createElement('div');
  host.innerHTML = markup;
  assert.equal(host.querySelectorAll('.user-bubble').length, 1);
  assert.equal(host.querySelector('.user-annotations') === null, true);
  assert.equal(host.querySelector('.question-reply-summary')?.getAttribute('title'), question);
  assert.equal(host.querySelector('.question-reply-summary')?.textContent, question);
  assert.equal(host.querySelector('script') === null, true);
  assert.equal(host.querySelector('.user-bubble')?.lastChild?.textContent, 'Answer');
});
