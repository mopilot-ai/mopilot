// The Mac's mirror of a chat on a machine (electron/host/remoteChats.cjs) after a turn's start told once its end was: it opens nothing, so the chat does not stay running with no end to come. The sequence J8 produced was 4 starts and 3 ends; an older Host's journal holds such turns too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, FakeItems, createRemoteChats, end, fakeHost, start, text, tick } from './support/host/remoteChatsKit.ts';

function mirror() {
  const host = fakeHost();
  const emitted: any[] = [];
  const records = new FakeItems();
  const chats = createRemoteChats({
    items: records,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    now: () => 1000,
    report: () => undefined,
  });
  return { host, emitted, records, chats };
}
const kinds = (emitted: any[]) => emitted.filter((e) => e.kind === 'turnStart' || e.kind === 'turnEnd').map((e) => `${e.kind}:${e.turnId}`);

test('W: a start told after its turn ended opens nothing, whether it comes live or in a snapshot', async () => {
  const live = mirror();
  live.chats.follow(CHAT);
  await live.chats.settled(CHAT);
  live.host.fire.patch(CHAT, 1, start('t1'));
  live.host.fire.patch(CHAT, 2, text('done'));
  live.host.fire.patch(CHAT, 3, end('t1'));
  // the order J8 saw: the same turn started again after its end
  live.host.fire.patch(CHAT, 4, start('t1'));
  await tick();
  await live.chats.settled(CHAT);
  assert.deepEqual(kinds(live.emitted), ['turnStart:t1', 'turnEnd:t1']);

  // a journal an older Host wrote with that order is read the same way
  const old = mirror();
  old.host.reply = {
    snapshot: {
      rev: 4,
      items: [
        { t: 'event', family: 'codex', event: start('t1').event },
        { t: 'event', family: 'codex', event: text('done').event },
        { t: 'event', family: 'codex', event: end('t1').event },
        { t: 'event', family: 'codex', event: start('t1').event },
      ],
    },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  old.chats.follow(CHAT);
  await old.chats.settled(CHAT);
  assert.deepEqual(kinds(old.emitted), ['turnStart:t1', 'turnEnd:t1']);
});

test('B: the turns remembered as ended are bounded: a start told for one long past opens again, one for a recent turn does not', async () => {
  const m = mirror();
  m.chats.follow(CHAT);
  await m.chats.settled(CHAT);
  let rev = 0;
  for (let i = 0; i < 205; i++) {
    m.host.fire.patch(CHAT, ++rev, start(`t${i}`));
    m.host.fire.patch(CHAT, ++rev, end(`t${i}`));
  }
  await tick();
  const before = kinds(m.emitted).length;
  assert.equal(before, 410, 'every turn was told once');
  // the newest turn's end is remembered: its start told again opens nothing
  m.host.fire.patch(CHAT, ++rev, start('t204'));
  await tick();
  assert.equal(kinds(m.emitted).length, before);
  // the oldest was let go to keep the set small: the mirror cannot tell its start is late
  m.host.fire.patch(CHAT, ++rev, start('t0'));
  await tick();
  assert.equal(kinds(m.emitted).length, before + 1);
});

test('B: a later turn is unaffected, and a new numbering from the Host forgets which turns ended', async () => {
  const m = mirror();
  m.chats.follow(CHAT);
  await m.chats.settled(CHAT);
  m.host.fire.patch(CHAT, 1, start('t1'));
  m.host.fire.patch(CHAT, 2, end('t1'));
  m.host.fire.patch(CHAT, 3, start('t2'));
  m.host.fire.patch(CHAT, 4, end('t2'));
  await tick();
  assert.deepEqual(kinds(m.emitted), ['turnStart:t1', 'turnEnd:t1', 'turnStart:t2', 'turnEnd:t2']);
  // the Host numbers its journal afresh (its data was reset): its turn ids start again
  m.host.fire.resync(
    CHAT,
    {
      rev: 2,
      items: [
        { t: 'event', family: 'codex', event: start('t1').event },
        { t: 'event', family: 'codex', event: end('t1').event },
      ],
    },
    'g2',
  );
  await tick();
  await m.chats.settled(CHAT);
  assert.deepEqual(kinds(m.emitted).slice(4), ['turnStart:t1', 'turnEnd:t1']);
});
