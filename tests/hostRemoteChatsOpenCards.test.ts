// The live Host turn and its pending approvals survive reopening the app or chat (#4542).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, createRemoteChats, end, ev, fakeHost, start, text, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { ControllerEvents } = require('../electron/session/controllerEvents.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

const permission = (requestId: string) => ev({ kind: 'permission', requestId, turnId: 't1' });
const question = (id: string) =>
  ev({ kind: 'question', turnId: 't1', question: { id, kind: 'question', status: 'pending', message: 'which?', form: {}, error: null } });
const gone = (requestId: string) => ev({ kind: 'permissionCancelled', requestId });

/** The transcript of an app that closed while the turn ran: the turn's start at revision 1 and a later record at 4, with the cards in between. */
function reopened(log: { rev: number; item: any }[], { tail = true }: { tail?: boolean } = {}) {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1', content: [] }, hostRev: 1, hostGen: 'g1' },
    { t: 'update', turnId: 't1', hostRev: 4, hostGen: 'g1' },
  ];
  const host = fakeHost();
  const rev = log.at(-1)!.rev;
  // a Host that keeps its tail answers the revisions after the one asked; one that does not answers with the whole log
  host.subscribe = async (chatId: string, from?: number, gen?: string) => (
    host.asked.push([chatId, from, gen]),
    tail
      ? {
          snapshot: { rev },
          generation: 'g1',
          inflight: [],
          patches: log.filter((p) => p.rev > (from ?? 0)).map((p) => ({ chatId, rev: p.rev, patch: { item: p.item } })),
        }
      : { snapshot: { rev, items: log.map((p) => p.item) }, patches: null, generation: 'g1', inflight: [] }
  );
  const opened: any[] = [];
  const w = world(host, items);
  // the same wiring, with the form cards' sink watched
  const emitted = w.emitted;
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    questions: () => ({ openRemote: (o: any) => opened.push(o.view.id), closeRemote: () => undefined }),
    now: () => 1000,
    report: (e: Error) => w.reported.push(e),
  });
  return { w: { ...w, chats }, host, items, opened };
}
const cards = (w: { emitted: any[] }) => w.emitted.filter((e) => e.kind === 'permission').map((e) => e.requestId);

test('a card the running turn waits on is drawn again, and answered, after the app restarts past it (#4542)', async () => {
  const { w, host, opened } = reopened([
    { rev: 1, item: start() },
    { rev: 2, item: permission('p1') },
    { rev: 3, item: question('q1') },
    { rev: 4, item: text('after the cards') },
  ]);
  const answers: any[] = [];
  host.answer = async (p: any) => (answers.push(p), { answered: true });
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  // asked from before the turn began, in the numbering the records were counted in
  assert.deepEqual(host.asked, [[CHAT, 0, 'g1']]);
  assert.deepEqual(cards(w), [`${CHAT}|p1`]);
  assert.deepEqual(opened, [`${CHAT}|q1`]);
  assert.equal(await w.chats.answer(`${CHAT}|p1`, 'allow'), true);
  assert.deepEqual(answers, [{ chatId: CHAT, requestId: 'p1', optionId: 'allow' }]);
  // what the transcript has already is not written or shown again
  assert.equal(w.emitted.filter((e) => e.kind === 'turnStart' && e.turnId === 't1').length, 1, 'the announced running turn only');
  assert.equal(w.items.records.filter((r) => r.hostRev === 4).length, 1);
});

test('only the cards still open come back: an answered one, a closed question and a repeated replay show nothing more', async () => {
  const { w, opened } = reopened(
    [
      { rev: 1, item: start() },
      { rev: 2, item: permission('p1') },
      { rev: 3, item: gone('p1') },
      { rev: 4, item: permission('p2') },
      { rev: 5, item: question('q1') },
      { rev: 6, item: gone('q1') },
    ],
    { tail: false },
  );
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(cards(w), [`${CHAT}|p2`]);
  assert.deepEqual(opened, [], 'the question closed at revision 6 is not opened again');
  // a card closed before the resume point leaves no "closed" line a second time; the one closed after it (the Host told it now) does, once
  assert.deepEqual(
    w.emitted.filter((e) => e.kind === 'permissionCancelled').map((e) => e.requestId),
    [`${CHAT}|q1`],
  );
});

test('a turn that ended, or none at all, is resumed from the transcript as before and shows no old card', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1', content: [] }, hostRev: 1, hostGen: 'g1' },
    { t: 'end', turnId: 't1', hostRev: 4, hostGen: 'g1' },
  ];
  const host = fakeHost();
  host.reply = {
    snapshot: { rev: 5 },
    generation: 'g1',
    inflight: [],
    patches: [{ chatId: CHAT, rev: 5, patch: { item: text('later') } }],
  };
  const w = world(host, items);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(host.asked, [[CHAT, 4, 'g1']]);
  assert.deepEqual(cards(w), []);
  // a running turn whose start the transcript holds without a revision (an older record) resumes from where it stood
  const old = new FakeItems();
  old.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1', content: [] } },
    { t: 'update', turnId: 't1', hostRev: 4, hostGen: 'g1' },
  ];
  const again = world(fakeHost(), old);
  again.host.reply = { snapshot: { rev: 4 }, generation: 'g1', inflight: [], patches: [] };
  again.chats.follow(CHAT);
  await again.chats.settled(CHAT);
  assert.deepEqual(again.host.asked, [[CHAT, 4, 'g1']]);
});

test('a card told before any window opened the chat waits in its session state: the controller drops what no state is there to hold (#4542)', async () => {
  const host = fakeHost();
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1', content: [] }, hostRev: 1, hostGen: 'g1' },
    { t: 'update', turnId: 't1', hostRev: 2, hostGen: 'g1' },
  ];
  host.reply = {
    snapshot: { rev: 3 },
    generation: 'g1',
    inflight: [],
    patches: [{ chatId: CHAT, rev: 3, patch: { item: permission('p1') } }],
  };
  // main's session store, and the controller's rule: an event for a chat the store does not have yet is dropped
  const known = new Set<string>();
  const held: string[] = [];
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: any) => e.kind === 'permission' && known.has(CHAT) && held.push(e.requestId),
    state: () => ({ has: (id: string) => known.has(id), get: (id: string) => known.add(id), patch: () => true }),
    now: () => 1000,
    report: () => undefined,
  });
  chats.follow(CHAT);
  await chats.settled(CHAT);
  assert.deepEqual(held, [`${CHAT}|p1`]);
});

test('a live or restored Host turn starts in main even when no window has initialized that chat', async () => {
  for (const source of ['live', 'restored', 'snapshot', 'history']) {
    const host = fakeHost();
    const items = new FakeItems();
    if (source === 'restored') {
      items.records = [{ t: 'user', turnId: 't1', user: { id: 'u1', content: [] }, hostRev: 1, hostGen: 'g1' }];
      host.reply = { snapshot: { rev: 1 }, patches: [], generation: 'g1', inflight: [] };
    }
    if (source === 'snapshot' || source === 'history') {
      const events = source === 'snapshot' ? [start('old'), end('old'), start()] : [start(), end()];
      host.reply = { snapshot: { rev: events.length, items: events }, patches: null, generation: 'g1', inflight: [] };
    }
    const state = new SessionStore();
    const runtime = {};
    const controller = {
      state,
      rt: () => runtime,
      chatOf: (key: string) => key,
      learnSavedName: () => undefined,
      rememberName: () => undefined,
      isCurrentSource: (_chat: string, source: { key: string }) => source.key === CHAT,
      end: () => assert.fail('completed history is not a live turn'),
    };
    const chats = createRemoteChats({
      items,
      hostFor: () => host,
      ownerOf: () => ({ hostId: 'box', folder: '/srv/work' }),
      emit: (e: object) => ControllerEvents.prototype.onAcpEvent.call(controller, e),
      state: () => state,
    });
    assert.equal(state.has(CHAT), false);
    chats.follow(CHAT);
    await chats.settled(CHAT);
    if (source === 'live') {
      assert.equal(state.has(CHAT), false, 'idle followed chats do not need live session state');
      host.fire.frame(CHAT, { t: 'state', patch: { promptSuggestion: null } });
      await chats.settled(CHAT);
      assert.equal(state.has(CHAT), false, 'withdrawing an absent offer does not create session state');
      host.fire.patch(CHAT, 1, start());
      await chats.settled(CHAT);
    }
    if (source === 'history') assert.equal(state.has(CHAT), false);
    else assert.equal(state.get(CHAT).activeTurn?.id, 't1');
    chats.dispose();
  }
});
