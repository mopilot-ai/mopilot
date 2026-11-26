// The messages the phone holds: the doubt is on the phone before a send leaves it, Check again asks the home, one send per message, and what was kept but cannot be read is never written over.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const storePath = '../mobile/src/momoPhone/store';
const fxPath = '../mobile/src/momoPhone/fixtures';
const vmPath = '../mobile/src/momoPhone/viewModels';
const { createMomoStore } = await import(storePath);
const { createFixtureTransport, fixtureView } = await import(fxPath);
const { withTurns, turnRow } = await import(vmPath);

type Any = any;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};
const quiet = (over: Any = {}) => ({
  load: async () => fixtureView(),
  subscribe: () => () => undefined,
  send: async () => ({ ok: true }),
  ...over,
});

test('the doubt is saved before the send leaves: a kill between the two finds it in doubt, never queued', async () => {
  const events: string[] = [];
  let finishSave: () => void = () => undefined;
  const persist = {
    load: async () => ({ status: 'none' }),
    save: (copy: Any) => {
      events.push(`save:${copy.turns.map((t: Any) => t.delivery).join(',')}`);
      return copy.turns.some((t: Any) => t.delivery === 'not-sure')
        ? new Promise<void>((resolve) => (finishSave = resolve))
        : Promise.resolve();
    },
  };
  const store = createMomoStore(quiet({ send: async () => (events.push('send'), { ok: true }) }), { newId: ids(), persist });
  await store.load();
  store.sendText('hello');
  await settle();
  assert.deepEqual(events.slice(-2), ['save:queued', 'save:not-sure'], 'the send waits for the doubt to be on the phone');
  assert.equal(events.includes('send'), false);
  finishSave();
  await settle();
  assert.deepEqual(events.slice(-2), ['send', 'save:']);
});

test('a message that cannot be kept is not sent, and says why', async () => {
  const sent: string[] = [];
  const persist = {
    load: async () => ({ status: 'none' }),
    save: async (copy: Any) => {
      if (copy.turns.some((t: Any) => t.delivery === 'not-sure')) throw new Error('disk full');
    },
  };
  const store = createMomoStore(quiet({ send: async (i: Any) => (sent.push(i.kind), { ok: true }) }), { newId: ids(), persist });
  await store.load();
  store.sendText('hello');
  await settle();
  assert.deepEqual(sent, []);
  assert.deepEqual(
    [store.get().turns[0].delivery, store.get().failure.cause],
    ['queued', "Couldn't save the message on this phone. It was not sent."],
  );
});

const inDoubt = async (answer: Any) => {
  const sent: Any[] = [];
  const store = createMomoStore(
    quiet({
      send: async (i: Any) => {
        sent.push(i);
        if (i.kind === 'send' && sent.filter((x) => x.kind === 'send').length === 1) throw new Error('lost');
        return i.kind === 'check-turn' ? answer(i) : { ok: true };
      },
    }),
    { newId: ids() },
  );
  await store.load();
  store.sendText('hello');
  await settle();
  assert.equal(store.get().turns[0].delivery, 'not-sure');
  return { store, sent };
};

test('Check again asks the home: a home that has it lets the phone go, one that does not says it never got it', async () => {
  const has = await inDoubt(() => {
    const v = fixtureView();
    v.view.chat.push({ kind: 'user', id: 't1', at: 1, text: 'hello', delivery: 'accepted' });
    return { ok: true, view: { view: v.view } };
  });
  await has.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.deepEqual(has.store.get().turns, []);
  assert.deepEqual(
    has.sent.map((i: Any) => i.kind),
    ['send', 'check-turn'],
  );
  const never = await inDoubt(() => ({ ok: true, turn: 'missing' }));
  await never.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(never.store.get().turns[0].delivery, 'never-got-it');
  const withView = await inDoubt(() => ({ ok: true, turn: 'missing', view: { view: fixtureView().view } }));
  await withView.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(withView.store.get().turns[0].delivery, 'never-got-it');
  // an answer that is not an explicit status ("unknown", or none at all) never says the home did not get it: it stays in doubt
  for (const answer of [{ ok: true }, { ok: true, turn: 'unknown' }, { ok: true, view: { view: fixtureView().view } }]) {
    const unsure = await inDoubt(() => answer);
    await unsure.store.act({ kind: 'check-turn', turnId: 't1' });
    assert.deepEqual([unsure.store.get().turns[0].delivery, unsure.store.get().turns[0].check], ['not-sure', 'unavailable']);
    await unsure.store.act({ kind: 'send', turnId: 't1', text: 'hello' });
    await settle();
    assert.equal(
      unsure.sent.filter((i: Any) => i.kind === 'send').length,
      1,
      'a message in doubt is not sent again without the home saying it never had it',
    );
  }
});

test('a home that cannot answer Check again leaves the message in doubt: only Check again is offered; once it says never, Send now sends once', async () => {
  const lacking = await inDoubt(() => ({ ok: false, cause: 'MoMo can’t do that yet.' }));
  const row = (store: Any) => {
    const v = withTurns(fixtureView(), store.get().turns);
    return turnRow(v, v.view.chat.at(-1));
  };
  assert.deepEqual(
    row(lacking.store).actions.map((a: Any) => a.label),
    ['Check again'],
  );
  await lacking.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(lacking.store.get().failure.cause, 'MoMo can’t do that yet.');
  assert.deepEqual(
    row(lacking.store).actions.map((a: Any) => a.label),
    ['Check again'],
  );
  await lacking.store.act({ kind: 'send', turnId: 't1', text: 'hello' });
  await settle();
  assert.equal(lacking.sent.filter((i: Any) => i.kind === 'send').length, 1);
  const missing = await inDoubt(() => ({ ok: true, turn: 'missing' }));
  await missing.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.deepEqual(
    row(missing.store).actions.map((a: Any) => a.label),
    ['Send now'],
  );
  await missing.store.act({ kind: 'send', turnId: 't1', text: 'hello' });
  await settle();
  assert.equal(missing.sent.filter((i: Any) => i.kind === 'send').length, 2);
  assert.equal(missing.store.get().turns[0].delivery, 'accepted');
  // a thrown check is a refusal too
  const thrown = await inDoubt(() => {
    throw new Error('relay down');
  });
  await thrown.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(thrown.store.get().failure.cause, 'relay down');
  const strange = await inDoubt(() => Promise.reject('x'));
  await strange.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(strange.store.get().failure.cause, 'x');
  // a check on a message the home lists goes the ordinary way
  const view = fixtureView();
  view.view.chat.push({ kind: 'user', id: 'home1', at: 1, text: 'listed', delivery: 'not-sure' });
  const listed = createMomoStore(createFixtureTransport(view));
  await listed.load();
  assert.equal((await listed.act({ kind: 'check-turn', turnId: 'home1' })).ok, true);
});

test('Check again twice, and Send now twice, are one each', async () => {
  const slow = await (async () => {
    const sent: Any[] = [];
    let release: (r: Any) => void = () => undefined;
    const store = createMomoStore(
      quiet({
        send: (i: Any) => {
          sent.push(i.kind);
          return i.kind === 'send' && sent.filter((k) => k === 'send').length === 1
            ? Promise.reject(new Error('lost'))
            : new Promise((resolve) => (release = resolve));
        },
      }),
      { newId: ids() },
    );
    await store.load();
    store.sendText('hello');
    await settle();
    return { store, sent, release: (r: Any) => release(r) };
  })();
  const a = slow.store.act({ kind: 'check-turn', turnId: 't1' });
  const b = slow.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.equal(a, b);
  slow.release({ ok: false, cause: 'No.' });
  await a;
  await settle();
  // Send now while the first send of the turn is on its way
  const store = createMomoStore(quiet({ send: () => new Promise(() => undefined) }), { newId: ids() });
  await store.load();
  store.sendText('again');
  await settle();
  const sent: Any[] = [];
  const t = createFixtureTransport(fixtureView());
  t.send = async (i: Any) => (sent.push(i.kind), { ok: true });
  const fresh = createMomoStore(t, { newId: ids() });
  await fresh.load();
  await Promise.all([fresh.act({ kind: 'send', turnId: 'x', text: 'y' }), fresh.act({ kind: 'send', turnId: 'x', text: 'y' })]);
  await settle();
  assert.equal(sent.filter((k) => k === 'send').length, 1);
  // a check while the turn's send is on its way does nothing
  const gate = createMomoStore(quiet({ send: () => new Promise(() => undefined) }), { newId: ids() });
  await gate.load();
  gate.sendText('hold');
  await settle();
  assert.equal(gate.get().turns[0].delivery, 'not-sure');
  assert.equal((await gate.act({ kind: 'check-turn', turnId: 't1' })).ok, true);
  assert.equal((await gate.act({ kind: 'send', turnId: 't1', text: 'hold' })).ok, true);
});

test('what was kept and cannot be read is never written over; the person is told and may start again', async () => {
  const saves: Any[] = [];
  let reads = 'unreadable';
  const persist = { load: async () => ({ status: reads }), save: async (c: Any) => void saves.push(c) };
  const store = createMomoStore(quiet(), { newId: ids(), persist });
  await store.load();
  assert.equal(store.get().lost, true);
  assert.equal(await store.sendText('new message'), false, 'nothing is sent that cannot be kept: its text stays with the person');
  assert.deepEqual(saves, [], 'nothing is written while what was kept is unreadable');
  assert.deepEqual(store.get().turns, []);
  assert.match(store.get().failure.cause, /Couldn't save the message/);
  store.discardLost();
  assert.equal(store.get().lost, false);
  assert.equal(await store.sendText('after discard'), true, 'after Discard what is kept starts again');
  await settle();
  assert.ok(saves.length >= 1);
  assert.equal(store.get().turns[0].delivery, 'accepted');
  // a read that throws is unreadable too
  const throwing = createMomoStore(quiet(), {
    persist: { load: async () => Promise.reject(new Error('keychain')), save: async () => undefined },
  });
  await throwing.load();
  assert.equal(throwing.get().lost, true);
  reads = 'none';
  const fine = createMomoStore(quiet(), { persist });
  await fine.load();
  assert.equal(fine.get().lost, false);
  throwing.dispose();
  assert.equal(throwing.get().lost, false);
});

test('a setting stays shown after an answer with no view, until the home’s next view says so; a refusal takes it off', async () => {
  const store = createMomoStore(quiet({ send: async () => ({ ok: true }) }));
  await store.load();
  await store.act({ kind: 'prefs', patch: { previews: true } });
  assert.equal(store.get().view.view.settings.previews, true, 'the toggle does not flip back');
  assert.equal(store.get().busy.size, 0, 'its button is not off');
  const next = fixtureView();
  const t = createFixtureTransport(fixtureView());
  const s2 = createMomoStore(quiet({ send: async () => ({ ok: true }), subscribe: (l: Any) => (t.subscribe(l), () => undefined) }));
  await s2.load();
  await s2.act({ kind: 'prefs', patch: { previews: true } });
  t.emit({ view: next.view });
  assert.equal(s2.get().view.view.settings.previews, false, 'the home’s view is the truth');
  const refused = createMomoStore(quiet({ send: async () => ({ ok: false, cause: 'No.' }) }));
  await refused.load();
  await refused.act({ kind: 'prefs', patch: { previews: true } });
  assert.equal(refused.get().view.view.settings.previews, false);
  const wake = createMomoStore(quiet({ send: async () => ({ ok: true }) }));
  await wake.load();
  await wake.act({ kind: 'wake' });
  assert.equal(wake.get().view.waking, false, 'Waking is not a setting: it does not stay');
});

test('a refused check shows its fix; an answer that comes after dispose changes nothing; two different intents in flight are separate', async () => {
  const refused = await inDoubt(() => ({ ok: false, cause: 'Not now.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' }));
  await refused.store.act({ kind: 'check-turn', turnId: 't1' });
  assert.deepEqual(refused.store.get().failure, { cause: 'Not now.', fix: { label: 'Wake Studio', intent: { kind: 'wake' } } });
  let release: (r: Any) => void = () => undefined;
  const late = await inDoubt(() => new Promise((resolve) => (release = resolve)));
  const p = late.store.act({ kind: 'check-turn', turnId: 't1' });
  late.store.dispose();
  release({ ok: true });
  await p;
  assert.deepEqual([late.store.get().view, late.store.get().turns], [null, []]);
  const releases: Any[] = [];
  const two = createMomoStore(quiet({ send: () => new Promise((resolve) => releases.push(resolve)) }));
  await two.load();
  const a = two.act({ kind: 'task-stop', taskId: 't1' });
  const b = two.act({ kind: 'prefs', patch: { previews: true } });
  assert.equal(two.get().busy.size, 2);
  releases[0]({ ok: true });
  await a;
  assert.equal(two.get().busy.size, 1, 'the other is still on its way');
  releases[1]({ ok: true });
  await b;
});
