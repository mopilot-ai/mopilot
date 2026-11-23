// The app's continue state machine (electron/host/continue.cjs) over real Host modules and a net that loses requests and replies: the chat moves only when the source's commit succeeds (contract 2), and a failure at any step leaves it on its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, makeApp, makeHost, makeNet, req, scene } from './support/hostContinueKit.ts';

const code = (c: string) => (e: any) => e?.code === c;
const unknown = (code = 'timeout') => Object.assign(new Error('no answer'), { code });
const methods = (net: ReturnType<typeof makeNet>) => net.calls.map((c) => `${c.method.replace('chat.', '')}@${c.hostId}`);
const later = () => new Promise<void>((r) => setImmediate(r));
const staysOnA = (s: ReturnType<typeof scene>) => {
  const rec = s.app.ownership.get(CHAT);
  assert.deepEqual([rec.ownerHostId, rec.epoch], ['A', 0]);
  assert.equal(s.A.epochs.current(CHAT), 0);
  assert.equal(s.A.owners.get(CHAT), null);
};

test('a chat moves from A to B: prepare, commit by A, the map written after it, B told, A released', async () => {
  const s = scene();
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual(got, { hostId: 'B', epoch: 1, lostHost: false, activated: true, released: true });
  assert.deepEqual(methods(s.net), ['prepareContinue@B', 'commitContinue@A', 'subscribe@B', 'release@A']);
  assert.deepEqual(s.app.reopenMap().get(CHAT), { hostId: 'B', ownerHostId: 'B', epoch: 1, folder: '/work/b' });
  assert.equal(s.A.owners.get(CHAT)?.state, 'released');
  assert.deepEqual(s.A.log.retired, [CHAT]);
  assert.equal(s.B.log.served.length, 1);
  assert.equal(s.B.epochs.current(CHAT), 1);
  assert.equal(s.app.machine.status(CHAT), null);
});

test('and back, and over again: the epoch only grows and each side serves exactly when it owns', async () => {
  const s = scene();
  await s.app.machine.continueChat(req());
  const back = await s.app.machine.continueChat(req({ targetHostId: 'A', cwd: '/work/a' }));
  assert.deepEqual([back.hostId, back.epoch], ['A', 2]);
  assert.throws(() => s.B.host.gate(CHAT, 2), code('chat_released'));
  assert.ok(s.A.log.served.length === 1 && s.A.state.running.has(CHAT));
  const again = await s.app.machine.continueChat(req());
  assert.deepEqual([again.hostId, again.epoch], ['B', 3]);
  assert.throws(() => s.A.host.gate(CHAT, 2), code('chat_released'));
  assert.deepEqual(s.app.ownership.get(CHAT), { hostId: 'B', ownerHostId: 'B', epoch: 3, folder: '/work/b' });
});

test('refuses a continue to the host the chat is on, and to a host that is not online, before anything is asked of anyone', async () => {
  const s = scene();
  await assert.rejects(s.app.machine.continueChat(req({ targetHostId: 'A' })), code('same_host'));
  s.net.down.add('B');
  await assert.rejects(s.app.machine.continueChat(req()), code('target_offline'));
  assert.equal(s.net.calls.length, 0);
  staysOnA(s);
});

test('killing the tunnel at every step before the commit leaves the chat on its source', async () => {
  // the request never reaches the target
  let s = scene();
  s.net.lose({ method: 'chat.prepareContinue', when: 'before' });
  await assert.rejects(s.app.machine.continueChat(req()), code('host_unreachable'));
  staysOnA(s);
  assert.equal(s.B.owners.get(CHAT), null);
  // only its reply is lost: the target holds a preparation nobody will use, which its own sweep reclaims
  s = scene();
  s.net.lose({ method: 'chat.prepareContinue', when: 'after' });
  await assert.rejects(s.app.machine.continueChat(req()), code('host_unreachable'));
  staysOnA(s);
  assert.equal(s.B.owners.get(CHAT)?.state, 'prepared');
  s.B.state.now += 31 * 60_000;
  assert.equal(await s.B.host.sweep(), 1);
  // the commit never reaches the source: the target reclaims, nothing changed
  s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'before', times: 3 });
  await assert.rejects(s.app.machine.continueChat(req()), code('host_unreachable'));
  staysOnA(s);
  assert.equal(s.B.owners.get(CHAT), null);
  assert.equal(s.B.log.discarded.length, 1);
  assert.deepEqual(methods(s.net).slice(-1), ['release@B']);
});

test('B4: a refusal from the target or the source reaches the caller with its reason and leaves the chat where it was', async () => {
  let s = scene();
  s.B.state.notConfigured = true;
  await assert.rejects(s.app.machine.continueChat(req()), code('harness_not_configured'));
  await assert.rejects(s.app.machine.continueChat(req({ cwd: '/missing' })), code('directory_missing'));
  staysOnA(s);
  s = scene();
  s.A.state.busy = true;
  await assert.rejects(s.app.machine.continueChat(req()), code('turn_running'));
  staysOnA(s);
  assert.equal(s.B.owners.get(CHAT), null, 'the preparation is dropped');
  // stopping the turn and trying again works (A5)
  s.A.state.busy = false;
  assert.equal((await s.app.machine.continueChat(req())).epoch, 1);
});

test('a target that cannot be reached to reclaim its preparation is reported, and the refusal that caused it still reaches the caller', async () => {
  const s = scene();
  s.A.state.busy = true;
  s.net.lose({ hostId: 'B', method: 'chat.release', when: 'before' });
  await assert.rejects(s.app.machine.continueChat(req()), code('turn_running'));
  assert.ok(s.app.reports.some((r) => /did not reclaim a preparation/.test(r)));
  // its own timer reclaims it later
  assert.equal(s.B.owners.get(CHAT)?.state, 'prepared');
});

test('an answer that is not an error object is still reported as the cause', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'before', times: 3, error: 'timeout' });
  await assert.rejects(s.app.machine.continueChat(req()), (e: any) => e.code === 'commit_unsettled' && e.details.cause === 'timeout');
});

test('B2/B7: a commit whose reply is lost is asked again with the same preparation and gets the same answer', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'after', times: 2 });
  const got = await s.app.machine.continueChat(req());
  assert.equal(got.epoch, 1);
  const commits = s.net.calls.filter((c) => c.method === 'chat.commitContinue');
  assert.equal(commits.length, 3);
  assert.equal(new Set(commits.map((c) => c.params.preparedId)).size, 1);
  assert.equal(s.A.epochs.current(CHAT), 1, 'committed once');
  assert.equal(s.app.ownership.get(CHAT).epoch, 1);
});

test('a commit whose answer never comes is unsettled: the chat stays put, the preparation is kept, and the next continue settles it first', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'after', times: 3 });
  await assert.rejects(
    s.app.machine.continueChat(req()),
    (e: any) => e.code === 'commit_unsettled' && /host_unreachable|unreachable/.test(e.details.cause),
  );
  // the source did commit; the app has not heard
  assert.equal(s.A.owners.get(CHAT)?.state, 'released');
  assert.equal(s.app.ownership.get(CHAT).epoch, 0);
  assert.equal(s.B.owners.get(CHAT)?.state, 'prepared', 'not reclaimed: it is the chat now');
  const callsBefore = s.net.calls.length;
  const settled = await s.app.machine.continueChat(req());
  assert.deepEqual([settled.hostId, settled.epoch], ['B', 1]);
  assert.equal(
    s.net.calls.slice(callsBefore).some((c) => c.method === 'chat.prepareContinue'),
    false,
    'no second preparation',
  );
  assert.equal(s.B.log.opened.length, 1);
});

test('an unsettled move to one host and a new request for another: the first is settled, then the new one starts from where the chat is', async () => {
  const s = scene();
  (s.hosts as any).C = makeHost('C');
  s.net.lose({ method: 'chat.commitContinue', when: 'after', times: 3 });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  const got = await s.app.machine.continueChat(req({ targetHostId: 'C' }));
  assert.deepEqual([got.hostId, got.epoch], ['C', 2], 'B first (epoch 1), then C from B');
  assert.equal(s.B.owners.get(CHAT)?.state, 'released');
});

test('an unsettled move that the source then refuses is dropped, the target reclaimed, and the new continue runs', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'before', times: 3, error: unknown() });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  assert.equal(s.B.owners.get(CHAT)?.state, 'prepared');
  s.A.state.busy = true;
  await assert.rejects(s.app.machine.continueChat(req()), code('turn_running'));
  assert.equal(s.B.owners.get(CHAT), null);
  staysOnA(s);
  s.A.state.busy = false;
  assert.equal((await s.app.machine.continueChat(req())).epoch, 1);
});

test('an unsettled move whose source went elsewhere meanwhile: the map follows the source, the old preparation is reclaimed, the new request goes on from there', async () => {
  const s = scene();
  const C = makeHost('C');
  (s.hosts as any).C = C;
  s.net.lose({ method: 'chat.commitContinue', when: 'before', times: 3, error: unknown() });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  // another client moved the chat to C through the source
  await C.host.prepare({ chatId: CHAT, epoch: 1, key: 'prep-key-0009', harness: 'claude', cwd: '/work/c', handoff: 'h' });
  await s.A.host.commit({ chatId: CHAT, expectedEpoch: 0, targetHostId: 'C', preparedId: 'prep-C-0001' });
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch], ['B', 2]);
  assert.equal(s.B.log.discarded.length, 1, 'the first preparation was dropped');
  assert.equal(C.owners.get(CHAT)?.state, 'released');
});

test('an unsettled move with the source still online and silent is not repeated or replaced', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'before', times: 6, error: unknown() });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  assert.equal(s.B.log.opened.length, 1);
  staysOnA(s);
});

test('a reply the channel could not read is not proof the commit failed: the preparation is kept and the move stays unsettled', async () => {
  const s = scene();
  s.net.lose({
    method: 'chat.commitContinue',
    when: 'after',
    times: 3,
    error: Object.assign(new Error('The Host sent a reply with no result.'), { code: 'invalid' }),
  });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  assert.equal(s.B.owners.get(CHAT)?.state, 'prepared');
  assert.equal(s.A.owners.get(CHAT)?.state, 'released');
  assert.equal((await s.app.machine.continueChat(req())).epoch, 1);
});

test('a map that holds another owner at the epoch being recorded is a conflict, not a success', async () => {
  const s = scene();
  const real = s.app.ownership.set.bind(s.app.ownership);
  let first = true;
  s.app.ownership.set = (...a: any[]) => {
    if (first) {
      first = false;
      real(CHAT, { hostId: 'C', ownerHostId: 'C', epoch: 1, folder: null });
      throw new Error('Stale host ownership epoch');
    }
    return real(...a);
  };
  await assert.rejects(s.app.machine.continueChat(req()), /Stale host ownership epoch/);
  assert.equal(s.app.ownership.get(CHAT).ownerHostId, 'C');
});

test('B1: an answer the app cannot read never counts as a move', async () => {
  let s = scene();
  // a Host that answers the preparation with nothing useful
  const net = makeNet(s.hosts);
  const lying = (hostId: string) => ({
    call: async (method: string, params: any) => {
      const res = await net.channel(hostId).call(method, params);
      if (method === 'chat.prepareContinue') return { epoch: res.epoch };
      return res;
    },
  });
  const app = makeApp({ ...net, channel: lying } as any);
  app.ownership.set(CHAT, { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: null });
  await assert.rejects(app.machine.continueChat(req()), code('not_prepared'));
  assert.equal(app.ownership.get(CHAT).epoch, 0);
  // a commit that names another epoch or preparation, or nothing
  for (const answer of [null, { epoch: 7, preparedId: 'x' }, { epoch: 1, preparedId: 'other-prepared' }, 'ok']) {
    s = scene();
    const real = s.net.channel;
    const app2 = makeApp({
      ...s.net,
      channel: (h: string) => ({
        call: async (m: string, p: any) => (m === 'chat.commitContinue' ? (await real(h).call(m, p), answer) : real(h).call(m, p)),
      }),
    } as any);
    app2.ownership.set(CHAT, { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: null });
    await assert.rejects(app2.machine.continueChat(req()), code('commit_unsettled'));
    assert.equal(app2.ownership.get(CHAT).epoch, 0);
  }
});

test('A3: cancel while the target prepares: nothing moves, the preparation is dropped, and cancel after the commit is asked is refused', async () => {
  const s = scene();
  let release!: () => void;
  s.B.state.gate = new Promise<void>((r) => (release = r));
  const run = s.app.machine.continueChat(req());
  await later();
  assert.equal(s.app.machine.cancel(CHAT), true);
  release();
  await assert.rejects(run, code('continue_cancelled'));
  staysOnA(s);
  assert.equal(s.B.owners.get(CHAT), null);
  assert.equal(s.app.machine.cancel(CHAT), false, 'nothing running');
  // a commit under way cannot be cancelled: its answer decides
  const t = scene();
  let go!: () => void;
  t.A.state.quiesce = new Promise<void>((r) => (go = r));
  const second = t.app.machine.continueChat(req());
  await later();
  await later();
  assert.equal(t.app.machine.status(CHAT)?.phase, 'committing');
  assert.equal(t.app.machine.cancel(CHAT), false);
  go();
  assert.equal((await second).epoch, 1);
});

test('A3: the chat moving under the continue (another window) ends it without a write, and the preparation is dropped', async () => {
  const s = scene();
  let release!: () => void;
  s.B.state.gate = new Promise<void>((r) => (release = r));
  const run = s.app.machine.continueChat(req());
  await later();
  s.app.ownership.set(CHAT, { hostId: 'C', ownerHostId: 'C', epoch: 1, folder: null });
  release();
  await assert.rejects(run, (e: any) => e.code === 'owner_changed' && e.details.hostId === 'C');
  assert.deepEqual(s.app.ownership.get(CHAT), { hostId: 'C', ownerHostId: 'C', epoch: 1, folder: null });
  assert.equal(s.B.owners.get(CHAT), null);
});

test('A3: disposing between awaits starts nothing after it; a disposed machine refuses new continues', async () => {
  const s = scene();
  let release!: () => void;
  s.B.state.gate = new Promise<void>((r) => (release = r));
  const run = s.app.machine.continueChat(req());
  await later();
  s.app.machine.dispose();
  release();
  await assert.rejects(run, code('continue_cancelled'));
  assert.ok(!methods(s.net).includes('commitContinue@A'));
  await assert.rejects(s.app.machine.continueChat(req()), code('continue_cancelled'));
  staysOnA(s);
});

test('W2/W3: the map write failing after a commit keeps the commit, reports, and a retry only writes it', async () => {
  const s = scene();
  const real = s.app.ownership.set.bind(s.app.ownership);
  let fail = true;
  s.app.ownership.set = (...a: any[]) => {
    if (fail) throw new Error('disk full');
    return real(...a);
  };
  await assert.rejects(s.app.machine.continueChat(req()), /disk full/);
  assert.equal(s.app.ownership.get(CHAT).epoch, 0);
  assert.equal(s.A.owners.get(CHAT)?.state, 'released');
  fail = false;
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch], ['B', 1]);
  assert.equal(s.A.epochs.current(CHAT), 1, 'committed once');
  assert.equal(s.B.log.opened.length, 1);
  // a map another window already moved to this epoch is not an error
  const t = scene();
  const realT = t.app.ownership.set.bind(t.app.ownership);
  let first = true;
  t.app.ownership.set = (...a: any[]) => {
    if (first) {
      first = false;
      realT(CHAT, { hostId: 'B', ownerHostId: 'B', epoch: 1, folder: '/elsewhere' });
      throw new Error('Stale host ownership epoch');
    }
    return realT(...a);
  };
  assert.equal((await t.app.machine.continueChat(req())).epoch, 1);
});

test('a missed activation or release does not undo the move; the source is released when it is asked again', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.subscribe', when: 'before' });
  s.net.lose({ method: 'chat.release', hostId: 'A', when: 'before' });
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual(got, { hostId: 'B', epoch: 1, lostHost: false, activated: false, released: false });
  assert.equal(s.app.ownership.get(CHAT).epoch, 1);
  assert.equal(s.A.owners.get(CHAT)?.state, 'released', 'read-only already');
  assert.ok(s.app.reports.length >= 2);
  // the first request that carries the new epoch activates the target
  s.B.host.gate(CHAT, 1);
  assert.equal(s.B.log.served.length, 1);
  await s.app.machine.flushReleases('B');
  assert.equal(s.A.log.retired.length, 0);
  await s.app.machine.flushReleases('A');
  assert.deepEqual(s.A.log.retired, [CHAT]);
  await s.app.machine.flushReleases('A');
  assert.equal(s.A.log.retired.length, 1, 'once');
});

test('adopt follows the source only when it names a newer epoch and a host', () => {
  const s = scene();
  const { adopt } = s.app.machine;
  assert.equal(adopt(CHAT, null), false);
  assert.equal(adopt(CHAT, { targetHostId: 5, epoch: 3 }), false);
  assert.equal(adopt(CHAT, { targetHostId: 'C', epoch: -1 }), false);
  assert.equal(adopt(CHAT, { targetHostId: 'C', epoch: 0 }), false, 'not newer');
  assert.equal(adopt(CHAT, { targetHostId: 'C', epoch: 4 }), true);
  assert.deepEqual(s.app.ownership.get(CHAT), { hostId: 'C', ownerHostId: 'C', epoch: 4, folder: null });
  assert.equal(adopt(CHAT, { targetHostId: 'D', epoch: 4 }), false);
});

test('a window can follow the phase of a continue and stops when it unsubscribes', async () => {
  const s = scene();
  const seen: (string | undefined)[] = [];
  const off = s.app.machine.onChange(() => seen.push(s.app.machine.status(CHAT)?.phase));
  await s.app.machine.continueChat(req());
  off();
  const n = seen.length;
  await s.app.machine.continueChat(req({ targetHostId: 'A', cwd: '/work/a' }));
  assert.equal(seen.length, n);
  assert.deepEqual(seen.filter(Boolean), ['starting', 'preparing', 'committing']);
  assert.equal(seen.at(-1), undefined);
});
