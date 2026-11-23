// MoMo asking the owner and the owner answering (host/src/momoServices/questions.mjs, host/src/momoAskTool.mjs, intent `question.answer`): the model asks through the real registry, the question is a row, the owner's first answer wins and is given to the model once, a question of another lease is void, and a run in the background never asks.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { IntentError } from '../shared/momoHomeApi.mjs';
// @ts-ignore
import { createIntentRegistry } from '../shared/momoIntents.mjs';
import { createRequire } from 'node:module';
import { owner, said, world } from './support/host/notesToolWorld.ts';

const { segmentKey } = createRequire(import.meta.url)('../electron/platform/segmentOwner.cjs');

const ask = { title: 'Which calendar should I use?', body: 'You have two.', options: ['Work', 'Home'] };

async function asking(t: any, extra: object = {}) {
  const w = await world(t, extra);
  const rows: any[] = [];
  w.home.rows = { put: async (r: any) => void rows.push(JSON.parse(JSON.stringify(r))) };
  const registry = createIntentRegistry({ running: () => !!w.home.stamp() });
  registry.register('gate', w.home.service('gate').intents);
  const run = registry.intents() as Record<string, (i: any) => Promise<any>>;
  const answer = (id: string, optionId: string, by = { id: 'phone:a', name: 'Phone' }) =>
    run['question.answer']({ kind: 'question.answer', id, optionId, by });
  const questions = () => w.home.service('questions').view() as any[];
  const last = (id: string) => rows.filter((r) => r.id === `question:${id}`).at(-1);
  return { w, rows, answer, questions, last };
}

test('the model asks, the question is a row and waits; asking the same again does not ask twice; the owner’s answer is given back to the model once, and a new ask is a new question', async (t) => {
  const { w, rows, answer, questions, last } = await asking(t);
  await owner(w, 'Plan my week');
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:question_pending');
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:question_pending');
  const [q] = questions();
  assert.equal(rows.filter((r) => r.kind === 'question').length, 1, 'one row, however often it is asked');
  assert.deepEqual(
    [last(q.id).question.status, last(q.id).question.options.map((o: any) => o.label), last(q.id).question.expiresAt],
    ['pending', ['Work', 'Home'], null],
  );
  await answer(q.id, q.options[0].id);
  assert.deepEqual(
    [last(q.id).question.status, last(q.id).question.answer.optionId, last(q.id).question.answer.device],
    ['answered', 'o1', ''],
  );
  assert.match(said(await w.call(w.M, 'momo_ask', ask)), /The owner answered "Work" to "Which calendar should I use\?"/);
  // given once: asking again is a new question
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:question_pending');
  assert.equal(questions().length, 2);
});

test('the first answer wins; a second, a wrong option, a gone question and an answer nobody can record are each told', async (t) => {
  const { w, answer, questions } = await asking(t);
  await owner(w, 'Plan my week');
  await w.call(w.M, 'momo_ask', ask);
  const [q] = questions();
  await assert.rejects(answer(q.id, 'o9'), (e: any) => e instanceof IntentError && /not one of the answers/.test(e.message));
  const { breakAudit } = await import('./support/host/momoCoreWorld.ts');
  const fix = breakAudit(w as any);
  await assert.rejects(answer(q.id, 'o1'), /couldn’t record that/);
  fix();
  assert.equal(questions()[0].status, 'pending');
  await answer(q.id, 'o2', { id: 'desktop:b', name: 'Mac' });
  await assert.rejects(answer(q.id, 'o1'), /already answered/);
  assert.equal(questions()[0].answer.optionId, 'o2');
  await assert.rejects(answer('nope', 'o1'), /That question is gone/);
});

test('a question needs a short title and two to six different answers, no more than ten wait, and a run in the background never asks', async (t) => {
  const { w, questions } = await asking(t);
  await owner(w, 'Plan my week');
  for (const bad of [
    { title: '', options: ['a', 'b'] },
    { title: 'Q', options: ['only'] },
    { title: 'Q', options: ['a', 'a'] },
    { title: 'Q', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { title: 'Q', options: ['a', ''] },
  ])
    assert.equal(said(await w.call(w.M, 'momo_ask', bad)), 'refused:invalid', JSON.stringify(bad));
  for (let i = 0; i < 10; i++)
    assert.equal(said(await w.call(w.M, 'momo_ask', { title: `Question ${i}`, options: ['a', 'b'] })), 'refused:question_pending');
  assert.equal(said(await w.call(w.M, 'momo_ask', { title: 'One too many', options: ['a', 'b'] })), 'refused:invalid');
  assert.equal(questions().length, 10);
  const run = w.home.chats.startBackground('claude', 'routine');
  assert.equal(said(await w.call(run, 'momo_ask', ask)), 'refused:read_only');
});

test('a question of a lease this home no longer holds is void and cannot be answered', async (t) => {
  const { w, answer, questions, last } = await asking(t);
  await owner(w, 'Plan my week');
  await w.call(w.M, 'momo_ask', ask);
  const [q] = questions();
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  await assert.rejects(answer(q.id, 'o1'), /can no longer be answered, because MoMo moved/);
  assert.equal(last(q.id).question.status, 'void');
});

test('a chat that holds outside content is not asked questions through a card, the tool is absent without a grant, and a row that cannot be written is reported once and the question stands', async (t) => {
  const reports: string[] = [];
  const { w, questions } = await asking(t, { report: (m: string) => reports.push(m) });
  await owner(w, 'Plan my week');
  w.home.rows = {
    put: async () => {
      throw new Error('no chat');
    },
  };
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:question_pending');
  assert.equal(questions().length, 1);
  assert.ok(reports.some((m) => /could not write a question's row: no chat/.test(m)));
  // injected text must not put its own words in front of the owner or fill the waiting places: there MoMo says what it needs in the chat
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  assert.equal(said(await w.call(w.M, 'momo_ask', { title: 'Wire the money?', options: ['Yes', 'No'] })), 'refused:unavailable');
  assert.equal(questions().length, 1, 'no question was made');
  const off = await world(t, { grant: false });
  assert.ok(!off.names(off.M).includes('momo_ask'));
  assert.deepEqual(await off.home.service('questions').ask({ chatId: off.M, title: 'Q', options: ['a', 'b'] }), { state: 'away' });
  assert.deepEqual(await off.home.service('questions').answer('x', 'o1', { id: 'd' }), { won: false, status: 'not_home' });
  assert.deepEqual(off.home.service('questions').view(), []);
});

test('the rows of questions asked while MoMo had no chat are written when the gate next looks', async (t) => {
  const { w, rows, questions } = await asking(t);
  w.home.chats = { ...w.home.chats, main: () => null } as any;
  await owner(w, 'Plan my week');
  w.home.rows = {
    put: async () => {
      throw new Error('no chat');
    },
  };
  await w.call(w.M, 'momo_ask', ask);
  assert.equal(rows.length, 0);
  w.home.rows = { put: async (r: any) => void rows.push(r) };
  w.home.chats = { isMain: () => true, isMomoChat: () => true, main: () => ({ chatId: w.M }) } as any;
  await w.home.service('gate').sweep();
  await w.home.service('questions').syncRows();
  assert.equal(rows.filter((r: any) => r.id === `question:${questions()[0].id}`).length >= 1, true);
});

test('seeding keeps one pending question, and the file opens with the home’s data key', async (t) => {
  const { w, questions } = await asking(t);
  await w.home.seed();
  assert.equal(questions().filter((q) => q.status === 'pending').length >= 1, true);
  assert.ok(w.home.data.sealed('questions.json', (v: any) => v).read().items.length >= 1);
});

test('a damaged record of questions reads as what can be read of it, and a reset forgets them', async (t) => {
  const { w, questions } = await asking(t);
  await w.home.data
    .sealed('questions.json', (v: any) => v ?? { items: [] })
    .change((all: any) => {
      all.items = [{ id: 5 }, null, { id: 'q1', title: 'Kept', options: [], status: 'pending', fence: 'x' }];
    });
  assert.deepEqual(
    questions().map((q) => q.id),
    ['q1'],
  );
  await w.home.reset();
  assert.deepEqual(questions(), []);
});

test('a call from a segment that is not the chat’s, a Host that is not the home, answers with no device name and options that are not a list are each told or kept as they are', async (t) => {
  const { w, answer, questions } = await asking(t);
  await owner(w, 'Plan my week');
  assert.equal(said(await w.registry.invoke(w.M, segmentKey('claude', crypto.randomUUID()), 'momo_ask', ask)), 'refused:unavailable');
  const questionsService = w.home.service('questions');
  assert.deepEqual(await questionsService.ask({ chatId: w.M, title: 'Q', options: 'not a list' }), { state: 'invalid' });
  const real = questionsService.ask;
  questionsService.ask = async () => ({ state: 'away' });
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:unavailable');
  questionsService.ask = real;
  await w.call(w.M, 'momo_ask', ask);
  await answer(questions()[0].id, 'o1', { id: 'phone:abc' } as any);
  assert.equal(questions()[0].answer.device, '', 'no device on the question');
  const away = await world(t, { start: false });
  await away.home.service('questions').syncRows();
});

test('a question that waits is never trimmed, the answered ones go first; and stale ones are voided by the sweep, with their row, without anybody asking', async (t) => {
  const { w, rows, questions, answer, last } = await asking(t);
  await owner(w, 'Plan my week');
  await w.call(w.M, 'momo_ask', { title: 'The one that waits', options: ['a', 'b'] });
  const waiting = questions()[0];
  for (let i = 0; i < 105; i++) {
    await w.call(w.M, 'momo_ask', { title: `Question ${i}`, options: ['a', 'b'] });
    const q = questions().find((x) => x.title === `Question ${i}`);
    await answer(q.id, 'o1');
  }
  assert.ok(questions().length <= 100);
  assert.equal(questions().find((x) => x.id === waiting.id)?.status, 'pending');
  // the lease changes: the sweep voids the waiting ones and writes their rows
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  await w.home.service('questions').sweep();
  assert.equal(questions().find((x) => x.id === waiting.id)?.status, 'void');
  assert.equal(last(waiting.id).question.status, 'void');
  w.home.stamp = () => null;
  await w.home.service('questions').sweep();
  assert.ok(rows.length > 0);
});

test('the questions look at themselves when the home starts and every minute', async (t) => {
  const { w, questions } = await asking(t);
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  await owner(w, 'Plan my week');
  await w.call(w.M, 'momo_ask', ask);
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  for (const end = Date.now() + 3000; questions()[0]?.status !== 'void' && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(questions()[0].status, 'void', 'looked at when the home started');
  w.home.stamp = () => {
    throw new Error('no stamp');
  };
  const reports: string[] = [];
  const questionsService = w.home.service('questions');
  const orig = questionsService.sweep;
  questionsService.sweep = async () => {
    reports.push('swept');
    return orig();
  };
  mock.timers.tick(60_000);
  assert.ok(reports.length >= 1, 'and again on the timer');
  w.home.stamp = real;
});

test('with no gate no question is asked: a missing gate counts as a chat that read outside content', async (t) => {
  const { w, questions } = await asking(t);
  await owner(w, 'Plan my week');
  const gate = w.home.gate;
  // the runner found the gate and handed the call on; by the time the tool asks, there is none
  w.home.gate = {
    ...gate,
    run: async (call: any, run: () => unknown) => {
      w.home.gate = null;
      return gate.run(call, run);
    },
  };
  assert.equal(said(await w.call(w.M, 'momo_ask', ask)), 'refused:unavailable');
  assert.equal(questions().length, 0);
  w.home.gate = gate;
});
