// What the Mac tells the relay for a phone's Live Activity: counts and kinds from the session store on any harness, sent once per burst and only when changed, sealed titles only when the push titles switch gives them, a closing empty snapshot, a periodic repeat, and nothing while Mobile Remote is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';
import { tick } from './support/async-scenarios.ts';
import { rig } from './support/remoteActivityRig.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createActivityBridge, DELAY_MS, HEARTBEAT_MS } = require('../electron/remote/activityBridge.cjs');
const { chatRef } = require('../shared/remote/ref.mjs');
const { RelayClient } = require('../electron/remote/relayClient.cjs');
const { openRemote } = require('../electron/remote/runtime.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');
const { parseSnapshot } = require('../relay/src/activity.mjs');

test('nothing busy and nothing shown means nothing is sent', async () => {
  const r = rig();
  r.chat('c1', 'idle');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.deepEqual(r.sent, []);
});

test('a chat that starts running is sent to each paired phone once, with that pair’s opaque handle and no title', async () => {
  const r = rig();
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.deepEqual(
    r.sent.map((s) => s.pair),
    ['p_one', 'p_two'],
  );
  const state = r.sent[0].state;
  assert.deepEqual(
    { ...state, at: 0 },
    {
      needs: 0,
      running: 1,
      kind: 'running',
      since: 1_900_000_000,
      at: 0,
      rows: [{ kind: 'running', since: 1_900_000_000, ref: chatRef('p_one', 'c1') }],
    },
  );
  assert.equal(r.sent[1].state.rows[0].ref, chatRef('p_two', 'c1'));
  assert.notEqual(r.sent[0].state.rows[0].ref, r.sent[1].state.rows[0].ref);
  assert.ok(!JSON.stringify(r.sent).includes('c1'));
});

test('a burst of changes is one message, and an unchanged snapshot is not sent again', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  r.bridge.changed();
  r.bridge.changed();
  assert.equal(r.timers.size, 1);
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 1);
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 1);
  // a second chat is a change
  r.chat('c2', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].state.running, 2);
});

test('a chat waiting for the user counts as "needs you" and leads the rows; the newest event names the kind; the start stays with the chat', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('a', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.advance(60_000);
  r.chat('b', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.advance(60_000);
  r.chat('a', 'awaitingUser');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const s = r.sent.at(-1).state;
  assert.deepEqual([s.needs, s.running, s.kind], [1, 1, 'needs']);
  assert.equal(s.since, 1_900_000_000);
  assert.deepEqual(
    s.rows.map((row: any) => [row.kind, row.since]),
    [
      ['needs', 1_900_000_000],
      ['running', 1_900_000_060],
    ],
  );
  assert.equal(s.at, 1_900_000_120);
  // the user answers: back to running, not a new start
  r.chat('a', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.at(-1).state.kind, 'running');
  assert.equal(r.sent.at(-1).state.since, 1_900_000_000);
});

test('only the three most urgent chats get rows, MoMo’s and unknown chats are left out, and the counts still cover every chat', async () => {
  const r = rig({ pairs: ['p_one'] });
  for (const id of ['r1', 'r2', 'r3']) r.chat(id, 'running');
  r.chat('n1', 'awaitingUser');
  r.chat('momo', 'running', false);
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const s = r.sent[0].state;
  assert.deepEqual([s.needs, s.running], [1, 3]);
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[0].kind, 'needs');
});

test('a title travels only sealed, only for a chat with a title, and only when the push titles switch seals it', async () => {
  const off = rig({ pairs: ['p_one'], titles: { c1: 'Clean up generated files' } });
  off.chat('c1', 'running');
  off.bridge.changed();
  await off.fire(DELAY_MS);
  assert.equal('st' in off.sent[0].state.rows[0], false);
  const on = rig({ pairs: ['p_one'], seal: true, titles: { c1: 'Clean up generated files' } });
  on.chat('c1', 'running');
  on.chat('c2', 'running');
  on.bridge.changed();
  await on.fire(DELAY_MS);
  const [first, second] = on.sent[0].state.rows;
  assert.equal(first.st, `S(p_one,${first.ref},Clean up generated files)`);
  assert.equal('st' in second, false);
  assert.ok(!JSON.stringify(on.sent).replace(first.st, '').includes('Clean up'));
});

test('when the last busy chat ends one empty snapshot closes the activity, with the finished kind, and then nothing more', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.advance(30_000);
  r.end('c1');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const last = r.sent.at(-1).state;
  assert.deepEqual({ ...last, at: 0 }, { needs: 0, running: 0, kind: 'done', since: 0, at: 0, rows: [] });
  assert.equal(last.at, 1_900_000_030);
  const count = r.sent.length;
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, count);
  // busy again after the end is sent again
  r.chat('c2', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, count + 1);
});

test('a send the relay failed or refused is tried again with the next change; one it could not hold for lack of a token is not', async () => {
  let status = 'failed';
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.setRemote({ ...rigRemote(r), activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve(status)) });
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 1);
  status = 'no_token';
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
});

function rigRemote(r: any) {
  return { devices: { list: () => [{ pairId: 'p_one' }] }, pushTitles: null, sent: r.sent };
}

test('a relay that rejects is noted and does not stop the next send', async () => {
  const r = rig({ pairs: ['p_one'], reject: true });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  await tick();
  assert.ok(recentIgnored().some((e: any) => /Live Activity update/.test(e.context)));
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
});

test('nothing is sent while Mobile Remote is off or has no devices', async () => {
  const r = rig();
  r.chat('c1', 'running');
  r.setRemote(null);
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.setRemote({ devices: null });
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.deepEqual(r.sent, []);
});

test('while chats are busy the snapshot is repeated now and then, and the repeat stops with the last busy chat', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 1);
  await r.fire(HEARTBEAT_MS);
  assert.equal(r.sent.length, 2);
  // the next repeat is scheduled again
  assert.ok([...r.timers.values()].some((t) => t.ms === HEARTBEAT_MS));
  r.end('c1');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.ok(![...r.timers.values()].some((t) => t.ms === HEARTBEAT_MS));
});

test('a new relay connection sends everything again at once, and stopping forgets what was told and cancels the timers', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.bridge.changed();
  r.bridge.resend();
  assert.equal(r.timers.size, 1);
  assert.equal(r.sent.length, 2);
  r.bridge.changed();
  r.bridge.reset();
  assert.equal(r.timers.size, 0);
  r.bridge.reset();
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 3);
});

test('the default timers fire and can be cancelled', async () => {
  const live: any = {
    devices: { list: () => [{ pairId: 'p_one' }] },
    activityUpdate: async (req: any) => (sent.push(req), 'sent'),
  };
  const sent: any[] = [];
  const bridge = createActivityBridge({
    state: { all: () => ['c1'], get: () => ({ turn: 'running' }) },
    owns: () => true,
    titleOf: () => null,
    remote: () => live,
  });
  bridge.changed();
  bridge.reset();
  bridge.resend();
  assert.equal(sent.length, 1);
  bridge.reset();
});

test('RelayClient.activityUpdate sends {t:"activity"} and resolves with the relay’s status', async () => {
  const sockets: FakeSocket[] = [];
  const client = new RelayClient({
    url: () => 'wss://x',
    getToken: async () => 'jwt',
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    random: () => 1,
  });
  client.start();
  await tick();
  sockets[0].hello();
  const state = { needs: 1, running: 0, kind: 'needs', since: 5, at: 6, rows: [] };
  const answer = client.activityUpdate({ pair: 'p_abcdefgh', state });
  const sent = sockets[0].sentOf('activity')[0];
  assert.deepEqual({ ...sent, rid: undefined }, { t: 'activity', pair: 'p_abcdefgh', state, rid: undefined });
  sockets[0].recv({ t: 'push.result', pair: 'p_abcdefgh', status: 'sent', rid: sent.rid });
  assert.equal(await answer, 'sent');
  client.stop();
});

/** A running remote with one paired phone, over a session store whose publish the test calls. */
async function bootRemote(extra: Record<string, unknown>) {
  const sockets: FakeSocket[] = [];
  const published: any[] = [];
  const turns = new Map<string, string>();
  const store: any = {
    all: () => [...turns.keys()],
    get: (id: string) => ({ turn: turns.get(id) }),
    publish: (p: any) => void published.push(p),
  };
  const records = new Map([['c1', { meta: {} }]]);
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: async () => 'jwt' }, controller: { state: store }, chats: { records }, ...extra },
    flagOn: () => true,
    safeStorage: fakeSafe(),
    fs,
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    relayUrl: 'wss://x',
  });
  await remote.sync();
  await waitFor(() => sockets.length, 'a socket');
  sockets[0].hello();
  // a paired phone as the channel reads it (its two ratchets)
  const ratchet = () => ({ chain: '11'.repeat(32), ctr: 0 });
  await remote.devices.add({ id: 'phone-1', name: 'iPhone', pairId: 'p_abcdefgh', tx: ratchet(), rx: ratchet() });
  const nextActivity = () =>
    new Promise<any>((resolve) => {
      const look = () => {
        const m = sockets[0].sentOf('activity')[0];
        return m ? resolve(m) : setTimeout(look, 20);
      };
      look();
    });
  return { remote, sockets, store, published, turns, nextActivity };
}

test('the remote runtime sends a snapshot when a chat’s turn changes, forwards it while on and rejects while off', async () => {
  const r = await bootRemote({ codex: { chatName: () => 'A title' } });
  // the store's own publish still runs, and a patch without a turn is not a reason to send
  r.store.publish({ chatId: 'c1', rev: 1, patch: { title: 'x' } });
  r.store.publish({ chatId: 'c1', rev: 2 });
  assert.equal(r.published.length, 2);
  r.turns.set('c1', 'running');
  r.store.publish({ chatId: 'c1', rev: 3, patch: { turn: 'running' } });
  const real = await r.nextActivity();
  assert.equal(real.pair, 'p_abcdefgh');
  assert.equal(real.state.running, 1);
  assert.equal(real.state.rows[0].ref, chatRef('p_abcdefgh', 'c1'));
  const direct = r.remote.activityUpdate({ pair: 'p_abcdefgh', state: real.state });
  r.sockets[0].recv({ t: 'push.result', status: 'sent', rid: r.sockets[0].sentOf('activity').at(-1).rid });
  assert.equal(await direct, 'sent');
  // a pair that has just joined is told what the Mac is doing
  r.sockets[0].recv({ t: 'event', ev: 'pair.joined', pair: 'p_abcdefgh' });
  r.remote.close();
  await assert.rejects(r.remote.activityUpdate({ pair: 'p', state: {} }), /off/);
});

test('without a chat-name source the runtime still reports the chat, with no title to seal', async () => {
  const r = await bootRemote({});
  r.turns.set('c1', 'awaitingUser');
  r.store.publish({ chatId: 'c1', rev: 1, patch: { turn: 'awaitingUser' } });
  const sent = await r.nextActivity();
  assert.deepEqual([sent.state.needs, sent.state.running], [1, 0]);
  assert.equal('st' in sent.state.rows[0], false);
  r.remote.close();
});

test('everything the bridge sends is accepted by the relay as it is, sealed titles included, and nothing is dropped', async () => {
  const sealed = Buffer.alloc(80, 7).toString('base64url');
  const r = rig({ pairs: ['p_abcdefgh'], titles: { a: 'One', b: 'Two' } });
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_abcdefgh' }] },
    pushTitles: { seal: () => sealed },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  });
  r.chat('a', 'awaitingUser');
  r.chat('b', 'running');
  r.chat('c', 'running');
  r.chat('d', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const wire = JSON.parse(JSON.stringify(r.sent[0].state));
  const parsed = parseSnapshot(wire);
  assert.ok(parsed);
  assert.deepEqual(parsed, wire);
  assert.equal(parsed.rows[0].st, sealed);
  // the closing snapshot too
  for (const id of ['a', 'b', 'c', 'd']) r.end(id);
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const closing = JSON.parse(JSON.stringify(r.sent.at(-1).state));
  assert.deepEqual(parseSnapshot(closing), closing);
});
