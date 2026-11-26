// The chat's question, result and watch-changed cards and the void approval, drawn from the shared fixture both UIs import (shared/momoRowsFixture.ts): the words are the Mac's, session text is plain text, and each answer goes out once as the table's intent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_ROWS } from '../shared/momoRowsFixture.ts';
import { mount, tap, unmountAll, type Any } from './support/phone/momo-screens';

const only = (id: string) => FIXTURE_ROWS.filter((r) => r.id === id);
const show = (rows: Any[]) => (v: Any) => {
  v.chat = rows;
};

test('a pending question offers each answer once, and a closed one says what happened', async () => {
  const m = await mount(show(only('question:pending')));
  assert.match(m.text(), /Which calendar should I use\?/);
  assert.match(m.text(), /You have two\./);
  await tap('Work');
  assert.deepEqual(m.sent, [{ kind: 'question', id: 'ask-pending', optionId: 'work' }]);
  await unmountAll();
  const cases: [string, RegExp][] = [
    ['question:answered', /You chose Work\./],
    ['question:answered-elsewhere', /Answered on your iPhone at .*You chose Work\./],
    ['question:expired', /Expired.*Nobody answered\. Nothing was done\./],
    ['question:void', /No longer valid.*MoMo moved, so this question can’t be answered\./],
  ];
  for (const [id, pattern] of cases) {
    const c = await mount(show(only(id)));
    assert.match(c.text(), pattern, id);
    assert.equal(c.text().includes('Home'), false, `${id} offers no answer`);
    await unmountAll();
  }
});

test('a question that ran out of time, or has a status this phone does not know, offers no answer', async () => {
  const pending = only('question:pending')[0] as Any;
  const late = await mount(show([{ ...pending, question: { ...pending.question, expiresAt: 1 } }]));
  assert.match(late.text(), /Nobody answered\. Nothing was done\./);
  await unmountAll();
  const odd = await mount(show([{ ...pending, question: { ...pending.question, status: 'frozen' } }]));
  assert.match(odd.text(), /Update MoPilot to answer this\./);
  assert.equal(odd.text().includes('Work'), false);
  await unmountAll();
  const gone = await mount(
    show([{ ...pending, question: { ...pending.question, body: '', status: 'answered', answer: { optionId: 'x', device: 'a', at: 1 } } }]),
  );
  assert.match(gone.text(), /You chose x\./);
  await unmountAll();
  const none = await mount(show([{ ...pending, question: { ...pending.question, status: 'answered', answer: null } }]));
  assert.match(none.text(), /Answered\./);
  await unmountAll();
  const away = await mount(show([{ ...pending, question: { ...pending.question, status: 'answered-elsewhere', answer: null } }]));
  assert.match(away.text(), /other device/);
});

test('a result card shows what the task found as plain text, with the home’s own actions', async () => {
  const m = await mount(show(only('result:task-1:1')));
  assert.match(m.text(), /Reconcile March invoices/);
  assert.match(m.text(), /Ready · Studio/);
  assert.match(m.text(), /Matched 41 of 42 invoices/);
  assert.match(m.text(), /reconciliation-march\.xlsx/);
  assert.match(m.text(), /Checked: The report lists every invoice/);
  await tap('Review');
  assert.deepEqual(m.sent, [{ kind: 'task-act', taskId: 'task-1', fixId: 'review' }]);
  await unmountAll();
  const failed = await mount(show(only('result:task-3:1')));
  assert.match(failed.text(), /Couldn’t finish · Studio/);
  await unmountAll();
  const base = (only('result:task-1:1')[0] as Any).result;
  const needs = await mount(
    show([{ kind: 'result', id: 'r1', at: 1, result: { ...base, state: 'needs_you', files: [], checked: '', actions: [] } }]),
  );
  assert.match(needs.text(), /Needs you · Studio/);
  await unmountAll();
  // a state this phone does not know shows only where it ran
  const odd = await mount(
    show([{ kind: 'result', id: 'r2', at: 1, result: { ...base, state: 'odd', files: [], checked: '', actions: [] } }]),
  );
  assert.equal(/Ready|Needs you|Couldn’t finish/.test(odd.text()), false);
});

test('a watch-changed card says what is different and where it is watched from', async () => {
  const m = await mount(show(only('watch:task-2:1')));
  assert.match(m.text(), /Price of the flight to Berlin/);
  assert.match(m.text(), /It dropped from 212 to 168\./);
  assert.match(m.text(), /Watching from Studio/);
});

test('an approval whose home is no longer the home says so and can be asked again', async () => {
  const m = await mount(show(only('approval:void')));
  assert.match(m.text(), /No longer valid/);
  assert.match(m.text(), /MoMo moved, so this card can’t be answered\./);
});

test('every fixture row is read by the phone: none is dropped for a missing part', async () => {
  const m = await mount(show(FIXTURE_ROWS as Any[]));
  assert.match(m.text(), /Which calendar should I use\?/);
});

test('a question with no text of its own draws only its title and answers', async () => {
  const pending = only('question:pending')[0] as Any;
  const m = await mount(show([{ ...pending, question: { ...pending.question, body: '' } }]));
  assert.match(m.text(), /Which calendar should I use\?/);
  assert.equal(m.text().includes('You have two.'), false);
});

test('a row of a known kind missing its parts is left out, and the other rows stay', async () => {
  const transportPath = '../mobile/src/momoPhone/transport';
  const { parseHomeView } = await import(transportPath);
  const { fixtureShared } = await import('../mobile/src/momoPhone/fixtures');
  const good = FIXTURE_ROWS.filter((r) => ['question:pending', 'result:task-1:1', 'watch:task-2:1'].includes(r.id));
  const bad = [
    { kind: 'question', id: 'q', at: 1, question: { id: 'x' } },
    { kind: 'question', id: 'q2', at: 1 },
    { kind: 'result', id: 'r', at: 1, result: { taskId: 't' } },
    { kind: 'result', id: 'r2', at: 1 },
    { kind: 'watch-changed', id: 'w', at: 1, watch: { taskId: 't' } },
    { kind: 'watch-changed', id: 'w2', at: 1 },
  ];
  const view = { ...fixtureShared(), chat: [...bad, ...good] };
  assert.deepEqual(
    parseHomeView({ view }, 1).view.chat.map((r: Any) => r.id),
    ['question:pending', 'result:task-1:1', 'watch:task-2:1'],
  );
});

test('a card or question answered on a device that is not named says "other device", and a void card says why when the home says', async () => {
  const q = only('question:answered-elsewhere')[0] as Any;
  const asked = await mount(show([{ ...q, question: { ...q.question, answer: { ...q.question.answer, device: '' } } }]));
  assert.match(asked.text(), /Answered on your other device at /);
  await unmountAll();
  const a = only('approval:void')[0] as Any;
  const why = await mount(
    show([{ ...a, approval: { ...a.approval, failure: { cause: 'The note’s line changed.', fix: null }, canAskAgain: false } }]),
  );
  assert.match(why.text(), /No longer valid/);
  assert.match(why.text(), /The note’s line changed\./);
  assert.equal(why.text().includes('Ask again'), false);
  await unmountAll();
  const gone = await mount(show([{ ...a, approval: { ...a.approval, answeredElsewhere: { device: '', at: 1, outcome: 'approved' } } }]));
  assert.match(gone.text(), /Answered on your other device at /);
});
