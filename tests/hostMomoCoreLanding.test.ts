// The landing review of #5494 on the Host: the gate's taint in its own file and never forgotten, the model's note proposals audited first, a card's fields by a fixed priority, the open-loop list as a read, and a reaction counted only when every line it needs can be written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import gateService from '../host/src/momoServices/gate.mjs';
import { A, host } from './support/host/momoMoveWorld.ts';
import { breakAudit, chat, code, world } from './support/host/momoCoreWorld.ts';

test('the gate’s taint has its own file, never reads or rewrites the scheduler’s, and forgets no chat however many there are', async (t) => {
  const w = await world(t);
  const theirs = path.join(w.home.storage.dir, 'taint.json');
  fs.writeFileSync(theirs, '{"scheduler":"its own shape"}');
  const gate = w.home.service('gate');
  for (let i = 0; i < 650; i++) await gate.taintFor(`chat-${i}`).toolResult('outside');
  assert.equal(fs.readFileSync(theirs, 'utf8'), '{"scheduler":"its own shape"}');
  assert.ok(fs.existsSync(path.join(w.home.storage.dir, 'gate-taint.json')));
  gateService(w.deps);
  const again = w.home.service('gate');
  assert.deepEqual(
    [again.taintFor('chat-0').tainted(), again.taintFor('chat-649').tainted(), again.taintFor('chat-650').tainted()],
    [true, true, false],
  );
});

test('the model’s own proposals to the notes are audited before they are kept: with no audit log they are not', async (t) => {
  const w = await world(t);
  const said = { id: 'm1', kind: 'chat', at: '2026-11-22T10:00:00.000Z', text: 'I prefer email to calls', owner: true };
  const add = {
    type: 'add',
    title: 'Dana',
    kind: 'person',
    sourceId: 'm1',
    text: 'Prefers email to calls',
    quote: 'I prefer email to calls',
  };
  const actions: string[] = [];
  const real = w.home.stores.bind(w.home);
  w.home.stores = () => {
    const s = real();
    return (
      s && {
        ...s,
        audit: {
          ...s.audit,
          intent: (f: any) => (actions.push(f.action), s.audit.intent(f)),
          outcome: s.audit.outcome.bind(s.audit),
          refusal: s.audit.refusal.bind(s.audit),
        },
      }
    );
  };
  const fix = breakAudit(w);
  assert.equal(await w.notes.ops([add], { chatId: 'momo-chat', sources: [said], trigger: 'chat' }), null);
  assert.equal(w.notes.view().length, 0);
  fix();
  w.home.stores = () => {
    const s = real();
    return (
      s && {
        ...s,
        audit: {
          ...s.audit,
          intent: (f: any) => (actions.push(f.action), s.audit.intent(f)),
          outcome: s.audit.outcome.bind(s.audit),
          refusal: s.audit.refusal.bind(s.audit),
        },
      }
    );
  };
  assert.equal((await w.notes.ops([add], { chatId: 'momo-chat', sources: [said], trigger: 'chat' }))?.applied.length, 1);
  assert.ok(actions.some((a) => a.startsWith('notes.changed')));
  // a proposal with nothing to change needs no line
  const before = actions.length;
  assert.equal((await w.notes.ops([{ type: 'nope' }], { chatId: 'momo-chat', sources: [said], trigger: 'chat' }))?.applied.length, 0);
  assert.equal(actions.length, before);
});

test('a card shows who, where and how much first, whole up to 1000 characters, says what it leaves out, flags look-alike characters, and a value it cannot show whole is refused', async (t) => {
  const w = await world(t);
  const args = {
    note: 'x',
    extra1: 1,
    extra2: 2,
    extra3: 3,
    extra4: 4,
    extra5: 5,
    extra6: 6,
    extra7: 7,
    extra8: 8,
    amount: 5000,
    to: 'dana@exаmple.com',
    nested: [{ a: 1 }],
  };
  assert.equal(await code(w.run.run({ ...chat(), tool: 'web_fetch', args }, () => 1)), 'approval_pending');
  const card = (await w.gate.cards('phone:a'))[0];
  const shown = card.fields.filter((f: any) => f.label !== 'Action' && f.label !== 'Touches');
  assert.deepEqual(
    shown.slice(0, 3).map((f: any) => f.label),
    ['to', 'amount', 'note'],
  );
  assert.match(shown[0].value, /look like others/);
  assert.equal(shown.at(-1).label, 'More');
  assert.match(shown.at(-1).value, /\+2 more fields not shown/);
  const small = await w.run
    .run({ ...chat(), tool: 'web_fetch', args: { to: 'a@b.c', nested: [{ a: 1 }], deep: { a: 1 } } }, () => 1)
    .catch((e: any) => e);
  assert.equal(small.code, 'approval_pending');
  const smallCard = (await w.gate.cards('phone:a')).find((c: any) => c.fields.some((f: any) => f.label === 'deep'));
  assert.deepEqual(
    smallCard.fields.filter((f: any) => ['nested', 'deep'].includes(f.label)).map((f: any) => f.value),
    ['(not shown: a list of 1)', '(not shown: an object)'],
  );
  // a value longer than 1000 characters is shown to the 1000th with a count, and the call is not put to a tap
  const long = { ...chat(), tool: 'web_fetch', args: { url: `https://example.org/${'a'.repeat(1500)}` } };
  assert.equal(await code(w.run.run(long, () => 1)), 'invalid');
  assert.equal(await code(w.run.run({ ...chat(), tool: 'momo_memory_search', args: { query: 'q'.repeat(1500) } }, () => 1)), 'ran');
});

test('listing the open loops is a read in any chat, saving to them is not', async (t) => {
  const w = await world(t);
  await w.gate.taintFor('momo-chat').toolResult('outside');
  assert.equal(await code(w.run.run({ ...chat(), tool: 'momo_open_loops', args: { action: 'list' } }, () => 1)), 'ran');
  assert.equal(
    await code(w.run.run({ ...chat(), tool: 'momo_open_loops', args: { action: 'close', id: 'x' } }, () => 1)),
    'approval_pending',
  );
});

test('a reaction that would turn a rule on or retire one is not counted unless both lines can be written', async (t) => {
  const w = await world(t);
  const gate = w.home.service('gate');
  const realPolicy = gate.policy;
  const action = { ...chat(), tool: 'gmail.send', effect: 'send' as const, scope: 'd@x.org', summary: 'Send a mail' };
  const answer = async (n: number, decision: 'allow' | 'deny') => {
    const asked = await w.gate.run({ ...action, args: { n } }, () => 1);
    await w.gate.answer(asked.card.id, decision, 'phone:a', 'Phone');
    return asked.card.id;
  };
  // the first deny is counted; the second would turn "always ask" on, and cannot be written
  const first = await answer(1, 'deny');
  assert.equal((await w.learning.reactToCard(first, 'deny', 'phone:a')).duplicate, false);
  const second = await answer(2, 'deny');
  gate.policy = async (_id: string, kind: string) => (kind === 'added' ? false : realPolicy(_id, kind, 'x'));
  assert.equal(await w.learning.reactToCard(second, 'deny', 'phone:a'), null);
  gate.policy = realPolicy;
  assert.equal((await w.learning.reactToCard(second, 'deny', 'phone:a')).change.kind, 'activated');
  // an Allow after that retires the rule; with the retirement unwritable it is not counted
  const third = await answer(3, 'allow');
  gate.policy = async (id: string, kind: string) => (kind === 'removed' ? false : realPolicy(id, kind, 'x'));
  assert.equal(await w.learning.reactToCard(third, 'always_allow', 'phone:a'), null);
  gate.policy = realPolicy;
  assert.equal((await w.learning.reactToCard(third, 'always_allow', 'phone:a')).retired.length, 1);
});

test('the one taint record: mark says whether the chat was already marked, a clear that undoes a later mark spares an earlier one, and the runner’s origins are understood', async (t) => {
  const w = await world(t);
  const taint = w.run.taint;
  assert.equal(taint.has('momo-chat'), false);
  assert.equal(await taint.mark('momo-chat'), false);
  assert.equal(await taint.mark('momo-chat'), true);
  assert.equal(await taint.clear('momo-chat', true), false);
  assert.equal(taint.has('momo-chat'), true);
  assert.equal(await taint.clear('momo-chat'), true);
  assert.equal(taint.has('momo-chat'), false);
  assert.equal(taint.has(undefined), true);
  // the runner says who started the turn: an owner's turn in a tainted chat asks, a background one is refused, an untainted one runs
  const save = (origin: string, text: string) =>
    w.run.run({ chatId: 'momo-chat', tool: 'momo_memory_save', args: { text }, origin }, () => 'saved');
  assert.equal(await code(save('owner', 'a')), 'ran');
  assert.equal(await code(save('background', 'b')), 'ran');
  await taint.mark('momo-chat');
  assert.equal(await code(save('owner', 'c')), 'approval_pending');
  assert.equal(await code(save('background', 'd')), 'read_only');
  assert.equal(await code(save('somebody', 'e')), 'read_only');
  // a Host that is not the home: everything is tainted and nothing is marked or cleared
  const idle = await host(t, A);
  gateService({ home: idle.home, now: () => 1 });
  const none = (idle.home as any).gate.taint;
  assert.deepEqual([none.has('c'), await none.mark('c'), await none.clear('c')], [true, true, false]);
});
