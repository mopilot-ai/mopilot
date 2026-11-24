// The chat list and its events through the real protocol with MoMo's real chat rules and the real approvals engine (#5576): attention in the shape the Host publishes, a count per connection that shows nothing of a chat the caller may not see, a chat that becomes hidden or visible mid-session, an owner that moved, and chats of every family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { world } from './support/host/momoVeilKit.ts';

const GRANTED = { fingerprint: 'f', kind: 'desktop' };
const STRANGER = null;
const events = (out: any[]) => out.filter((m) => m.event === 'chats');

test('attention shows from a real card, MoMo’s chat never reaches a caller that may not see it, and that caller’s count has no gap', async (t) => {
  const w = await world(t);
  const granted = await w.connect(GRANTED);
  const stranger = await w.connect(STRANGER);
  const other = `claude:${crypto.randomUUID()}`;
  await granted.conn.call('host.chats.watch', {});
  const watching = await stranger.conn.call('host.chats.watch', {});
  assert.equal(watching.at, 0);
  w.card(w.M);
  w.card(other, 'r9');
  const seen = events(stranger.out);
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((e) => e.chatId === other),
    'nothing of the MoMo chat',
  );
  assert.deepEqual(
    seen.map((e) => e.seq),
    seen.map((_, i) => i + 1),
    'the count moved only with what this connection was told',
  );
  assert.ok(
    seen.some((e) => e.kind === 'attention' && e.chat.state === 'attention'),
    'a card waiting is attention (the Host publishes it as an object)',
  );
  const mine = events(granted.out);
  assert.ok(
    mine.some((e) => e.chatId === w.M),
    'a caller that may see it is told',
  );
  assert.ok(mine.length > seen.length);
  // a list of each: the stranger's has no MoMo row and its count is its own; the granted one has both
  const listed = await stranger.conn.call('host.chats', { limit: 20 });
  assert.deepEqual(
    listed.chats.map((c: any) => c.chatId),
    [other],
  );
  assert.equal(listed.at, seen.length);
  assert.equal(listed.chats[0].state, 'attention');
  const all = await granted.conn.call('host.chats', { limit: 20 });
  assert.deepEqual(all.chats.map((c: any) => c.chatId).sort(), [other, w.M].sort());
  // the card answered or the chat stopped: the row says so
  w.host.emit('event', { kind: 'turnEnd', key: other, turnId: 't1', stopReason: 'cancelled' });
  assert.ok(events(stranger.out).some((e) => e.chatId === other && e.kind === 'turnEnded'));
  assert.doesNotMatch(JSON.stringify(stranger.out), new RegExp(w.M));
});

test('a chat that becomes hidden or visible mid-session follows the caller’s grant in the list and in what it is told, and its removal is not told to one that may not see it', async (t) => {
  const w = await world(t);
  const granted = await w.connect(GRANTED);
  const stranger = await w.connect(STRANGER);
  await granted.conn.call('host.chats.watch', {});
  await stranger.conn.call('host.chats.watch', {});
  w.card(w.M);
  assert.ok((await granted.conn.call('host.chats', { limit: 5 })).chats.some((c: any) => c.chatId === w.M));
  // an ordinary chat's removal is told to both, with no gap in either count; MoMo's own is never told to the stranger
  const plain = `claude:${crypto.randomUUID()}`;
  w.card(plain, 'r5');
  await granted.conn.call('chat.remove', { chatId: plain, epoch: 0, key: 'rm-key-0001' });
  for (const side of [granted, stranger]) {
    const seen = events(side.out).filter((e) => e.chatId === plain);
    assert.equal(seen.at(-1).op, 'remove');
    assert.deepEqual(
      events(side.out).map((e) => e.seq),
      events(side.out).map((_, i) => i + 1),
    );
  }
  assert.ok(events(stranger.out).every((e) => e.chatId !== w.M));
  // the grant ends: the list drops MoMo's chat and nothing more is told of it
  await w.home.grant({ account: 'a1', features: [] }).catch(() => undefined);
  assert.ok(!(await granted.conn.call('host.chats', { limit: 5 })).chats.some((c: any) => c.chatId === w.M));
  const told = events(granted.out).length;
  w.card(w.M, 'r2');
  assert.equal(events(granted.out).length, told, 'nothing more is told once the grant ended');
  assert.ok(events(stranger.out).every((e) => e.chatId !== w.M));
});

test('an owner that moves another client’s chat changes the row’s epoch for every watcher, and a list names chats of every family', async (t) => {
  const w = await world(t);
  const granted = await w.connect(GRANTED);
  const ids = [`claude:${crypto.randomUUID()}`, 'acp:kimi:abc', '01980000-aaaa-7bbb-8ccc-0123456789ab'];
  for (const id of ids) w.card(id, `r-${id.length}`);
  await granted.conn.call('host.chats.watch', {});
  const list = await granted.conn.call('host.chats', { limit: 20 });
  const row = (id: string) => list.chats.find((c: any) => c.chatId === id);
  assert.deepEqual(
    ids.map((id) => row(id)?.harness),
    ['claude', 'acp:kimi', 'codex'],
    'each family’s chat is listed with the agent it starts on',
  );
  w.epochs.admit(ids[1], 7);
  const moved = events(granted.out).find((e) => e.chatId === ids[1]);
  assert.deepEqual([moved?.kind, moved?.chat.epoch], ['changed', 7]);
  assert.ok(moved.rev > row(ids[1]).rev, 'a newer revision, so an older buffered event cannot undo it');
});
