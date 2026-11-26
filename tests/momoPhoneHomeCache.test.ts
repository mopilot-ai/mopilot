// What MoMo's phone keeps between runs: the notes and the messages not yet confirmed, sealed and bound to their account and computer, forgotten with them, and put back so a killed app loses no message and sends none twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush } from './support/phone/component-kit';

const cachePath = '../mobile/src/momoPhone/homeCache';
const storePath = '../mobile/src/momoPhone/store';
const fxPath = '../mobile/src/momoPhone/fixtures';
const { createHomeCache, guardHomeCache } = await import(cachePath);
const { createMomoStore } = await import(storePath);
const { createFixtureTransport, fixtureView, fixtureShared } = await import(fxPath);

type Any = any;
const AT = { user: 'u1', pair: 'p1' };

/** A sealed store held in memory, with a stand-in for the device key: what is stored can be looked at and cannot be read. */
function memory(delay = false) {
  let raw: string | null = null;
  const later = () => (delay ? new Promise((resolve) => setImmediate(resolve)) : undefined);
  const xor = (bytes: Uint8Array) => bytes.map((b) => b ^ 0x5a);
  const cache = createHomeCache({
    store: {
      read: async () => (await later(), raw),
      write: async (v: string) => (await later(), void (raw = v)),
      clear: async () => (await later(), void (raw = null)),
    },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
        xor(new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...plain])),
      open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
        const text = new TextDecoder().decode(xor(box));
        return text.startsWith(`${aad}|`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
      },
    },
  });
  return { cache, raw: () => raw, set: (v: string | null) => void (raw = v) };
}
const turn = (id: string, delivery: string, text = id) => ({ id, text, at: 1, delivery });

test('the copy is sealed, comes back for its own account and computer, and another computer’s is left alone', async () => {
  const m = memory();
  assert.deepEqual([await m.cache.scopes(), await m.cache.load(AT)], [[], { status: 'none' }]);
  const notes = fixtureShared().notes;
  await m.cache.save(AT, { notes, turns: [turn('t1', 'queued')] });
  await m.cache.save({ user: 'u1', pair: 'p2' }, { notes: [], turns: [turn('b1', 'queued')] });
  assert.deepEqual(await m.cache.scopes(), [AT, { user: 'u1', pair: 'p2' }]);
  assert.equal(m.raw()!.includes('Renewal in progress'), false, 'what is kept at rest is not readable');
  assert.equal(m.raw()!.includes('token'), false);
  const back = await m.cache.load(AT);
  assert.deepEqual([back.status, back.copy.notes[0].title, back.copy.turns[0].id], ['ok', 'Acme', 't1']);
  const other = await m.cache.load({ user: 'u1', pair: 'p2' });
  assert.equal(other.copy.turns[0].id, 'b1', 'opening MoMo on one computer does not touch the other’s messages');
  assert.deepEqual(await m.cache.load({ user: 'u1', pair: 'p3' }), { status: 'none' });
  assert.deepEqual(await m.cache.load({ user: 'u2', pair: 'p1' }), { status: 'none' });
  await m.cache.save(AT, { notes, turns: [] });
  assert.equal((await m.cache.scopes()).length, 2, 'saving again replaces the row');
});

test('forgetting drops only the rows it names, and the last row empties the store', async () => {
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [] });
  await m.cache.save({ user: 'u1', pair: 'p2' }, { notes: [], turns: [] });
  await m.cache.forget((s: Any) => s.pair === 'p9');
  assert.equal((await m.cache.scopes()).length, 2);
  await m.cache.forget((s: Any) => s.pair === 'p2');
  assert.deepEqual(await m.cache.scopes(), [AT]);
  await m.cache.forget(() => true);
  assert.equal(m.raw(), null);
  await m.cache.save(AT, { notes: [], turns: [] });
  await m.cache.clear();
  assert.equal(m.raw(), null);
});

test('something kept that cannot be read is told apart from nothing kept', async () => {
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [turn('q', 'queued')] });
  const saved = JSON.parse(m.raw()!);
  const row = saved.rows[0];
  for (const bad of [
    { ...row, box: row.box.replace(/^../, 'ff') },
    { ...row, box: '00' },
    { ...row, nonce: 'zz', box: 'zz' },
  ]) {
    m.set(JSON.stringify({ rows: [bad] }));
    assert.deepEqual(await m.cache.load(AT), { status: 'unreadable' });
  }
  // a locked or lost key
  const locked = createHomeCache({
    store: { read: async () => JSON.stringify(saved), write: async () => undefined, clear: async () => undefined },
    crypto: {
      key: async () => {
        throw new Error('keychain locked');
      },
      randomBytes: () => new Uint8Array(24),
      seal: (_k: Uint8Array, _n: Uint8Array, p: Uint8Array) => p,
      open: () => null,
    },
  });
  assert.deepEqual(await locked.load(AT), { status: 'unreadable' });
  // a store that cannot be read
  const broken = createHomeCache({
    store: {
      read: async () => {
        throw new Error('disk');
      },
      write: async () => undefined,
      clear: async () => undefined,
    },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: () => new Uint8Array(24),
      seal: (_k: Uint8Array, _n: Uint8Array, p: Uint8Array) => p,
      open: () => null,
    },
  });
  assert.deepEqual(await broken.load(AT), { status: 'unreadable' });
  // a row whose copy is not a copy
  const plain = memory();
  await plain.cache.save(AT, { notes: 'x', turns: [] } as Any);
  assert.deepEqual(await plain.cache.load(AT), { status: 'unreadable' });
  await plain.cache.save(AT, { notes: [], turns: 'x' } as Any);
  assert.deepEqual(await plain.cache.load(AT), { status: 'unreadable' });
  // rows that are not rows are no rows; a container that is not one is damaged, which is never the same as empty
  m.set('{"rows":[{"user":1}]}');
  assert.deepEqual([await m.cache.load(AT), await m.cache.scopes()], [{ status: 'none' }, []]);
  for (const raw of ['not json', '{}', '{"rows":"x"}']) {
    m.set(raw);
    assert.deepEqual([await m.cache.load(AT), await m.cache.scopes()], [{ status: 'unreadable' }, []], raw);
    // it is never written over: the save fails, the forget leaves it, and what is there stays
    await assert.rejects(m.cache.save(AT, { notes: [], turns: [] }));
    await m.cache.forget(() => true);
    assert.equal(m.raw(), raw);
  }
});

test('two stores and the guard writing at once never drop each other’s rows', async () => {
  const m = memory(true);
  const B = { user: 'u1', pair: 'p2' };
  const slow = m.cache;
  await Promise.all([
    slow.save(AT, { notes: [], turns: [turn('a', 'queued')] }),
    slow.save(B, { notes: [], turns: [turn('b', 'queued')] }),
    slow.forget((s: Any) => s.pair === 'p3'),
    slow.save(AT, { notes: [], turns: [turn('a', 'queued'), turn('c', 'queued')] }),
  ]);
  assert.deepEqual((await m.cache.scopes()).map((s: Any) => s.pair).sort(), ['p1', 'p2']);
  assert.equal((await m.cache.load(AT)).copy.turns.length, 2);
  assert.equal((await m.cache.load(B)).copy.turns[0].id, 'b');
});

function runtimeOf(user: string | null, pairs: string[], phase = 'online') {
  const state = { phase, user: user ? { id: user } : null, pairs: pairs.map((pairId) => ({ pairId })) as Any, list: new Set<() => void>() };
  return {
    state,
    runtime: {
      snapshot: () => state,
      subscribe: (l: () => void) => (state.list.add(l), () => void state.list.delete(l)),
    },
    change: async (user2: string | null, pairs2?: string[], phase2?: string) => {
      state.user = user2 ? { id: user2 } : null;
      if (pairs2) state.pairs = pairs2.map((pairId) => ({ pairId }));
      if (phase2) state.phase = phase2;
      for (const l of [...state.list]) l();
      await flush();
    },
  };
}

test('a copy is forgotten when its account signs out or its computer is unpaired: while the app runs, and while it was closed', async () => {
  const keep = async () => {
    const m = memory();
    await m.cache.save(AT, { notes: [], turns: [] });
    await m.cache.save({ user: 'u1', pair: 'p2' }, { notes: [], turns: [] });
    return m;
  };
  // signing out while running
  let m = await keep();
  let r = runtimeOf('u1', ['p1', 'p2']);
  let stop = guardHomeCache(r.runtime, m.cache);
  await flush();
  assert.equal((await m.cache.scopes()).length, 2, 'a start that finds everything in place forgets nothing');
  await r.change(null, []);
  assert.equal(m.raw(), null);
  stop();
  // unpairing one computer while running
  m = await keep();
  r = runtimeOf('u1', ['p1', 'p2']);
  stop = guardHomeCache(r.runtime, m.cache);
  await flush();
  await r.change('u1', ['p2']);
  assert.deepEqual(await m.cache.scopes(), [{ user: 'u1', pair: 'p2' }]);
  stop();
  // closed: a launch finds a row for a computer that is gone, and one for another account
  m = await keep();
  await m.cache.save({ user: 'u9', pair: 'p1' }, { notes: [], turns: [] });
  r = runtimeOf('u1', ['p2']);
  stop = guardHomeCache(r.runtime, m.cache);
  await flush();
  assert.deepEqual(await m.cache.scopes(), [{ user: 'u1', pair: 'p2' }]);
  stop();
  // a launch that finds nobody signed in forgets everything
  m = await keep();
  r = runtimeOf(null, [], 'signedOut');
  stop = guardHomeCache(r.runtime, m.cache);
  await flush();
  assert.equal(m.raw(), null);
  stop();
  // the vault is not read yet: nothing is judged until it is
  m = await keep();
  r = runtimeOf('u1', [], 'loading');
  stop = guardHomeCache(r.runtime, m.cache);
  await flush();
  assert.equal((await m.cache.scopes()).length, 2);
  await r.change('u1', ['p1', 'p2'], 'online');
  assert.equal((await m.cache.scopes()).length, 2);
  await r.change('u1', ['p1'], 'online');
  assert.deepEqual(await m.cache.scopes(), [AT]);
  stop();
  // a stopped guard watches nothing; a snapshot with no phase or pair list is read as ready and empty
  const s2 = await keep();
  const r2 = runtimeOf('u1', ['p1', 'p2']);
  guardHomeCache(r2.runtime, s2.cache)();
  await r2.change(null, []);
  assert.ok(s2.raw());
  const s4 = await keep();
  guardHomeCache({ snapshot: () => ({ user: { id: 'u1' } }), subscribe: () => () => undefined } as Any, s4.cache);
  await flush();
  assert.equal(s4.raw(), null, 'no computers at all: every row is one of a computer that is gone');
});

const persistOf = (m: ReturnType<typeof memory>, at = AT) => ({ load: () => m.cache.load(at), save: (c: Any) => m.cache.save(at, c) });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const asleep = () => {
  const v = fixtureView();
  v.view.home.state = 'asleep';
  return v;
};

test('a message held when the app is killed is still there and goes out once the home is back', async () => {
  const m = memory();
  const first = createMomoStore(createFixtureTransport(asleep()), { newId: () => 'k1', now: () => 5, persist: persistOf(m) });
  await first.load();
  first.sendText('Please attach it');
  await settle();
  assert.equal((await m.cache.load(AT)).copy.turns[0].text, 'Please attach it');
  first.dispose();
  // the app starts again
  const transport = createFixtureTransport(asleep());
  const sent: Any[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (i: Any) => (sent.push(i), send(i));
  const second = createMomoStore(transport, { persist: persistOf(m) });
  await second.load();
  assert.deepEqual(
    second.get().turns.map((t: Any) => [t.id, t.delivery]),
    [['k1', 'queued']],
  );
  assert.deepEqual(sent, [], 'a home that sleeps is sent nothing');
  await second.act({ kind: 'wake' });
  await settle();
  assert.deepEqual(
    sent.filter((i: Any) => i.kind === 'send'),
    [{ kind: 'send', turnId: 'k1', text: 'Please attach it' }],
  );
});

test('a message sent and not confirmed stays in doubt after a kill and is never sent again by itself', async () => {
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [turn('d1', 'not-sure', 'was it sent'), turn('q1', 'queued', 'next one')] });
  const transport = createFixtureTransport(fixtureView());
  const sent: Any[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (i: Any) => (sent.push(i), send(i));
  const store = createMomoStore(transport, { persist: persistOf(m) });
  await store.load();
  await settle();
  assert.deepEqual(
    store.get().turns.map((t: Any) => [t.id, t.delivery]),
    [
      ['d1', 'not-sure'],
      ['q1', 'queued'],
    ],
  );
  assert.deepEqual(
    sent.filter((i: Any) => i.kind === 'send'),
    [],
    'nothing goes after a message in doubt',
  );
  // the home answers that it has the turn: both are the home's now, and the phone lets go
  const home = fixtureView();
  home.view.chat.push({ kind: 'user', id: 'd1', at: 1, text: 'was it sent', delivery: 'accepted' });
  transport.emit({ view: home.view });
  await settle();
  assert.deepEqual(
    store.get().turns.map((t: Any) => t.id),
    ['q1'],
  );
  assert.deepEqual(
    sent.filter((i: Any) => i.kind === 'send').map((i) => i.turnId),
    ['q1'],
  );
});

test('a message the home accepted is not kept, and a restored one the home already lists is let go', async () => {
  const m = memory();
  const store = createMomoStore(createFixtureTransport(fixtureView()), { newId: () => 'a1', persist: persistOf(m) });
  await store.load();
  store.sendText('hello');
  await settle();
  await settle();
  assert.equal(store.get().turns[0].delivery, 'accepted');
  assert.deepEqual((await m.cache.load(AT)).copy.turns, [], 'accepted is the home’s: not kept');
  const listed = memory();
  await listed.cache.save(AT, { notes: [], turns: [turn('known', 'queued')] });
  const view = fixtureView();
  view.view.chat.push({ kind: 'user', id: 'known', at: 1, text: 'known', delivery: 'accepted' });
  const again = createMomoStore(createFixtureTransport(view), { persist: persistOf(listed) });
  await again.load();
  assert.deepEqual(again.get().turns, []);
});

test('the notes are kept for reading when the home cannot be read, and come from the home when it can', async () => {
  const m = memory();
  const transport = createFixtureTransport(fixtureView());
  const first = createMomoStore(transport, { persist: persistOf(m) });
  await first.load();
  await settle();
  assert.equal((await m.cache.load(AT)).copy.notes[0].title, 'Acme');
  first.dispose();
  const out = createMomoStore(
    {
      load: async () => {
        throw new Error('Studio did not answer.');
      },
      send: async () => ({ ok: true }),
      subscribe: () => () => undefined,
    },
    { persist: persistOf(m) },
  );
  await out.load();
  assert.deepEqual([out.get().view, out.get().failure?.cause, out.get().cached?.[0].title], [null, 'Studio did not answer.', 'Acme']);
  // a held message typed while the home is out of reach keeps the notes in the copy
  out.sendText('later');
  await settle();
  const kept = (await m.cache.load(AT)).copy;
  assert.deepEqual([kept.notes[0].title, kept.turns[0].text], ['Acme', 'later']);
  out.dispose();
  assert.equal(out.get().cached, null);
});

test('an unchanged copy is not written again, writes go one after another, and a failed write or read is not a crash', async () => {
  const writes: string[] = [];
  let release: () => void = () => undefined;
  const slow = {
    load: async () => ({ status: 'none' }),
    save: (c: Any) => new Promise<void>((resolve) => (release = () => (writes.push(c.turns.map((t: Any) => t.text).join(',')), resolve()))),
  };
  const store = createMomoStore(createFixtureTransport(fixtureView()), {
    persist: slow,
    newId: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
  });
  await store.load();
  await settle();
  release();
  await settle();
  const before = writes.length;
  store.dismissFailure();
  assert.equal(writes.length, before, 'nothing changed: nothing written');
  const failing = createMomoStore(createFixtureTransport(fixtureView()), {
    persist: {
      load: async () => {
        throw new Error('disk');
      },
      save: async () => {
        throw new Error('disk full');
      },
    },
  });
  await failing.load();
  const kept = await failing.sendText('still works');
  assert.deepEqual([kept, failing.get().turns.length, failing.get().lost], [false, 0, true], 'nothing is sent that cannot be kept');
});

test('a message typed before the kept ones are read is not taken: nothing can be kept yet', async () => {
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [turn('old', 'queued', 'from before')] });
  const store = createMomoStore(createFixtureTransport(asleep()), { newId: () => 'dup', persist: persistOf(m) });
  assert.equal(await store.sendText('typed early'), false);
  await store.load();
  assert.deepEqual(
    store.get().turns.map((t: Any) => t.id),
    ['old'],
  );
  assert.equal(await store.sendText('typed after'), true);
  assert.deepEqual(
    store.get().turns.map((t: Any) => t.id),
    ['old', 'dup'],
  );
});
