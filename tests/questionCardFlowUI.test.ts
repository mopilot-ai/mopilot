// The question card as Claude Code's own (src/components/thread/QuestionCard.tsx), its flow: several questions one at a
// time, Skip and dismiss in Claude Code's words, the fold, which keys it takes, and a card that asks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionCard, act, createElement, createRoot, mount, one, question, window } from './support/question-card.ts';

const { NO_PREFERENCE, DISMISSED_ANSWER } = await import('../src/lib/answeredQuestions.ts');

test('several questions go one at a time: a count, Next, Back with the earlier pick kept, Skip as No preference', async () => {
  const qs = [
    question,
    { id: 'time', question: 'Which time?', options: [{ label: 'Now' }, { label: 'Later' }] },
    { id: 'n', question: 'Notes?' },
  ];
  const f = await mount(qs);
  try {
    assert.equal(f.host.querySelector('.question-count')?.textContent, '1/3');
    assert.equal(f.button('Next').textContent, 'Next ⌘↵');
    await f.key('2');
    assert.equal(f.title(), 'Which time?');
    assert.equal(f.host.querySelector('.question-count')?.textContent, '2/3');
    await f.click(f.button('Back'));
    assert.equal(f.title(), 'Which view?');
    assert.ok(f.tiles()[1].classList.contains('sel'), 'Back shows the pick that answered it');
    await f.click(f.button('Next'));
    await f.click(f.button('Skip'));
    assert.equal(f.title(), 'Notes?');
    assert.ok(f.button('Submit'));
    assert.deepEqual(f.replies, []);
    await f.input('done');
    await f.key('Enter', f.field());
    assert.deepEqual(f.replies, [
      ['request', { answers: { q: { answers: ['Second'] }, time: { answers: [NO_PREFERENCE] }, n: { answers: ['done'] } } }],
    ]);
  } finally {
    await f.dispose();
  }
});

test('Skip on the last question sends it as No preference; the X and Escape dismiss every question', async () => {
  const f = await mount();
  try {
    await f.input('Unsubmitted draft');
    await f.click(f.button('Skip'));
    assert.deepEqual(f.replies, [['request', one('q', [NO_PREFERENCE])]]);
  } finally {
    await f.dispose();
  }
  for (const how of ['x', 'Escape', 'Escape in field']) {
    const g = await mount([question, { id: 'b', question: 'B?' }]);
    try {
      await g.input('Unsubmitted draft');
      if (how === 'x') await g.click(g.host.querySelector('[aria-label="Dismiss question"]'));
      else await g.key('Escape', how === 'Escape' ? window : g.field());
      assert.deepEqual(g.replies, [['request', { answers: { q: { answers: [DISMISSED_ANSWER] }, b: { answers: [DISMISSED_ANSWER] } } }]]);
    } finally {
      await g.dispose();
    }
  }
});

test('the caret folds the choices and footer away, and keys wait until it opens again', async () => {
  const f = await mount();
  const caret = () => f.host.querySelector('[aria-label="View question options"]')!;
  try {
    assert.equal(caret().getAttribute('aria-expanded'), 'true');
    await f.click(caret());
    assert.equal(caret().getAttribute('aria-expanded'), 'false');
    assert.equal(f.tiles().length, 0);
    assert.equal(f.button('Skip'), undefined);
    await f.key('1');
    assert.deepEqual(f.replies, []);
    await f.click(caret());
    await f.key('1');
    assert.deepEqual(f.replies, [['request', one('q', ['First'])]]);
  } finally {
    await f.dispose();
  }
});

test('typing elsewhere and open menus keep their keys', async () => {
  const f = await mount();
  const menu = document.createElement('div');
  menu.className = 'popover-layer';
  const elsewhere = document.createElement('textarea');
  document.body.append(elsewhere);
  try {
    await f.key('1', elsewhere);
    await f.key('Escape', elsewhere);
    document.body.append(menu);
    await f.key('2');
    await f.key('Escape');
    assert.deepEqual(f.replies, []);
  } finally {
    menu.remove();
    elsewhere.remove();
    await f.dispose();
  }
});

test('the focused question card owns a shortcut when two panes are open', async () => {
  const first = await mount([question], 'first');
  const second = await mount([question], 'second');
  try {
    await second.key('2', second.tiles()[0]);
    assert.deepEqual(first.replies, []);
    assert.deepEqual(second.replies, [['second', one('q', ['Second'])]]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("a card left in the transcript takes only keys pressed inside it, so the docked card keeps the window's", async () => {
  const inline = await mount([question], 'inline', { ownKeysOnly: true });
  const docked = await mount([question], 'docked');
  try {
    await inline.key('1');
    assert.deepEqual(inline.replies, []);
    assert.deepEqual(docked.replies, [['docked', one('q', ['First'])]]);
    await inline.key('2', inline.tiles()[0]);
    assert.deepEqual(inline.replies, [['inline', one('q', ['Second'])]]);
  } finally {
    await inline.dispose();
    await docked.dispose();
  }
});

test('a disabled card answers nothing: no clicks, keys, Skip or dismiss', async () => {
  const f = await mount([question], 'request', { disabled: true });
  try {
    await f.click(f.tiles()[0]);
    await f.key('2');
    await f.key('Escape');
    await f.click(f.button('Skip'));
    await f.click(f.host.querySelector('[aria-label="Dismiss question"]'));
    assert.deepEqual(f.replies, []);
    assert.equal(f.field().readOnly, true);
  } finally {
    await f.dispose();
  }
});

test('a card that asks nothing is answered at once, once, as Claude Code does; a disabled one waits', async () => {
  const f = await mount([], 'none');
  try {
    assert.equal(f.host.querySelector('.question-card'), null);
    await f.render();
    assert.deepEqual(f.replies, [['none', { answers: {} }]]);
  } finally {
    await f.dispose();
  }
  const g = await mount([], 'none', { disabled: true });
  try {
    assert.deepEqual(g.replies, []);
  } finally {
    await g.dispose();
  }
});

test('the last question can carry a sending label in place of Submit', async () => {
  const f = await mount([question], 'request', { sendLabel: 'Sending…' });
  try {
    assert.equal(f.button('Sending…').textContent, 'Sending… ⌘↵');
  } finally {
    await f.dispose();
  }
});

test('question ids matching object properties keep their own drafts and survive reply serialization', async () => {
  const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  const f = await mount(ids.map((id) => ({ ...question, id })));
  try {
    await f.key('1');
    // the second question answers with Other's text
    await f.key('3');
    await f.input('custom');
    await f.key('Enter', f.field());
    await f.key('1');
    assert.equal(f.replies.length, 0);
    await f.key('1');
    const expected = Object.fromEntries(ids.map((id, index) => [id, { answers: [index === 1 ? 'custom' : 'First'] }]));
    assert.deepEqual(f.replies, [['request', { answers: expected }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.replies[0][1])).answers, expected);
    assert.equal(Object.getPrototypeOf((f.replies[0][1] as { answers: object }).answers), Object.prototype);
  } finally {
    await f.dispose();
  }
});

test('keys answer through the card as it renders now: a new answer handler or question list is used without a remount', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const first: any[] = [];
  const second: any[] = [];
  const card = (onAnswer: (...args: any[]) => void, questions: any[]) =>
    createElement(QuestionCard, { req: { id: 'live', params: { questions } }, agent: 'Codex', onAnswer });
  const press = (key: string) =>
    act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  try {
    await act(() => root.render(card((...a) => first.push(a), [question])));
    const relabeled = { ...question, options: [{ label: 'Third' }, { label: 'Fourth' }] };
    await act(() => root.render(card((...a) => second.push(a), [relabeled])));
    await press('2');
    assert.deepEqual(first, []);
    assert.deepEqual(second, [['live', one('q', ['Fourth'])]]);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
