// Follow ownership spans ordinary and MoMo reads: equivalent opens share data; obsolete cleanup cannot retire replacements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';
import { waitFor } from './support/waitFor.ts';
import { deferred, card, followed } from './support/card-update-kit.ts';

test('obsolete failed follow never deletes a newer ordinary or MoMo subscription', async () => {
  for (const momo of [false, true]) {
    for (const rejects of [false, true]) {
      const r = rig({ momo });
      r.service.momo = () => ({ mainChatId: async () => 'c1' });
      const client = r.service.phones.get('p1').client;
      const method = momo ? 'momo.chat.follow' : 'chat.follow';
      const unfollow = momo ? 'momo.chat.unfollow' : 'chat.unfollow';
      const old = deferred();
      let started = false;
      r.ops.cardsOf = () => {
        started = true;
        return old.promise;
      };
      const first = r.service.call(client, method, { chatId: 'c1' });
      const refused = assert.rejects(first);
      await waitFor(() => started, 'old follow read');
      await r.service.call(client, unfollow, { chatId: 'c1' });
      r.ops.cardsOf = async () => [card('new')];
      await r.service.call(client, method, { chatId: 'c1' });
      rejects ? old.reject(new Error('old follow failed')) : old.resolve([card('old')]);
      await refused;
      assert.equal(client.follows.has('c1'), true);
      assert.equal(r.service.ledger.revOf('c1', 'old'), undefined);
      r.service.detach();
    }
  }
});

test('concurrent equivalent opens on two phones or the same phone both succeed with one card read', async () => {
  for (const samePhone of [false, true]) {
    const r = rig();
    const a = r.service.phones.get('p1').client;
    const b = r.service.phones.get(samePhone ? 'p1' : 'p2').client;
    const cards = deferred();
    let reads = 0;
    r.ops.cardsOf = () => {
      reads++;
      return cards.promise;
    };
    const first = r.service.call(a, 'chat.follow', { chatId: 'c1' });
    const second = r.service.call(b, 'chat.follow', { chatId: 'c1' });
    await waitFor(() => reads === 1, 'coalesced equivalent opens');
    cards.resolve([card('current')]);
    const results = await Promise.all([first, second]);
    assert.equal(results[0].session.cards[0].id, 'current');
    assert.equal(results[1].session.cards[0].id, 'current');
    assert.equal(a.follows.has('c1') && b.follows.has('c1'), true);
    assert.equal(reads, 1);
    r.ops.cardsOf = async () => [card('fresh')];
    assert.equal((await r.service.snapshot('c1', 10)).session.cards[0].id, 'fresh', 'completed reads are not cached');
    r.service.detach();
  }
});

test('in-process callers keep the public Set-based follow contract and existing followed chats', async () => {
  const r = rig({ momo: true });
  r.service.momo = () => ({ mainChatId: async () => 'c1' });
  for (const method of ['chat.follow', 'momo.chat.follow']) {
    const client: any = { kind: 'phone', pairId: 'in-process', follows: new Set(['c2']) };
    assert.equal((await r.service.call(client, method, { chatId: 'c1' })).chatId, 'c1');
    assert.equal(client.follows.has('c2'), true);
    client.follows.delete('c2');
    const active = r.service.phones.get('p1').client;
    active.follows.add('c1');
    client.follows.delete('c1');
    active.follows.delete('c1');
  }
  r.service.detach();
});

test('a follow whose cards finished still cannot reply after its rows wait across subscription retirement', async () => {
  const { r, p } = await followed();
  const rows = deferred();
  let reading = false;
  let cardsReady = false;
  const cardsFor = r.service.cardsFor.bind(r.service);
  r.service.cardsFor = async (...args: any[]) => {
    const cards = await cardsFor(...args);
    cardsReady = true;
    return cards;
  };
  r.ops.items = async () => {
    reading = true;
    return rows.promise;
  };
  const client = r.service.phones.get('p1').client;
  const old = r.service.call(client, 'chat.follow', { chatId: 'c1' });
  const refused = assert.rejects(old, /no longer open/);
  await waitFor(() => reading && cardsReady, 'rows waiting after cards');
  await p.ask('chat.unfollow', { chatId: 'c1' });
  r.ops.items = async () => ({ items: [], itemsShape: 'rows' });
  assert.equal((await p.ask('chat.follow', { chatId: 'c1' })).ok, true);
  rows.resolve({ items: [], itemsShape: 'rows' });
  await refused;
  assert.equal(client.follows.has('c1'), true);
  r.service.detach();
});

test('an older rows failure cannot delete a newer equivalent follow without an intervening unfollow', async () => {
  for (const momo of [false, true]) {
    const r = rig({ momo });
    r.service.momo = () => ({ mainChatId: async () => 'c1' });
    const client = r.service.phones.get('p1').client;
    const oldRows = deferred();
    let reading = false;
    r.ops.items = () => {
      reading = true;
      return oldRows.promise;
    };
    const method = momo ? 'momo.chat.follow' : 'chat.follow';
    const old = r.service.call(client, method, { chatId: 'c1' });
    const refused = assert.rejects(old, /old rows failed/);
    await waitFor(() => reading, 'old rows pending');
    r.ops.items = async () => ({ items: [], itemsShape: 'rows' });
    await r.service.call(client, method, { chatId: 'c1' });
    oldRows.reject(new Error('old rows failed'));
    await refused;
    assert.equal(client.follows.has('c1'), true);
    r.service.detach();
  }
});

test('a MoMo main-chat lookup cannot establish a follow after the requesting phone is removed', async () => {
  const r = rig({ momo: true });
  const main = deferred();
  r.service.momo = () => ({ mainChatId: () => main.promise });
  const client = r.service.phones.get('p1').client;
  const follow = r.service.call(client, 'momo.chat.follow', {});
  const refused = assert.rejects(follow, (error: any) => error.code === 'forbidden');
  r.link.removePair('p1');
  main.resolve('c1');
  await refused;
  assert.equal(client.follows.has('c1'), false);
  assert.equal(r.service.cardUpdates.owners.size, 0);
  r.service.detach();
});
