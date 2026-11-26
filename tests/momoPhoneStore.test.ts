// MoMo's phone store: the home's view with what the user did laid over it, held messages sent once, refusals kept with their cause and fix, and the in-memory home the screens are driven from.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const storePath = '../mobile/src/momoPhone/store';
const fxPath = '../mobile/src/momoPhone/fixtures';
const { createMomoStore, applyIntent, intentKey } = await import(storePath);
const { createFixtureTransport, fixtureView } = await import(fxPath);

type Any = any;
const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};
const mk = (view = fixtureView()) => {
  const transport = createFixtureTransport(view);
  const sent: Any[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (intent: Any) => (sent.push(intent), send(intent));
  return { transport, sent, store: createMomoStore(transport, { newId: ids(), now: () => 1000 }) };
};
const asleep = () => {
  const v = fixtureView();
  v.view.home.state = 'asleep';
  return v;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const idle = { load: async () => fixtureView(), subscribe: () => () => undefined };

test('the store loads the view once and tells listeners', async () => {
  const { store } = mk();
  let calls = 0;
  const off = store.subscribe(() => calls++);
  assert.equal(store.get().view, null);
  await store.load();
  assert.equal(store.get().view.view.home.machineName, 'Studio');
  assert.equal(store.get().loading, false);
  assert.ok(calls >= 2);
  off();
  const before = calls;
  store.dismissFailure();
  assert.equal(calls, before);
});

test('a failed first load keeps its real cause and no view', async () => {
  for (const [thrown, cause] of [
    [new Error('Studio did not answer.'), 'Studio did not answer.'],
    ['plain', 'plain'],
  ] as const) {
    const store = createMomoStore({
      ...idle,
      load: async () => {
        throw thrown;
      },
      send: async () => ({ ok: true }),
    });
    await store.load();
    assert.deepEqual([store.get().view, store.get().failure], [null, { cause, fix: null }]);
  }
});

test('a push from the home merges into the view, and is ignored before the first load or after dispose', async () => {
  const { transport, store } = mk();
  transport.emit({ waking: true });
  assert.equal(store.get().view, null);
  await store.load();
  transport.emit({ waking: false, now: 5 });
  assert.equal(store.get().view.now, 5);
  store.dispose();
  transport.emit({ now: 9 });
  assert.deepEqual([store.get().view, store.get().turns], [null, []]);
});

test('Wake is laid over the view until the home answers; an answer with no view still clears it', async () => {
  const { store } = mk(asleep());
  await store.load();
  const p = store.act({ kind: 'wake' });
  assert.equal(store.get().view.waking, true);
  assert.deepEqual([...store.get().busy], [intentKey({ kind: 'wake' })]);
  assert.equal((await p).ok, true);
  assert.equal(store.get().view.view.home.state, 'running');
  assert.deepEqual([store.get().view.waking, store.get().busy.size], [false, 0]);
  const quiet = createMomoStore({ ...idle, send: async () => ({ ok: true }) });
  await quiet.load();
  await quiet.act({ kind: 'wake' });
  assert.equal(quiet.get().view.waking, false, 'an ok answer with no view does not leave Wake showing');
});

test('the same intent twice is one: a second tap while the first is in flight sends nothing', async () => {
  const { store, sent } = mk();
  await store.load();
  const a = store.act({ kind: 'task-stop', taskId: 't1' });
  const b = store.act({ kind: 'task-stop', taskId: 't1' });
  assert.equal(a, b);
  await a;
  assert.equal(sent.filter((i) => i.kind === 'task-stop').length, 1);
  await store.act({ kind: 'task-stop', taskId: 't2' });
  assert.equal(sent.filter((i) => i.kind === 'task-stop').length, 2);
});

test('a refused intent leaves the home’s view as it is and shows the real cause with its one-tap fix', async () => {
  const { transport, store } = mk(asleep());
  await store.load();
  transport.fail({ ok: false, cause: 'Studio did not wake.', fix: { kind: 'open-where' }, fixLabel: 'Move MoMo' });
  assert.equal((await store.act({ kind: 'wake' })).ok, false);
  assert.equal(store.get().view.waking, false);
  assert.deepEqual(store.get().failure, { cause: 'Studio did not wake.', fix: { label: 'Move MoMo', intent: { kind: 'open-where' } } });
  store.dismissFailure();
  assert.equal(store.get().failure, null);
  transport.fail({ ok: false, cause: 'Nope.' });
  await store.act({ kind: 'prefs', patch: { previews: true } });
  assert.equal(store.get().failure.fix, null);
  assert.equal(store.get().view.view.settings.previews, false);
  for (const e of [new Error('relay down'), 'x']) {
    const boom = createMomoStore({
      ...idle,
      send: async () => {
        throw e;
      },
    });
    await boom.load();
    await boom.act({ kind: 'task-stop', taskId: 't1' });
    assert.equal(boom.get().failure.cause, e instanceof Error ? 'relay down' : 'x');
    assert.equal(boom.get().view.view.tasks[0].state, 'working');
  }
});

test('a refusal never puts an old view over what the home said meanwhile', async () => {
  const { transport, store } = mk();
  await store.load();
  let release: (r: Any) => void = () => undefined;
  transport.send = () => new Promise((resolve) => (release = resolve));
  const p = store.act({ kind: 'task-stop', taskId: 't1' });
  assert.equal(store.get().view.view.tasks[0].state, 'stopped');
  const next = fixtureView();
  next.view.home.machineName = 'Pushed';
  transport.emit({ view: next.view });
  release({ ok: false, cause: 'No.' });
  await p;
  assert.equal(store.get().view.view.home.machineName, 'Pushed');
  assert.equal(store.get().view.view.tasks[0].state, 'working');
});

test('every intent that shows at once is laid over the view and taken off the same way', async () => {
  const base = fixtureView();
  base.view.home.move = {
    moveId: 'm',
    from: { machineId: 'studio', name: 'Studio' },
    to: { machineId: 'mini', name: 'Mac mini' },
    step: 'copied',
    outcome: 'failed',
    finishedAt: null,
    failure: { cause: 'x', failedAt: 'copied' },
    oldMachineOffline: false,
  };
  assert.equal(applyIntent(base, { kind: 'wake' }).waking, true);
  assert.equal(applyIntent(base, { kind: 'rule-undo', ruleId: 'r1' }).view.rules[0].state, 'undone');
  assert.equal(applyIntent(base, { kind: 'rule-undo', ruleId: 'zzz' }).view.rules[0].state, 'on');
  assert.deepEqual(applyIntent(base, { kind: 'prefs', patch: { dailyCap: 3 } }).view.settings.dailyCap, 3);
  const full = applyIntent(base, {
    kind: 'prefs',
    patch: { brief: false, briefTime: '07:00', quietFrom: '21:00', quietTo: '07:00', previews: true, notifications: 'allowed' },
  }).view;
  assert.deepEqual(
    [full.settings.brief, full.settings.quietHours, full.settings.previews, full.setup.notifications],
    [{ on: false, time: '07:00' }, { from: '21:00', to: '07:00' }, true, 'allowed'],
  );
  assert.equal(applyIntent(base, { kind: 'prefs', patch: {} }).view.setup, base.view.setup);
  assert.deepEqual(
    applyIntent(base, { kind: 'task-stop', taskId: 't1' }).view.tasks.map((t: Any) => t.state),
    ['stopped', 'watching'],
  );
  assert.equal(applyIntent(base, { kind: 'move-stay' }).view.home.move, null);
  assert.equal(applyIntent(base, { kind: 'move-ack' }).view.home.move, null);
  assert.equal(applyIntent(base, { kind: 'check-turn', turnId: 't' }), base, 'an intent with nothing to show changes nothing');
});

test('a message is saved, waits while the home sleeps, and goes out once when it wakes', async () => {
  const { transport, store, sent } = mk(asleep());
  await store.load();
  store.sendText('  Yes, attach it.  ');
  store.sendText('   ');
  assert.deepEqual(store.get().turns, [{ id: 't1', text: 'Yes, attach it.', at: 1000, delivery: 'queued' }]);
  assert.deepEqual(sent, [], 'nothing is sent to a home that sleeps');
  await store.act({ kind: 'wake' });
  await settle();
  assert.deepEqual(
    sent.filter((i: Any) => i.kind === 'send'),
    [{ kind: 'send', turnId: 't1', text: 'Yes, attach it.' }],
  );
  assert.equal(store.get().turns[0].delivery, 'accepted');
  const home = fixtureView();
  home.view.chat.push({ kind: 'user', id: 't1', at: 1, text: 'Yes, attach it.', delivery: 'accepted' });
  transport.emit({ view: home.view });
  assert.deepEqual(store.get().turns, [], 'the home lists it now, so the phone lets go of it');
});

test('one message at a time, oldest first, and a message in doubt is never sent again on its own', async () => {
  const { store, sent, transport } = mk();
  await store.load();
  let release: (r: Any) => void = () => undefined;
  const real = transport.send.bind(transport);
  transport.send = (i: Any) => (i.kind === 'send' ? new Promise((resolve) => (release = resolve)) : real(i));
  store.sendText('one');
  store.sendText('two');
  await settle();
  assert.deepEqual(
    store.get().turns.map((t: Any) => [t.text, t.delivery]),
    [
      ['one', 'not-sure'],
      ['two', 'queued'],
    ],
  );
  release({ ok: true });
  await settle();
  assert.deepEqual(
    store.get().turns.map((t: Any) => t.delivery),
    ['accepted', 'not-sure'],
    'the next one goes once the first is answered',
  );
  assert.equal(sent.length, 0);
});

test('a send that gets no answer stays in doubt; a refused one says it never got there and Send now sends it again', async () => {
  const quiet = mk();
  await quiet.store.load();
  quiet.transport.send = async () => {
    throw new Error('lost');
  };
  quiet.store.sendText('hello');
  await settle();
  assert.equal(quiet.store.get().turns[0].delivery, 'not-sure');
  quiet.store.sendText('second');
  await settle();
  assert.deepEqual(
    quiet.store.get().turns.map((t: Any) => t.delivery),
    ['not-sure', 'queued'],
    'nothing goes after a message in doubt',
  );
  const refused = mk();
  await refused.store.load();
  refused.transport.fail({ ok: false, cause: 'Busy.' });
  refused.store.sendText('hello');
  await settle();
  assert.equal(refused.store.get().turns[0].delivery, 'never-got-it');
  assert.equal(refused.store.get().failure.cause, 'Busy.');
  assert.equal((await refused.store.act({ kind: 'send', turnId: 't1', text: 'hello' })).ok, true);
  await settle();
  assert.equal(refused.store.get().turns[0].delivery, 'accepted');
  // a turn only the home lists (the home said it never got it) is held again under its own id
  const listed = mk();
  listed.transport.emit({});
  const view = fixtureView();
  view.view.chat.push({ kind: 'user', id: 'home1', at: 7, text: 'listed', delivery: 'never-got-it' });
  const other = mk(view);
  await other.store.load();
  await other.store.act({ kind: 'send', turnId: 'home1', text: 'listed' });
  await settle();
  assert.deepEqual(
    other.sent.filter((i: Any) => i.kind === 'send'),
    [{ kind: 'send', turnId: 'home1', text: 'listed' }],
  );
  assert.equal(other.store.get().turns.length, 0, 'the home lists it, so the phone does not hold it');
  await other.store.act({ kind: 'send', turnId: 'unlisted', text: 'again' });
  await settle();
  assert.equal(other.store.get().turns[0].at, 1000);
});

test('a refused answer to a card reads the home again', async () => {
  const { transport, store } = mk();
  await store.load();
  const fresh = fixtureView();
  fresh.view.home.machineName = 'Fresh';
  let loads = 0;
  transport.load = async () => (loads++ ? fresh : fixtureView());
  await store.load();
  transport.fail({ ok: false, cause: 'That card is gone.' });
  await store.act({ kind: 'approval', cardId: 'c1', answer: 'send' });
  assert.equal(store.get().view.view.home.machineName, 'Fresh');
  transport.load = async () => {
    throw new Error('offline');
  };
  transport.fail({ ok: false, cause: 'Again.' });
  await store.act({ kind: 'approval', cardId: 'c1', answer: 'send' });
  assert.equal(store.get().view.view.home.machineName, 'Fresh', 'a read that fails leaves what is shown');
});

test('dispose stops listening and forgets what was read from the home', async () => {
  const { transport, store } = mk();
  await store.load();
  store.sendText('hello');
  let told = 0;
  store.subscribe(() => told++);
  store.dispose();
  assert.deepEqual([store.get().view, store.get().turns, store.get().failure], [null, [], null]);
  transport.emit({ now: 3 });
  store.sendText('after');
  await store.load();
  assert.equal(told, 0);
  assert.equal(store.get().view, null);
});

test('the in-memory home answers each intent the way the design says', async () => {
  const { transport, store } = mk();
  await store.load();
  const run = async (intent: object) => {
    await store.act(intent);
    return store.get().view.view;
  };
  const move = (await run({ kind: 'move', toId: 'mac' })).home;
  assert.deepEqual(
    [move.state, move.move.to, move.move.from, move.move.step, move.move.outcome],
    ['moving', { machineId: 'mac', name: 'This Mac' }, { machineId: 'studio', name: 'Studio' }, 'paused', 'running'],
  );
  assert.equal((await run({ kind: 'move', toId: 'nowhere' })).home.move.to.name, 'nowhere');
  for (const kind of ['move-cancel', 'move-stay', 'move-ack']) {
    await run({ kind: 'move', toId: 'mac' });
    const home = (await run({ kind })).home;
    assert.deepEqual([home.state, home.move], ['running', null], kind);
  }
  const chose = await run({ kind: 'choose-home', machineId: 'mac' });
  assert.deepEqual(
    [
      chose.home.machineName,
      chose.setup.step,
      chose.home.machines.filter((m: { isHome: boolean }) => m.isHome).map((m: { machineId: string }) => m.machineId),
    ],
    ['This Mac', 'read', ['mac']],
  );
  const noName = fixtureView();
  noName.view.home.machineName = null;
  const t2 = createFixtureTransport(noName);
  assert.equal((await t2.send({ kind: 'move', toId: 'x' })).view.view.home.move.from.name, '');
  const noHome = fixtureView();
  noHome.view.home.homeMachineId = null;
  assert.equal((await createFixtureTransport(noHome).send({ kind: 'move', toId: 'x' })).view.view.home.move.from.machineId, '');
  const lost = await run({ kind: 'choose-home', machineId: 'nowhere' });
  assert.equal(lost.home.machineName, 'This Mac');
  const card = (v: { chat: { kind: string; approval?: { status: string } }[] }) =>
    v.chat.find((r) => r.kind === 'approval')!.approval!.status;
  assert.equal(card(await run({ kind: 'approval', cardId: 'c1', answer: 'send' })), 'completed');
  assert.equal(card(await run({ kind: 'approval', cardId: 'c1', answer: 'deny' })), 'denied');
  assert.equal(card(await run({ kind: 'approval', cardId: 'c1', answer: 'ask-again' })), 'pending');
  assert.equal(card(await run({ kind: 'approval', cardId: 'other', answer: 'send' })), 'pending');
  const asked = (await run({ kind: 'notice-not-needed', noticeId: 'a1' })).chat.find((r: { kind: string }) => r.kind === 'assistant');
  assert.equal(asked.notNeeded.suggestion.ruleId, 'r1');
  const other = (await run({ kind: 'notice-not-needed', noticeId: 'zz' })).chat.filter((r: { kind: string }) => r.kind === 'assistant');
  assert.equal(other.length, 1);
  assert.equal((await run({ kind: 'rule-undo', ruleId: 'r1' })).rules[0].state, 'undone');
  assert.equal((await run({ kind: 'rule-undo', ruleId: 'zz' })).rules[0].state, 'undone');
  assert.equal((await run({ kind: 'rule-set', ruleId: 'r1', on: true })).rules[0].state, 'on');
  assert.equal((await run({ kind: 'rule-set', ruleId: 'r1', on: false })).rules[0].state, 'off');
  assert.equal((await run({ kind: 'rule-set', ruleId: 'zz', on: false })).rules.length, 1);
  assert.equal((await run({ kind: 'task-stop', taskId: 't1' })).tasks[0].state, 'stopped');
  assert.equal((await run({ kind: 'task-stop', taskId: 'zz' })).tasks.length, 2);
  const prefs = await run({
    kind: 'prefs',
    patch: {
      brief: false,
      briefTime: '7:00 AM',
      quietFrom: '9:00 PM',
      quietTo: '7:00 AM',
      dailyCap: 4,
      previews: true,
      notifications: 'allowed',
    },
  });
  assert.deepEqual(
    [prefs.settings.brief, prefs.settings.quietHours, prefs.settings.dailyCap, prefs.settings.previews],
    [{ on: false, time: '7:00 AM' }, { from: '9:00 PM', to: '7:00 AM' }, 4, true],
  );
  assert.equal((await run({ kind: 'prefs', patch: {} })).settings.dailyCap, 4);
  const edited = await run({ kind: 'note-edit', noteId: 'n1', lineId: 'l1', text: 'New' });
  assert.deepEqual([edited.notes[0].lines[0].text, edited.notes[0].lines[0].status], ['New', 'confirmed']);
  assert.equal((await run({ kind: 'note-edit', noteId: 'n1', lineId: 'zz', text: 'X' })).notes[0].lines[0].text, 'New');
  assert.equal((await run({ kind: 'note-edit', noteId: 'zz', lineId: 'l1', text: 'X' })).notes[0].lines[0].text, 'New');
  assert.equal((await run({ kind: 'wake' })).home.state, 'running');
  assert.equal((await run({ kind: 'note-forget', noteId: 'n1', lineId: 'l1' })).notes.length, 0);
  const before = transport.view();
  assert.equal((await transport.send({ kind: 'check-turn', turnId: 'x' })).ok, true);
  assert.equal(transport.view().view, before.view);
  assert.deepEqual((await createFixtureTransport(fixtureView()).send({ kind: 'wake' })).view.waking, false);
  const off = transport.subscribe(() => undefined);
  off();
});

test('without options a message gets its own id and the real clock', async () => {
  const transport = createFixtureTransport(fixtureView());
  const store = createMomoStore(transport);
  await store.load();
  store.sendText('hello');
  await settle();
  assert.match(store.get().turns[0].id, /^[0-9a-z]+-[0-9a-z]+$/);
  assert.ok(Math.abs(store.get().turns[0].at - Date.now()) < 5000);
});

test('an answer that comes after the store was disposed changes nothing', async () => {
  const { transport, store } = mk();
  await store.load();
  let release: (r: Any) => void = () => undefined;
  transport.send = () => new Promise((resolve) => (release = resolve));
  const p = store.act({ kind: 'task-stop', taskId: 't1' });
  store.dispose();
  release({ ok: false, cause: 'Late.' });
  await p;
  assert.deepEqual([store.get().view, store.get().failure], [null, null]);
});

test('forgetting one line keeps the note’s other lines; a line of another note is left alone', async () => {
  const view = fixtureView();
  view.view.notes[0].lines.push({ id: 'l2', text: 'Second', at: 1, status: 'learned', quote: null, sources: [] });
  view.view.notes.push({ ...view.view.notes[0], id: 'n2', lines: [{ ...view.view.notes[0].lines[0], id: 'l1' }] });
  const t = createFixtureTransport(view);
  const out = (await t.send({ kind: 'note-forget', noteId: 'n1', lineId: 'l1' })).view.view.notes;
  assert.deepEqual(
    out.map((n: Any) => [n.id, n.lines.map((l: Any) => l.id)]),
    [
      ['n1', ['l2']],
      ['n2', ['l1']],
    ],
  );
});
