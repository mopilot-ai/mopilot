// "Allow for this task" on a financial site (#2328): one yes covers the site's ordinary actions until the turn ends, in that segment; sensitive actions, actions the caller did not read as ordinary (page JavaScript, an upload, a Confirm button), other sites, other high-risk categories, a new segment and the next turn ask again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { TaskGrants, taskCovers, plainLabel } = require('../electron/capabilities/browser/taskGrants.cjs');
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');

const { TurnTokens } = require('../electron/capabilities/contract/turnTokens.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
/** Standalone site-rule cases run under the same real token guard as Registry and IabBackend dispatch. */
function withTurns(g: any) {
  const tokens = new TurnTokens();
  const run = (fn: () => any, chat = 'c1') => guarded({ token: tokens.issue(chat), current: (t: any) => tokens.current(t) }, fn);
  const act = g.act.bind(g),
    end = g.turnEnded.bind(g),
    forget = g.forget.bind(g);
  g.act = (url: string, ctx: any, action: any) => run(() => act(url, ctx, action), ctx.chatId);
  g.turnEnded = (chat: string) => {
    tokens.retire(chat);
    end(chat);
  };
  g.forget = (chat: string) => {
    tokens.retire(chat);
    forget(chat);
  };
  g.run = run;
  return g;
}

const AMEX = 'https://www.travel.americanexpress.com/en-us/book';
const CHASE = 'https://www.chase.com/';
const ctx = { chatId: 'c1', segmentId: 's1' };

function grants(answers: (req: any) => any) {
  const asked: any[] = [];
  const g = withTurns(new OriginGrants({ confirmAction: async (req: any) => (asked.push(req), answers(req)) }));
  return { g, asked };
}

test('an ordinary action allowed for the task covers that site until the turn ends; a sensitive one asks each time', async () => {
  const { g, asked } = grants((req) => (req.task ? 'task' : true));
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', summary: 'click Search', ordinary: true }), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].task, true);
  assert.ok(asked[0].risk, 'the card names the risk class');
  // the next clicks on the site: no card
  assert.equal(await g.act(`${AMEX}/hotels`, ctx, { tool: 'click', ordinary: true }), true);
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', ordinary: true }), true);
  assert.equal(asked.length, 1);
  // paying still asks, and offers no task scope
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', sensitive: { verb: 'pay' }, ordinary: true }), true);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].task, false);
  // another high-risk site, another segment, another chat: asked again
  await g.act(CHASE, ctx, { tool: 'click', ordinary: true });
  await g.act(AMEX, { chatId: 'c1', segmentId: 's2' }, { tool: 'click', ordinary: true });
  await g.act(AMEX, { chatId: 'c2', segmentId: 's1' }, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 5);
  // the turn ends: the task's allowances go
  g.turnEnded('c1');
  await g.act(`${AMEX}/x`, { chatId: 'c1', segmentId: 's2' }, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 6);
  // the chat is over: so are its allowances
  g.forget('c1');
  await g.act(AMEX, { chatId: 'c1', segmentId: 's2' }, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 7);
});

test('Allow once is one action, a refusal refuses, and an ordinary site needs no card', async () => {
  let answer: any = true;
  const { g, asked } = grants(() => answer);
  await g.act(AMEX, ctx, { tool: 'click', ordinary: true });
  await g.act(AMEX, ctx, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 2);
  answer = false;
  await assert.rejects(g.act(AMEX, ctx, { tool: 'click', ordinary: true }), { code: 'denied' });
  // a 'task' answer to a sensitive action lets that one action through and keeps nothing
  answer = 'task';
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', sensitive: { verb: 'transfer' }, ordinary: true }), true);
  answer = true;
  await g.act(AMEX, ctx, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 5);
  assert.equal(await g.act('https://example.com/', ctx, { tool: 'click', ordinary: true }), false);
  assert.equal(asked.length, 5);
});

test('a chat switched to read only after the card is refused, and keeps no allowance', async () => {
  let anchor = 'ask';
  const g = withTurns(
    new OriginGrants({
      anchor: () => anchor,
      confirmAction: async () => {
        anchor = 'readOnly';
        return 'task';
      },
    }),
  );
  await assert.rejects(g.act(AMEX, ctx, { tool: 'click', ordinary: true }), { code: 'read_only' });
  anchor = 'ask';
  assert.equal(g.tasks.has('c1', 's1', 'https://www.travel.americanexpress.com'), false);
});

test('TaskGrants: a new segment starts over, and ending clears the chat', () => {
  const tokens = new TurnTokens();
  guarded({ token: tokens.issue('c'), current: (t: any) => tokens.current(t) }, () => {
    const t = new TaskGrants();
    t.add('c', 's1', 'https://a.test');
    t.add('c', 's1', 'https://b.test');
    assert.equal(t.has('c', 's1', 'https://b.test'), true);
    t.add('c', 's2', 'https://c.test');
    assert.equal(t.has('c', 's1', 'https://a.test'), false);
    assert.equal(t.has('c', 's2', 'https://c.test'), true);
    assert.equal(t.has('other', 's2', 'https://c.test'), false);
    tokens.retire('c');
    t.end('c');
    assert.equal(t.has('c', 's2', 'https://c.test'), false);
  });
});

test('main’s card offers the task scope only for an ordinary action on a high-risk site, and maps the answer', async () => {
  const cards = new Map<string, any>();
  const broker = new ApprovalBroker({
    controller: { addApproval: (_c: string, a: any) => void cards.set(a.id, a), resolveApproval: (id: string) => cards.delete(id) },
  });
  const live = {
    sessions: new Map([['c1', { permission: 'default', activeTurn: { id: 't' } }]]),
    controller: { ref: () => ({ kind: 'claude', id: null }), adapterOf: () => ({}) },
    remoteOwners: { get: () => null },
    computerUse: { broker },
  };
  const { chromeGrants } = siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false });
  withTurns(chromeGrants);
  const answerNext = async (answer: any) => {
    while (!cards.size) await new Promise((r) => setImmediate(r));
    const [card] = [...cards.values()];
    broker.answer(card.id, answer);
    return card.params;
  };
  // Allow for this task
  let pending = chromeGrants.act(AMEX, ctx, { tool: 'click', summary: 'click', ordinary: true });
  let params = await answerNext({ decision: 'allow', scope: 'task' });
  assert.equal(await pending, true);
  assert.equal(params.task, true);
  assert.equal(params.verb, 'act on a high-risk site');
  assert.equal(
    chromeGrants.run(() => chromeGrants.tasks.has('c1', 's1', 'https://www.travel.americanexpress.com')),
    true,
  );
  // a sensitive action: no task scope on its card, and a 'task' answer is taken as once
  pending = chromeGrants.act(AMEX, ctx, { tool: 'click', sensitive: { verb: 'pay' }, ordinary: true });
  params = await answerNext({ decision: 'allow', scope: 'task' });
  assert.equal(await pending, true);
  assert.equal(params.task, undefined);
  // Allow once on another site keeps nothing; Deny refuses
  pending = chromeGrants.act(CHASE, ctx, { tool: 'click', ordinary: true });
  await answerNext({ decision: 'allow', scope: 'once' });
  await pending;
  assert.equal(chromeGrants.tasks.has('c1', 's1', 'https://www.chase.com'), false);
  pending = chromeGrants.act(CHASE, ctx, { tool: 'click', ordinary: true });
  await answerNext({ decision: 'deny' });
  await assert.rejects(pending, { code: 'denied' });
});

test('page JavaScript, an upload, an action nobody read as ordinary and a non-financial high-risk site get no task scope', async () => {
  const { g, asked } = grants((req) => (req.task ? 'task' : true));
  await g.act(AMEX, ctx, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 1);
  // JavaScript and uploads (hostTools confirmed(), the Codex backend's Runtime.*) pass no `ordinary`: each asks, task-less
  await g.act(AMEX, ctx, { tool: 'JavaScript', summary: 'document.forms[0].submit()' });
  await g.act(AMEX, ctx, { tool: 'upload' });
  await g.act(AMEX, ctx, { tool: 'click', ordinary: false });
  assert.deepEqual(
    asked.slice(1).map((r: any) => r.task),
    [false, false, false],
  );
  // a password manager, a government portal, a router: high-risk but not financial, every action asks
  for (const url of ['https://my.1password.com/', 'https://login.gov/', 'https://192.168.1.1/']) {
    await g.act(url, ctx, { tool: 'click', ordinary: true });
    await g.act(url, ctx, { tool: 'click', ordinary: true });
  }
  assert.equal(asked.length, 10);
  assert.ok(asked.slice(4).every((r: any) => r.task === false));
});

test('taskCovers: scrolling, typing and plain clicks are ordinary; anything that commits, pays or was not read is not', () => {
  const read = (o: any = {}) => ({
    name: 'Check-in date',
    button: false,
    role: 'textbox',
    editable: true,
    secret: false,
    payment: false,
    consent: null,
    submits: false,
    form: null,
    ...o,
  });
  assert.equal(taskCovers(null, { kind: 'scroll' }), true);
  assert.equal(taskCovers(null, { kind: 'hover' }), true);
  assert.equal(taskCovers(read(), { kind: 'type', text: 'Taipei' }), true);
  assert.equal(taskCovers(read(), { kind: 'fill', value: 'Taipei' }), true);
  assert.equal(taskCovers(read({ name: 'Show more hotels', role: 'button', button: true }), { kind: 'click' }), true);
  assert.equal(taskCovers(read({ name: 'Free cancellation' }), { kind: 'check' }), true);
  assert.equal(taskCovers(read({ name: 'Sort by price' }), { kind: 'select' }), true);
  assert.equal(taskCovers(read(), { kind: 'key', keys: 'ArrowDown' }), true);
  // not ordinary
  assert.equal(taskCovers(null, { kind: 'click' }), false, 'an unread target');
  assert.equal(taskCovers(read(), null as any), false);
  assert.equal(taskCovers({ frame: true, unreadable: true }, { kind: 'click' }), false);
  for (const name of ['Confirm', 'Submit', 'Continue', 'Next', 'Add payee', 'Turn off 2-Step Verification', 'Save changes', 'Authorize'])
    assert.equal(taskCovers(read({ name, role: 'button', button: true }), { kind: 'click' }), false, name);
  assert.equal(taskCovers(read({ submits: true }), { kind: 'click' }), false);
  assert.equal(taskCovers(read({ consent: { app: 'x' } }), { kind: 'click' }), false);
  assert.equal(taskCovers(read({ payment: true }), { kind: 'type' }), false);
  assert.equal(taskCovers(read({ form: { payment: true } }), { kind: 'type' }), false);
  assert.equal(taskCovers(read(), { kind: 'key', keys: 'Enter' }), false);
  assert.equal(taskCovers(read({ button: true, role: 'button' }), { kind: 'key', keys: 'Space' }), false);
  assert.equal(taskCovers(read(), { kind: 'key', keys: 'Tab Enter' }), false);
  assert.equal(taskCovers(read(), { kind: 'drag' }), false);
  assert.equal(taskCovers(read(), { kind: 'dialog' }), false);
  assert.equal(taskCovers(read({ name: undefined, button: true }), { kind: 'click' }), false);
});

test('a fully read control with a plain label is ordinary on a financial site; one that commits still asks (#4441)', () => {
  const read = (o: any = {}) => ({
    role: 'button',
    button: true,
    editable: false,
    secret: false,
    payment: false,
    consent: null,
    submits: false,
    form: null,
    ...o,
  });
  // a travel search on a card's portal: the destination button, a date cell, a suggestion, a filter
  for (const name of ['Where to?', 'Friday, November 20, 2026', 'Paris, France', 'Travelers', '目的地', '選擇日期', '호텔', 'Close menu'])
    assert.equal(taskCovers(read({ name }), { kind: 'click' }), true, name);
  assert.equal(taskCovers(read({ name: 'Nonstop', role: 'checkbox', button: false }), { kind: 'check' }), true);
  assert.equal(taskCovers(read({ name: 'Economy', role: 'combobox', button: false }), { kind: 'select' }), true);
  // focusing a text field, whatever its label, as typing into it is
  assert.equal(
    taskCovers(read({ name: 'Confirm account number', role: 'textbox', button: false, editable: true }), { kind: 'click' }),
    true,
  );
  // a commit word in any covered language, inflected or inside a longer label
  for (const name of [
    'Booking',
    'Payment options',
    'Settings',
    'Log out',
    'Move money',
    'Use points',
    'Check out',
    'Weiter zur Kasse',
    'Réserver',
    'Confirmar',
    'Prenota ora',
    '立即预订',
    '次へ進む',
    '결제하기',
  ])
    assert.equal(taskCovers(read({ name }), { kind: 'click' }), false, name);
  // a script the commit lists don't know, a symbol, a single letter, an overlong label, a missing role
  for (const name of ['Подтвердить', 'تأكيد', '→', 'x', 'a'.repeat(81)])
    assert.equal(taskCovers(read({ name }), { kind: 'click' }), false, name);
  assert.equal(taskCovers(read({ name: 'Where to?', role: undefined }), { kind: 'click' }), false);
  // the reader's flags still decide first
  assert.equal(taskCovers(read({ name: 'Where to?', submits: true }), { kind: 'click' }), false);
  assert.equal(taskCovers(read({ name: 'Where to?', form: { payment: true } }), { kind: 'click' }), false);
  assert.equal(taskCovers(read({ name: 'Where to?', consent: { app: 'x' } }), { kind: 'click' }), false);
  // a text field's label doesn't make a check or pick on it ordinary
  assert.equal(taskCovers(read({ name: 'Confirm', role: 'textbox', button: false, editable: true }), { kind: 'select' }), false);
  assert.equal(plainLabel('where to?'), true);
});

test('a late answer cannot revive a task grant after the turn ends', async () => {
  let finish: any;
  const { g, asked } = grants(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = g.act(AMEX, ctx, { ordinary: true });
  while (!finish) await new Promise((r) => setImmediate(r));
  g.turnEnded(ctx.chatId);
  finish('task');
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(g.tasks.has(ctx.chatId, ctx.segmentId, 'https://www.travel.americanexpress.com'), false);
  finish = null;
  const retry = g.act(AMEX, ctx, { ordinary: true });
  while (!finish) await new Promise((r) => setImmediate(r));
  finish(true);
  await retry;
  assert.equal(asked.length, 2);
});

test('unknown controls and untranslated commit buttons still ask under a task grant', () => {
  for (const name of ['', '确认转账', 'Weiter', '✔', 'Freigeben']) {
    assert.equal(taskCovers({ name, role: 'button' }, { kind: 'click' }), false, name);
  }
});

test('combined labels, unread fields and line breaks cannot borrow task consent', () => {
  for (const name of [
    'Open account',
    'Close account',
    'Search and book',
    'Show more and buy',
    'Hotel Paris – Book now',
    'Room 12 – Reserve',
    '搜索并支付',
    '查看并确认',
  ])
    assert.equal(taskCovers({ name, role: 'button' }, { kind: 'click' }), false, name);
  for (const action of [
    { kind: 'type', text: 'x' },
    { kind: 'fill', value: 'x' },
    { kind: 'key', keys: 'ArrowDown' },
  ])
    assert.equal(taskCovers({}, action), false);
  const read = { role: 'textbox', button: false, editable: true, secret: false, payment: false, consent: null, submits: false, form: null };
  for (const text of ['query\n', 'query\r']) assert.equal(taskCovers(read, { kind: 'type', text }), false);
});

test('an aborted previous-turn call cannot use a newer turn grant on the same origin', async () => {
  const { g } = grants(() => 'task');
  await g.act(AMEX, ctx, { ordinary: true });
  g.turnEnded(ctx.chatId);
  await g.act(AMEX, ctx, { ordinary: true });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(g.act(AMEX, { ...ctx, signal: abort.signal }, { ordinary: true }), { code: 'aborted' });
});

test('a whitelisted name cannot replace missing reader flags or a payment form', () => {
  assert.equal(taskCovers({ name: 'Search', role: 'button' }, { kind: 'click' }), false);
  const read = { name: 'Search', role: 'button', button: true, secret: false, payment: false, consent: null, submits: false, form: null };
  assert.equal(taskCovers(read, { kind: 'click' }), true);
  assert.equal(taskCovers({ ...read, form: { payment: true } }, { kind: 'click' }), false);
});

test('different calls in the same running task retain only ordinary scope until that turn ends', async () => {
  const { g, asked } = grants(() => 'task');
  await g.act(AMEX, ctx, { ordinary: true });
  await g.act(AMEX, ctx, { ordinary: true, tool: 'peer-requested search' });
  await g.act(AMEX, ctx, { ordinary: false, sensitive: { verb: 'pay' } });
  assert.equal(asked.length, 2);
  g.turnEnded(ctx.chatId);
  await g.act(AMEX, ctx, { ordinary: true });
  assert.equal(asked.length, 3);
});

test('without an executor token, financial actions keep per-action consent and never offer task scope', async () => {
  const requests: any[] = [];
  const g = new OriginGrants({
    confirmAction: async (r: any) => {
      requests.push(r);
      return 'task';
    },
  });
  await g.act(AMEX, ctx, { ordinary: true });
  await g.act(AMEX, ctx, { ordinary: true });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.task === false));
  assert.equal(g.tasks.byChat.size, 0);
  g.tasks.add(ctx.chatId, ctx.segmentId, AMEX);
  assert.equal(g.tasks.byChat.size, 0);
  for (const text of ['\t ', '\u0000', '\u2028'])
    assert.equal(
      taskCovers(
        { role: 'textbox', button: false, editable: true, secret: false, payment: false, submits: false, consent: null, form: null },
        { kind: 'type', text },
      ),
      false,
    );
});

test('parallel ordinary asks share the site lane: task consent covers followers, once and denial do not poison it', async () => {
  let answer: any = 'task';
  const { g, asked } = grants(() => answer);
  await Promise.all([g.act(AMEX, ctx, { ordinary: true }), g.act(AMEX, ctx, { ordinary: true })]);
  assert.equal(asked.length, 1);
  g.turnEnded('c1');
  answer = true;
  await Promise.all([g.act(AMEX, ctx, { ordinary: true }), g.act(AMEX, ctx, { ordinary: true })]);
  assert.equal(asked.length, 3);
  answer = false;
  await assert.rejects(g.act(AMEX, ctx, { ordinary: true }), { code: 'denied' });
  answer = 'task';
  await g.act(AMEX, ctx, { ordinary: true });
  assert.equal(asked.length, 5);
});

test('a queued follower rechecks read-only mode before borrowing the leader grant', async () => {
  let anchor = 'ask';
  const g = withTurns(new OriginGrants({ anchor: () => anchor, confirmAction: async () => 'task' }));
  const add = g.tasks.add.bind(g.tasks);
  g.tasks.add = (...args: any[]) => {
    add(...args);
    anchor = 'readOnly';
  };
  const a = g.act(AMEX, ctx, { ordinary: true });
  const b = g.act(AMEX, ctx, { ordinary: true });
  const results = await Promise.allSettled([a, b]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'read_only');
});

test('a queued follower aborted before its lane opens never shows a card or borrows the leader consent', async () => {
  let finish: any;
  const { g, asked } = grants(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const stop = new AbortController();
  const a = g.act(AMEX, ctx, { ordinary: true });
  const b = g.act(AMEX, { ...ctx, signal: stop.signal }, { ordinary: true });
  const refused = assert.rejects(b, { code: 'aborted' });
  while (!finish) await new Promise((r) => setImmediate(r));
  stop.abort();
  finish('task');
  await a;
  await refused;
  assert.equal(asked.length, 1);
});
