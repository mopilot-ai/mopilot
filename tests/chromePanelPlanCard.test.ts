// The plan-approval card draws the plan (Markdown, folded past 12 lines under "Show more") and the permission card's keys answer its choices, in the real card DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { fixture, card, click, tick, trusted } from './support/panel-card-controls.ts';

const PLAN =
  '## Plan\n\n1. Read the code\n2. Change `panelCards.mjs`\n\n```text\nnpm test\n```\n\n| Step | Owner |\n| --- | --- |\n| Review | You |';
const planCard = (plan: any, extra: any = {}) =>
  card({
    title: 'Ready to start on this plan?',
    kind: 'plan',
    plan,
    choices: [
      { key: 'once', label: 'Approve plan' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
    ...extra,
  });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

/** Replace the box's measures the way a layout would give them. */
function measures(el: any, scroll: number, client: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scroll, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: client, configurable: true });
}

test('the plan card shows the plan as Markdown between its title and its buttons', () => {
  const f = fixture();
  f.view.render('chat', [planCard({ text: PLAN })]);
  const el = f.container.firstElementChild!;
  assert.deepEqual(
    [...el.children].map((c) => c.className),
    ['q', 'plan-box', 'choices'],
  );
  const plan = el.querySelector('.plan')!;
  assert.equal(plan.getAttribute('role'), 'region');
  assert.equal(plan.getAttribute('aria-label'), 'Plan');
  assert.equal(plan.querySelector('.h')!.textContent, 'Plan');
  assert.deepEqual(
    [...plan.querySelectorAll('ol li')].map((li) => li.textContent),
    ['Read the code', 'Change panelCards.mjs'],
  );
  assert.equal(plan.querySelector('li code')!.textContent, 'panelCards.mjs');
  assert.equal(plan.querySelector('pre code')!.textContent, 'npm test');
  assert.deepEqual(
    [...plan.querySelectorAll('th, td')].map((c) => c.textContent),
    ['Step', 'Owner', 'Review', 'You'],
  );
  assert.deepEqual(
    [...el.querySelectorAll('.choices button')].map((b) => b.textContent),
    ['Approve plan', 'Deny'],
  );
  // short and unmeasured: nothing to expand
  assert.equal((el.querySelector('.plan-more') as any).hidden, true);
});

test('a plan is text only: markup in it stays text, and a card with no plan text draws no plan', () => {
  const f = fixture();
  f.view.render('chat', [planCard({ text: '<img src=x onerror=alert(1)> and [x](javascript:alert(1))' })]);
  assert.equal(f.container.querySelector('.plan img'), null);
  assert.match(f.container.querySelector('.plan')!.textContent!, /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.container.querySelector('.plan a'), null);
  for (const plan of [{ text: '' }, { text: 5 }, { file: 'a.md' }, null, 'text', ['x']]) {
    f.view.render('chat', [planCard(plan, { version: `v-${JSON.stringify(plan)}` })]);
    assert.equal(f.container.querySelector('.plan-box'), null, JSON.stringify(plan));
    assert.deepEqual(
      [...f.container.querySelectorAll('.choices button')].map((b) => b.textContent),
      ['Approve plan', 'Deny'],
    );
  }
});

test('a plan of more than 12 lines folds: Show more opens it to scroll, Show less folds it again', () => {
  const f = fixture();
  f.view.render('chat', [planCard({ text: lines(13) })]);
  const plan = f.container.querySelector('.plan')!;
  const more = f.container.querySelector('.plan-more') as any;
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(plan.classList.contains('open'), false);
  click(more);
  assert.equal(plan.classList.contains('open'), true);
  assert.equal(more.textContent, 'Show less');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  click(more);
  assert.equal(plan.classList.contains('open'), false);
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  // exactly 12 lines fit
  f.view.render('chat', [planCard({ text: lines(12) }, { version: 'v2' })]);
  assert.equal((f.container.querySelector('.plan-more') as any).hidden, true);
});

test('the toggle follows what fits as the panel resizes, and the plan toggle never answers the card', async () => {
  const observers: any[] = [];
  class Observer {
    callback: () => void;
    watched: any[] = [];
    disconnected = false;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    observe(el: any) {
      this.watched.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  (window as any).ResizeObserver = Observer;
  try {
    const f = fixture();
    f.view.render('chat', [planCard({ text: 'a short plan\nthat wraps in a narrow panel' })]);
    const body = f.container.querySelector('.plan')!;
    const more = f.container.querySelector('.plan-more') as any;
    assert.deepEqual(observers[0].watched, [body]);
    // wrapped lines overflow the 12-line box: the toggle shows
    measures(body, 400, 200);
    observers[0].callback();
    assert.equal(more.hidden, false);
    // a wider panel fits it (a pixel of rounding is not overflow)
    measures(body, 201, 200);
    observers[0].callback();
    assert.equal(more.hidden, true);
    measures(body, 400, 200);
    observers[0].callback();
    assert.equal(more.hidden, false);
    // open: the box is no longer capped, so measuring must not hide the way back
    click(more);
    measures(body, 400, 400);
    observers[0].callback();
    assert.equal(more.hidden, false);
    // folding again measures at once
    measures(body, 100, 100);
    click(more);
    assert.equal(more.hidden, true);
    // toggling the plan sends nothing
    assert.equal(f.calls.length, 0);
    f.view.render(null, []);
    assert.equal(observers[0].disconnected, true);
  } finally {
    delete (window as any).ResizeObserver;
  }
});

test('with no ResizeObserver the plan still folds by its line count', () => {
  delete (window as any).ResizeObserver;
  const f = fixture();
  f.view.render('chat', [planCard({ text: lines(20) })]);
  assert.equal((f.container.querySelector('.plan-more') as any).hidden, false);
});

test('the plan says its file and when it was cut short', () => {
  const f = fixture();
  f.view.render('chat', [planCard({ text: 'Do it', file: 'a.md' })]);
  assert.equal(f.container.querySelector('.plan-file')!.textContent, 'Saved as a.md');
  f.view.render('chat', [planCard({ text: 'Do it', clipped: true }, { version: 'v2' })]);
  assert.equal(f.container.querySelector('.plan-file')!.textContent, 'Only the start of the plan is shown here.');
  f.view.render('chat', [planCard({ text: 'Do it', file: 'a.md', clipped: true }, { version: 'v3' })]);
  assert.equal(f.container.querySelector('.plan-file')!.textContent, 'Saved as a.md. Only the start of the plan is shown here.');
  f.view.render('chat', [planCard({ text: 'Do it' }, { version: 'v4' })]);
  assert.equal(f.container.querySelector('.plan-file'), null);
});

test('Approve plan and Deny still answer with their keys and the request version', async () => {
  const f = fixture();
  f.view.render('chat', [planCard({ text: PLAN })]);
  click(f.container.querySelector('button[data-choice="once"]')!);
  await tick();
  assert.deepEqual(f.calls[0], ['answer', { chatId: 'chat', approvalId: 'request', version: 'v1', choice: 'once' }]);
});

test('a card’s heading comes before its question and its reminder after its buttons', () => {
  const f = fixture();
  f.view.render('chat', [card({ heading: 'MoPilot needs your OK', note: 'Be careful.' })]);
  const el = f.container.firstElementChild!;
  assert.deepEqual(
    [...el.children].map((c) => `${c.className}:${c.textContent}`),
    ['kicker:MoPilot needs your OK', 'q:Choose', 'choices:SendDeny', 'note:Be careful.'],
  );
});

const permission = (extra: any = {}) =>
  card({
    heading: 'MoPilot needs your OK',
    choices: [
      { key: 'once', label: 'Allow once', shortcut: 'enter' },
      { key: 'chat', label: 'Allow in this chat' },
      { key: 'always', label: 'Always allow on this site', shortcut: 'mod-enter' },
      { key: 'deny', label: 'Decline', deny: true, shortcut: 'escape' },
    ],
    ...extra,
  });
const key = (init: any, target: any = window) => {
  const event = trusted(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  target.dispatchEvent(event);
  return event;
};
const sent = (f: any) => f.calls.filter((c: any) => c[0] === 'answer').map((c: any) => c[1].choice);

test('a shortcut shows on its button and names its key', () => {
  const f = fixture();
  f.view.render('chat', [permission()]);
  const buttons = [...f.container.querySelectorAll('.choices button')] as any[];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['Allow once↵', 'Allow in this chat', 'Always allow on this site⌘↵', 'DeclineEsc'],
  );
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-keyshortcuts')),
    ['Enter', null, 'Meta+Enter', 'Escape'],
  );
  assert.equal(buttons[0].querySelector('kbd').getAttribute('aria-hidden'), 'true');
  assert.equal(buttons[1].querySelector('kbd'), null);
});

test('Enter allows this action, Cmd or Ctrl+Enter allows always, Escape declines: one answer each', async () => {
  for (const [init, choice] of [
    [{ key: 'Enter' }, 'once'],
    [{ key: 'Enter', metaKey: true }, 'always'],
    [{ key: 'Enter', ctrlKey: true }, 'always'],
    [{ key: 'Escape' }, 'deny'],
  ] as const) {
    const f = fixture();
    f.view.render('chat', [permission()]);
    const event = key(init);
    assert.equal(event.defaultPrevented, true);
    await tick();
    assert.deepEqual(sent(f), [choice]);
    assert.equal(f.calls[0][1].version, 'v1');
    // pressed again while the answer is pending: no second answer
    key(init);
    await tick();
    assert.deepEqual(sent(f), [choice]);
    assert.equal(f.reads(), 1);
  }
});

test('other keys, chords, composing text and untrusted events do not answer', async () => {
  const f = fixture();
  f.view.render('chat', [permission()]);
  for (const init of [
    { key: 'a' },
    { key: 'Enter', shiftKey: true },
    { key: 'Enter', altKey: true },
    { key: 'Escape', metaKey: true },
    { key: 'Escape', ctrlKey: true },
    { key: 'Enter', repeat: true },
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
  ])
    key(init);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  await tick();
  assert.deepEqual(sent(f), []);
  // a handler before this one took the key
  const taken = new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  taken.preventDefault();
  window.dispatchEvent(trusted(taken));
  await tick();
  assert.deepEqual(sent(f), []);
});

test('the keys are the message box’s while the user types, the focus is on a control, or a menu is open', async () => {
  const f = fixture();
  f.view.render('chat', [permission()]);
  const box = window.document.createElement('textarea');
  const other = window.document.createElement('button');
  const input = window.document.createElement('input');
  window.document.body.append(box, other, input);
  box.value = 'half a message';
  box.focus();
  key({ key: 'Enter' }, box);
  key({ key: 'Escape' }, box);
  other.focus();
  key({ key: 'Enter' }, other);
  // a field of the card, and a field of another form, keep their keys
  const own = window.document.createElement('input');
  f.container.firstElementChild!.append(own);
  own.focus();
  key({ key: 'Enter' }, own);
  input.type = 'checkbox';
  input.value = 'on';
  input.focus();
  key({ key: 'Enter' }, input);
  window.document.body.focus();
  const menu = window.document.createElement('div');
  menu.className = 'menu';
  window.document.body.append(menu);
  key({ key: 'Escape' });
  menu.hidden = true;
  const header = window.document.createElement('div');
  header.className = 'header-menu';
  window.document.body.append(header);
  key({ key: 'Escape' });
  await tick();
  assert.deepEqual(sent(f), []);
  // closed menus, nothing focused, an empty message box: the card's
  header.hidden = true;
  box.value = '';
  box.focus();
  key({ key: 'Enter' }, box);
  await tick();
  assert.deepEqual(sent(f), ['once']);
});

test('only the first card takes the keys, and a replaced, disabled or removed card takes none', async () => {
  const f = fixture();
  f.view.render('chat', [permission({ id: 'one' }), permission({ id: 'two' })]);
  key({ key: 'Escape' });
  await tick();
  assert.deepEqual(
    f.calls.map((c: any) => c[1].approvalId),
    ['one'],
  );
  const g = fixture();
  g.view.render('chat', [permission({ disabled: true })]);
  key({ key: 'Enter' });
  g.view.render('chat', [permission({ version: 'v2' })]);
  g.view.render(null, []);
  key({ key: 'Enter' });
  await tick();
  assert.deepEqual(sent(g), []);
});

test('a failed answer by key leaves the card answerable and shows the reason', async () => {
  const f = fixture();
  f.view.render('chat', [permission()]);
  f.reply(() => {
    throw new Error('This request changed.');
  });
  key({ key: 'Enter' });
  await tick();
  assert.deepEqual(f.errors.filter(Boolean), ['This request changed.']);
  f.reply(() => ({}));
  key({ key: 'Enter' });
  await tick();
  assert.deepEqual(sent(f), ['once', 'once']);
});

test('a card with no shortcut never listens, and a document with no window or query still works', async () => {
  const f = fixture();
  f.view.render('chat', [card()]);
  key({ key: 'Enter' });
  assert.equal(f.calls.length, 0);
  // a document of another kind: no window to listen on (the timers' own, which has no listeners), no querySelector, no focus
  const doc = new Proxy(window.document, {
    get: (target: any, prop) => {
      if (prop === 'defaultView' || prop === 'querySelector' || prop === 'activeElement') return undefined;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const o = (f.view as any).o;
  const view = new (f.view.constructor as any)({ ...o, document: doc, timers: {} });
  view.render('chat', [permission(), planCard({ text: 'Do it' }, { id: 'plan' })]);
  assert.equal(view.keysFree({ contains: () => false }), true);
  assert.equal(view.keysFree({}), true);
  view.render(null, []);
});

test('the keys are free when something is focused only if it is an empty field', () => {
  const f = fixture();
  const field = window.document.createElement('input');
  window.document.body.append(field);
  field.focus();
  assert.equal((f.view as any).keysFree({ contains: () => false }), true);
  field.value = 'x';
  assert.equal((f.view as any).keysFree({ contains: () => false }), false);
  assert.equal((f.view as any).keysFree({}), false);
});
