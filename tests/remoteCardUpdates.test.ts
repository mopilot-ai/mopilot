// Card-history reads must not hold live text; late card payloads belong to their current read, transport and follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { rig, settle } from './support/remote-kit.ts';
import { waitFor } from './support/waitFor.ts';
import { snapshot as threadSnapshot, update } from '../mobile/src/presentation/thread.ts';
const require = createRequire(import.meta.url);
const { createOpenReads } = require('../electron/app/chromePanelOpenRead.cjs');
import { deferred, card, followed } from './support/card-update-kit.ts';

test('a real slow cardTurns read never holds delta; cards fill in later without overwriting newer state', async () => {
  const { r, p } = await followed();
  const history = deferred();
  let entered = false;
  const opened = createOpenReads({
    live: {},
    reachable: () => true,
    historyOf: {
      recent: () => {
        entered = true;
        return history.promise;
      },
    },
  });
  r.ops.cardsOf = async () => (await opened.cardTurns('c1')).turns.map((turn: any) => card(turn.id));
  const began = performance.now();
  r.state.patch('c1', { approvals: [{ id: 'a' }], turn: 'awaitingUser' });
  await waitFor(() => entered, 'history read');
  r.service.onFeedEvent({ ev: 'items.delta', chatId: 'c1', itemId: 'a', field: 'text', text: 'hello' });
  try {
    await waitFor(() => p.events('items.delta').length === 1, 'delta before history', { timeoutMs: 250 });
    console.log(`delta before history: ${Math.round(performance.now() - began)} ms (memory transport)`);
    r.state.patch('c1', { turn: 'running' });
    await waitFor(() => p.events('session.patch').at(-1)?.patch.turn === 'running', 'newer state');
  } finally {
    history.resolve({ turns: [{ id: 'a' }] });
  }
  await waitFor(() => p.events('cards.changed').length === 1, 'late card');
  assert.equal(p.events('cards.changed')[0].cards[0].id, 'a');
  assert.equal(p.events('cards.changed')[0].rev, r.state.get('c1').rev);
  assert.equal(
    p.events('session.patch').some((e: any) => e.patch.turn === 'awaitingUser'),
    true,
  );
  r.service.detach();
});

test('newer cards win when old success or rejection arrives later; a failed read can retry', async () => {
  for (const oldFails of [false, true]) {
    const { r, p } = await followed();
    const old = deferred();
    let calls = 0;
    r.ops.cardsOf = () => (++calls === 1 ? old.promise : Promise.resolve([card('new')]));
    r.state.patch('c1', { approvals: [{ id: 'old' }] });
    await waitFor(() => calls === 1, 'old read');
    r.state.patch('c1', { questions: [{ id: 'new' }] });
    await waitFor(() => p.events('cards.changed').length === 1, 'replacement cards');
    oldFails ? old.reject(new Error('obsolete history')) : old.resolve([card('old')]);
    await settle();
    assert.deepEqual(
      p.events('cards.changed').map((e: any) => e.cards[0].id),
      ['new'],
    );
    assert.equal(r.service.ledger.revOf('c1', 'old'), undefined);
    r.ops.cardsOf = async () => {
      throw new Error('current history failure');
    };
    r.state.patch('c1', { approvals: [] });
    await settle();
    r.ops.cardsOf = async () => [card('retry')];
    r.state.patch('c1', { questions: [] });
    await waitFor(() => p.events('cards.changed').length === 2, 'retry cards');
    assert.equal(p.events('cards.changed')[1].cards[0].id, 'retry');
    r.service.detach();
  }
});

test('unfollow/refollow and replacing transport retire old card reads even with the same pair/chat', async () => {
  for (const replaceTransport of [false, true]) {
    const { r, p } = await followed();
    const old = deferred();
    let reading = false;
    r.ops.cardsOf = () => {
      reading = true;
      return old.promise;
    };
    r.state.patch('c1', { approvals: [{ id: 'old' }] });
    await waitFor(() => reading, 'old read');
    if (replaceTransport) r.service.attach(r.link.mac);
    else await p.ask('chat.unfollow', { chatId: 'c1' });
    r.ops.cardsOf = async () => [card('snapshot')];
    assert.equal((await p.ask('chat.follow', { chatId: 'c1' })).result.session.cards[0].id, 'snapshot');
    old.resolve([card('old')]);
    await settle();
    assert.equal(p.events('cards.changed').length, 0);
    assert.equal(r.service.ledger.revOf('c1', 'old'), undefined);
    r.service.detach();
  }
});

test('Mac waiting-card history also leaves the text queue free', async () => {
  const { r, p } = await followed();
  const history = deferred();
  r.ops.waitingCards = () => [{ id: 'mac:1', title: 'Waiting', macOnly: true }];
  r.ops.cardsOf = () => history.promise;
  r.service.waiting.changed('c1');
  r.service.onFeedEvent({ ev: 'items.delta', chatId: 'c1', itemId: 'a', field: 'text', text: 'hello' });
  try {
    await waitFor(() => p.events('items.delta').length === 1, 'delta before waiting-card history', { timeoutMs: 250 });
  } finally {
    history.resolve([]);
  }
  await waitFor(() => p.events('cards.changed').length === 1, 'waiting card');
  assert.equal(p.events('cards.changed')[0].cards[0].where, 'mac-only');
  r.service.detach();
});

test('a queued card completion rechecks ownership, including before sending to each phone', async () => {
  const { r, p } = await followed();
  const q = r.phone('p2');
  await q.ask('chat.follow', { chatId: 'c1' });
  const gate = deferred();
  void r.service.enqueue('c1', () => gate.promise);
  r.ops.cardsOf = async () => [card('old')];
  r.state.patch('c1', { questions: [{ id: 'old' }] });
  await settle();
  r.ops.cardsOf = async () => [card('new')];
  r.state.patch('c1', { approvals: [{ id: 'new' }] });
  gate.resolve(undefined);
  await waitFor(() => p.events('cards.changed').length === 1, 'current queued cards');
  assert.deepEqual(
    p.events('cards.changed')[0].cards.map((c: any) => c.id),
    ['new'],
  );
  assert.equal(q.events('cards.changed').length, 1);
  const emit = r.service.emit.bind(r.service);
  r.service.emit = async (pairId: string, event: any) => {
    const result = await emit(pairId, event);
    r.service.detach();
    return result;
  };
  r.state.patch('c1', { questions: [] });
  await waitFor(() => !r.service.attached, 'detached while sending');
  assert.equal(q.events('cards.changed').length, 1, 'no continuation to next phone after transport retirement');
});

test('a removed pair and unfollow without replacement never receive a late card', async () => {
  for (const unpair of [false, true]) {
    const { r, p } = await followed();
    const old = deferred();
    r.ops.cardsOf = () => old.promise;
    r.state.patch('c1', { approvals: [{ id: 'old' }] });
    await settle();
    if (unpair) r.link.removePair('p1');
    else await p.ask('chat.unfollow', { chatId: 'c1' });
    old.resolve([card('old')]);
    await settle();
    assert.equal(p.events('cards.changed').length, 0);
    assert.equal(r.service.ledger.revOf('c1', 'old'), undefined);
    r.service.detach();
  }
});

test('MoMo subscriptions have the same retirement contract, and clearing follows retires each identity', async () => {
  const r = rig({ momo: true });
  r.service.momo = () => ({ mainChatId: async () => 'c1' });
  const p = r.phone('p1');
  assert.equal((await p.ask('momo.chat.follow', {})).ok, true);
  const old = deferred();
  r.ops.cardsOf = () => old.promise;
  r.state.patch('c1', { questions: [{ id: 'old' }] });
  await settle();
  await p.ask('momo.chat.unfollow', {});
  r.ops.cardsOf = async () => [];
  assert.equal((await p.ask('momo.chat.follow', {})).ok, true);
  old.resolve([card('old')]);
  await settle();
  assert.equal(p.events('cards.changed').length, 0);
  r.service.phones.get('p1').client.follows.clear();
  r.service.cardUpdates.changed('c1');
  r.service.detach();
  r.service.cardUpdates.changed('c1');
});

test('a retired queued read never starts history, and malformed history preserves the prior ledger', async () => {
  const { r, p } = await followed();
  let calls = 0;
  r.ops.cardsOf = async () => {
    calls++;
    return null;
  };
  r.service.cardUpdates.changed('c1');
  r.service.cardUpdates.retire('c1');
  await settle();
  assert.equal(calls, 0);
  r.state.patch('c1', { approvals: [{ id: 'malformed' }] });
  await waitFor(() => calls === 1, 'malformed history read');
  await settle();
  assert.equal(p.events('cards.changed').length, 0);
  assert.equal(r.service.ledger.revOf('c1', 'v1'), 0);
  r.ops.cardsOf = async () => [];
  r.state.patch('c1', { approvals: [] });
  await waitFor(() => p.events('cards.changed').length === 1, 'empty valid retry');
  assert.equal(r.service.ledger.revOf('c1', 'v1'), undefined);
  r.service.detach();
});

test('late snapshots re-read current cards rather than overwrite newer card ledgers', async () => {
  const { r, p } = await followed();
  const old = deferred();
  r.ops.cardsOf = () => old.promise;
  const snapshot = r.service.snapshot('c1', 10);
  r.ops.cardsOf = async () => [card('new')];
  r.state.patch('c1', { approvals: [{ id: 'new' }] });
  await waitFor(() => p.events('cards.changed').length === 1, 'new cards');
  old.resolve([card('old')]);
  assert.equal((await snapshot).session.cards[0].id, 'new');
  assert.equal(r.service.ledger.revOf('c1', 'new'), 1);
  assert.equal(r.service.ledger.revOf('c1', 'old'), undefined);
  assert.equal((await r.service.snapshot('c1', 10)).session.cards[0].id, 'new');
  r.service.detach();
});

test('a ready card queued before a later state patch cannot make the real phone reducer skip that patch', async () => {
  const { r, p } = await followed();
  const initial = threadSnapshot(await r.service.snapshot('c1', 10));
  const gate = deferred();
  void r.service.enqueue('c1', () => gate.promise);
  r.ops.cardsOf = async () => [card('ready')];
  r.state.patch('c1', { approvals: [{ id: 'ready' }], turn: 'awaitingUser' });
  const firstPatch = r.service.chains.get('c1');
  await waitFor(() => r.service.chains.get('c1') !== firstPatch, 'ready card queued before later patch');
  r.state.patch('c1', { turn: 'running' });
  gate.resolve(undefined);
  await waitFor(() => p.events('session.patch').length === 2 && p.events('cards.changed').length === 1, 'both patches and card');
  const wire = p.inbox.filter((event: any) => ['session.patch', 'cards.changed'].includes(event.ev));
  const shown = wire.reduce(update, initial);
  assert.equal(shown.session.turn, 'running');
  assert.equal(shown.rev, r.state.get('c1').rev);
  assert.deepEqual(
    wire.map((event: any) => [event.ev, event.rev]),
    [
      ['session.patch', 1],
      ['cards.changed', 1],
      ['session.patch', 2],
    ],
  );
  assert.equal((shown.session.cards as any[])[0].id, 'ready');
  r.service.detach();
});

test('a newer snapshot replaces a queued card payload and broadcasts its latest list to the existing phone', async () => {
  const { r, p } = await followed();
  const gate = deferred();
  void r.service.enqueue('c1', () => gate.promise);
  r.ops.cardsOf = async () => [card('queued')];
  r.state.patch('c1', { questions: [{ id: 'question' }] });
  const statePatch = r.service.chains.get('c1');
  await waitFor(() => r.service.chains.get('c1') !== statePatch, 'ready card callback queued');
  r.ops.cardsOf = async () => [card('snapshot')];
  await r.service.snapshot('c1', 10);
  gate.resolve(undefined);
  await waitFor(() => !r.service.chains.has('c1'), 'queue drained');
  assert.deepEqual(
    p.events('cards.changed').map((e: any) => e.cards[0].id),
    ['snapshot'],
  );
  assert.equal(r.service.ledger.revOf('c1', 'queued'), undefined);
  assert.equal(r.service.ledger.revOf('c1', 'snapshot'), 1);
  r.service.detach();
});

test('a snapshot accepted between sends broadcasts the latest list to both phones', async () => {
  const { r, p } = await followed();
  const q = r.phone('p2');
  const initialA = threadSnapshot(await r.service.snapshot('c1', 10));
  const initialB = threadSnapshot((await q.ask('chat.follow', { chatId: 'c1' })).result);
  const emit = r.service.emit.bind(r.service);
  r.service.emit = async (pairId: string, event: any) => {
    const result = await emit(pairId, event);
    r.ops.cardsOf = async () => [card('snapshot')];
    await r.service.snapshot('c1', 10);
    return result;
  };
  r.ops.cardsOf = async () => [card('event')];
  r.state.patch('c1', { approvals: [{ id: 'event' }] });
  await waitFor(() => q.events('cards.changed').length > 0 && !r.service.chains.has('c1'), 'latest cards delivered to both phones');
  for (const [phone, initial] of [
    [p, initialA],
    [q, initialB],
  ] as const) {
    const shown = phone.inbox.filter((e: any) => ['session.patch', 'cards.changed'].includes(e.ev)).reduce(update, initial);
    assert.deepEqual(
      (shown.session.cards as any[]).map((c: any) => c.id),
      ['snapshot'],
    );
  }
  assert.equal(r.service.ledger.revOf('c1', 'event'), undefined);
  assert.equal(r.service.ledger.revOf('c1', 'snapshot'), 1);
  r.service.detach();
});

test('every current phone receives the latest card when a second follow shares the gated read in either order', async () => {
  for (const firstReader of ['event', 'snapshot']) {
    const { r, p } = await followed();
    const initialA = threadSnapshot(await r.service.snapshot('c1', 10));
    const q = r.phone('p2');
    const gate = deferred();
    let entered = false;
    r.ops.cardsOf = () => {
      entered = true;
      return gate.promise;
    };
    let openB: Promise<any>;
    if (firstReader === 'snapshot') {
      openB = q.ask('chat.follow', { chatId: 'c1' });
      await waitFor(() => entered, 'snapshot starts gated read');
    }
    r.state.patch('c1', { approvals: [{ id: 'new' }], turn: 'awaitingUser' });
    await waitFor(() => entered, 'card read pending');
    if (firstReader === 'event') openB = q.ask('chat.follow', { chatId: 'c1' });
    await waitFor(() => r.service.phones.get('p2').client.follows.has('c1'), 'second phone subscribed');
    gate.resolve([card('new')]);
    const replyB = await openB!;
    await waitFor(() => q.inbox.some((m: any) => m.inReplyTo === replyB?.inReplyTo), 'snapshot reply');
    assert.equal(replyB.ok, true);
    await waitFor(() => p.events('cards.changed').length > 0, 'first phone receives card', { timeoutMs: 250 });
    await waitFor(() => !r.service.chains.has('c1'), 'all ready cards delivered');
    const a = p.inbox.filter((e: any) => ['session.patch', 'cards.changed'].includes(e.ev)).reduce(update, initialA);
    const b = q.inbox.filter((e: any) => ['session.patch', 'cards.changed'].includes(e.ev)).reduce(update, threadSnapshot(replyB.result));
    assert.equal(a.session.turn, 'awaitingUser');
    assert.equal(b.session.turn, 'awaitingUser');
    assert.deepEqual(
      (a.session.cards as any[]).map((c: any) => c.id),
      ['new'],
    );
    assert.deepEqual(
      (b.session.cards as any[]).map((c: any) => c.id),
      ['new'],
    );
    r.service.detach();
  }
});

test('card changes during an open retry at most twice, with no refresh instruction', async () => {
  const { r } = await followed();
  let reads = 0;
  r.ops.cardsOf = async () => {
    reads++;
    r.service.cardUpdates.retire('c1');
    return [];
  };
  await assert.rejects(r.service.snapshot('c1', 10), (error: any) => {
    assert.equal(error.code, 'stale');
    assert.match(error.message, /Try opening it again/);
    assert.doesNotMatch(error.message, /refresh/i);
    return true;
  });
  assert.equal(reads, 3);
  r.ops.cardsOf = async () => [card('recovered')];
  assert.equal((await r.service.snapshot('c1', 10)).session.cards[0].id, 'recovered');
  r.service.detach();
});

test('detaching clears retained owners and a retired queued load throws without reading or placing undefined', async () => {
  const { r, p } = await followed();
  let reads = 0;
  r.ops.cardsOf = async () => {
    reads++;
    return [];
  };
  const old = r.service.snapshot('c1', 10);
  const refused = assert.rejects(old, (error: any) => {
    assert.equal(error.code, 'stale');
    assert.doesNotMatch(error.message, /undefined|iterable|refresh/i);
    return true;
  });
  assert.equal(r.service.cardUpdates.owners.size, 1);
  r.service.attach(r.link.mac);
  assert.equal(r.service.cardUpdates.owners.size, 0);
  await refused;
  assert.equal(reads, 0, 'queued old load never starts on replacement transport');
  r.ops.cardsOf = async () => [card('replacement')];
  assert.equal((await p.ask('chat.follow', { chatId: 'c1' })).result.session.cards[0].id, 'replacement');
  r.service.detach();
});

test('completed loads still recheck the owner before a foreground or background consumer applies them', async () => {
  const { r, p } = await followed();
  const updates = r.service.cardUpdates;
  const load = updates.load.bind(updates);
  let retireNext = true;
  let reads = 0;
  r.ops.cardsOf = async () => {
    reads++;
    return [card('current')];
  };
  updates.load = async (chatId: string, owner: any) => {
    const result = await load(chatId, owner);
    if (retireNext) {
      retireNext = false;
      updates.retire(chatId);
    }
    return result;
  };
  assert.equal((await r.service.cardsFor('c1', 0))[0].id, 'current');
  assert.equal(reads, 2, 'one retry when ownership changes after load fulfilled');
  retireNext = true;
  r.state.patch('c1', { approvals: [{ id: 'obsolete' }] });
  await waitFor(() => reads === 3, 'background fulfilled');
  await settle();
  assert.equal(p.events('cards.changed').length, 0);
  r.service.detach();
});

test('direct card reads without a session retain their explicit revision and do not publish without recipients', async () => {
  const r = rig();
  r.ops.state = { get: () => undefined };
  for (const detached of [false, true]) {
    if (detached) r.service.detach();
    r.ops.cardsOf = async () => [card('one')];
    assert.equal((await r.service.cardsFor('gone', 12))[0].rev, 12);
    r.ops.cardsOf = async () => [card('two')];
    assert.equal((await r.service.cardsFor('gone', 12))[0].rev, 12);
  }
});
