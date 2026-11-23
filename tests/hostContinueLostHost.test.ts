// The lost-host path: the source is offline, the user agrees, the app advances the epoch itself and records it; when the source returns it poisons its copy and its tail is merged read-only (contract 1, A3, I2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, makeHost, req, scene } from './support/hostContinueKit.ts';

const code = (c: string) => (e: any) => e?.code === c;
const goneA = (s: ReturnType<typeof scene>) => {
  s.net.down.add('A');
  s.app.offline.add('A');
};
const returnA = (s: ReturnType<typeof scene>) => {
  s.net.down.delete('A');
  s.app.offline.delete('A');
};
/** What the hello to the returning source does: the app says what it moved, the Host answers, the app acts on the answer. */
const hello = async (s: ReturnType<typeof scene>, hostId = 'A') => {
  const reply = await s.hosts[hostId].host.acceptHello(s.app.machine.movedFrom(hostId));
  await s.app.machine.sourceReturned(hostId, reply);
  return reply;
};

test('the user is asked first and says no: nothing is prepared, nothing changes', async () => {
  const s = scene({ confirm: async () => false });
  goneA(s);
  await assert.rejects(s.app.machine.continueChat(req()), code('lost_host_declined'));
  assert.deepEqual(s.app.confirms, [{ chatId: CHAT, sourceHostId: 'A', targetHostId: 'B' }]);
  assert.equal(s.net.calls.length, 0);
  assert.deepEqual(s.app.ownership.get(CHAT), { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: '/work/a' });
});

test('the target being offline is refused before the user is asked about the source', async () => {
  const s = scene();
  goneA(s);
  s.net.down.add('B');
  await assert.rejects(s.app.machine.continueChat(req()), code('target_offline'));
  assert.equal(s.app.confirms.length, 0);
});

test('on yes the app advances the epoch itself, records the lost host, and never talks to the source', async () => {
  const s = scene();
  goneA(s);
  s.app.setRev(11);
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual(got, { hostId: 'B', epoch: 1, lostHost: true, activated: true, released: false });
  assert.deepEqual(s.app.reopenMap().get(CHAT), {
    hostId: 'B',
    ownerHostId: 'B',
    epoch: 1,
    folder: '/work/b',
    lostHost: { sourceHostId: 'A', targetHostId: 'B', epoch: 1, rev: 11 },
  });
  assert.ok(s.net.calls.every((c) => c.hostId === 'B'));
  assert.equal(s.B.log.served.length, 1);
  assert.deepEqual(s.app.machine.movedFrom('A'), [{ chatId: CHAT, epoch: 1, targetHostId: 'B' }]);
  assert.deepEqual(s.app.machine.movedFrom('B'), []);
});

test('the target refusing after the user said yes leaves the chat as it was, with no lost-host record', async () => {
  const s = scene();
  goneA(s);
  s.B.state.notConfigured = true;
  await assert.rejects(s.app.machine.continueChat(req()), code('harness_not_configured'));
  assert.deepEqual(s.app.ownership.get(CHAT), { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: '/work/a' });
  assert.deepEqual(s.app.machine.movedFrom('A'), []);
});

test('A3: the source coming back while the card is open: the move goes through the source after all', async () => {
  const s = scene({
    confirm: async () => {
      returnA(s as any);
      return true;
    },
  });
  goneA(s);
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch, got.lostHost], ['B', 1, false]);
  assert.equal(s.A.owners.get(CHAT)?.state, 'released');
  assert.deepEqual(s.app.machine.movedFrom('A'), []);
});

test('A3: the chat moving while the card is open voids the continue before anything is prepared', async () => {
  const s = scene({
    confirm: async () => {
      s.app.ownership.set(CHAT, { hostId: 'C', ownerHostId: 'C', epoch: 1, folder: null });
      return true;
    },
  });
  goneA(s);
  await assert.rejects(s.app.machine.continueChat(req()), code('owner_changed'));
  assert.equal(s.B.log.opened.length, 0);
  assert.equal(s.app.ownership.get(CHAT).ownerHostId, 'C');
});

test('the source returns after a lost-host continue: it poisons itself, its tail is merged read-only, the record closes', async () => {
  const s = scene();
  goneA(s);
  s.app.setRev(7);
  await s.app.machine.continueChat(req());
  // what A wrote after the last rev the app saw
  s.app.tails[`A|${CHAT}`] = [{ rev: 6 }, { rev: 8 }, { rev: 9 }];
  returnA(s);
  const reply = await hello(s);
  assert.deepEqual(reply, { poisoned: [{ chatId: CHAT, epoch: 1 }], conflicts: [], agreed: [] });
  assert.deepEqual(s.app.merged, [{ chatId: CHAT, hostId: 'A', items: [{ rev: 8 }, { rev: 9 }] }]);
  assert.equal(s.app.reopenMap().get(CHAT).lostHost, undefined);
  assert.deepEqual(s.app.machine.movedFrom('A'), []);
  // A serves nothing for the chat any more, writes or commits; reads still work
  assert.equal(s.A.owners.get(CHAT)?.state, 'poisoned');
  assert.equal(s.A.epochs.current(CHAT), 1);
  assert.throws(() => s.A.host.gate(CHAT, 0), code('chat_poisoned'));
  assert.throws(() => s.A.host.gate(CHAT, 1), code('chat_poisoned'));
  await assert.rejects(
    s.A.host.commit({ chatId: CHAT, expectedEpoch: 1, targetHostId: 'C', preparedId: 'prep-C-0001' }),
    code('chat_poisoned'),
  );
  s.A.host.touch(CHAT, 1);
  // a second hello has nothing to say
  assert.deepEqual(await hello(s), { poisoned: [], conflicts: [], agreed: [] });
});

test('a returned old owner can take the chat back later: a newer epoch replaces its poison', async () => {
  const s = scene();
  goneA(s);
  await s.app.machine.continueChat(req());
  returnA(s);
  await hello(s);
  const back = await s.app.machine.continueChat(req({ targetHostId: 'A', cwd: '/work/a' }));
  assert.deepEqual([back.hostId, back.epoch, back.lostHost], ['A', 2, false]);
  assert.equal(s.A.owners.get(CHAT), null);
  assert.equal(s.A.state.running.has(CHAT), true);
});

test('a tail that cannot be merged yet keeps the record and is read again with the next answer', async () => {
  const s = scene();
  goneA(s);
  await s.app.machine.continueChat(req());
  returnA(s);
  s.app.tails[`A|${CHAT}`] = [{ rev: 8 }];
  const reply = await s.A.host.acceptHello(s.app.machine.movedFrom('A'));
  // the chat store is busy: the merge fails once
  const original = s.app.merged.push.bind(s.app.merged);
  let busy = true;
  s.app.merged.push = (...a: any[]) => {
    if (busy) throw new Error('chat store is busy');
    return original(...a);
  };
  await s.app.machine.sourceReturned('A', reply);
  assert.ok(s.app.reports.some((r) => /not merged yet/.test(r)));
  assert.equal(s.app.ownership.get(CHAT).lostHost?.epoch, 1);
  assert.equal(s.app.merged.length, 0);
  busy = false;
  await s.app.machine.sourceReturned('A', reply);
  assert.equal(s.app.ownership.get(CHAT).lostHost, undefined);
  assert.deepEqual([...s.app.merged], [{ chatId: CHAT, hostId: 'A', items: [{ rev: 8 }] }]);
});

test('A3: the chat moving on while its tail is read keeps the newer record', async () => {
  const s = scene();
  goneA(s);
  await s.app.machine.continueChat(req());
  returnA(s);
  const reply = await s.A.host.acceptHello(s.app.machine.movedFrom('A'));
  const realPush = s.app.merged.push.bind(s.app.merged);
  s.app.merged.push = (...a: any[]) => {
    s.app.ownership.set(CHAT, { hostId: 'C', ownerHostId: 'C', epoch: 2, folder: null });
    return realPush(...a);
  };
  await s.app.machine.sourceReturned('A', reply);
  assert.equal(s.app.ownership.get(CHAT).ownerHostId, 'C');
});

test('I2: two owners at one epoch are reported, not merged and not silently resolved', async () => {
  const s = scene();
  const C = makeHost('C');
  (s.hosts as any).C = C;
  // the source handed the chat to C at epoch 1 and then went away before the app heard
  await C.host.prepare({ chatId: CHAT, epoch: 1, key: 'prep-key-0001', harness: 'claude', cwd: '/work/c', handoff: 'h' });
  await s.A.host.commit({ chatId: CHAT, expectedEpoch: 0, targetHostId: 'C', preparedId: 'prep-C-0001' });
  goneA(s);
  await s.app.machine.continueChat(req());
  returnA(s);
  const reply = await hello(s);
  assert.deepEqual(reply, { poisoned: [], conflicts: [{ chatId: CHAT, epoch: 1, targetHostId: 'C' }], agreed: [] });
  assert.ok(s.app.reports.some((r) => /two owners/.test(r)));
  assert.equal(s.A.owners.get(CHAT)?.state, 'released', 'the source keeps its own record');
  assert.equal(s.app.ownership.get(CHAT).lostHost?.epoch, 1, 'left for the user to settle');
});

test('a commit that landed but was never heard, then the source lost: the lost-host move to the same target agrees with it', async () => {
  const s = scene();
  s.net.lose({ method: 'chat.commitContinue', when: 'after', times: 3 });
  await assert.rejects(s.app.machine.continueChat(req()), code('commit_unsettled'));
  goneA(s);
  const got = await s.app.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch, got.lostHost], ['B', 1, true]);
  returnA(s);
  const reply = await hello(s);
  assert.deepEqual(reply, { poisoned: [], conflicts: [], agreed: [{ chatId: CHAT, epoch: 1 }] });
  assert.equal(s.app.ownership.get(CHAT).lostHost, undefined);
  assert.equal(s.app.merged.length, 0);
});

test('B1: a hello answer the app cannot read, or one for a chat it did not move, changes nothing', async () => {
  const s = scene();
  goneA(s);
  await s.app.machine.continueChat(req());
  for (const bad of [
    null,
    'ok',
    {},
    { poisoned: 5, conflicts: [] },
    { poisoned: [], conflicts: [{ chatId: 5, epoch: 1 }] },
    { poisoned: [], conflicts: [], agreed: 'x' },
  ]) {
    await s.app.machine.sourceReturned('A', bad);
  }
  assert.equal(s.app.reports.filter((r) => /cannot read/.test(r)).length, 5 + 0);
  // an answer for another epoch, another host or another chat is not ours to close
  await s.app.machine.sourceReturned('A', {
    poisoned: [
      { chatId: CHAT, epoch: 5 },
      { chatId: 'claude:other', epoch: 1 },
    ],
    conflicts: [],
    agreed: [{ chatId: CHAT, epoch: 9 }],
  });
  await s.app.machine.sourceReturned('Z', { poisoned: [{ chatId: CHAT, epoch: 1 }], conflicts: [], agreed: [{ chatId: CHAT, epoch: 1 }] });
  assert.equal(s.app.ownership.get(CHAT).lostHost?.epoch, 1);
  assert.equal(s.app.merged.length, 0);
});

test('the wire carries the lost-host claim: the hello parser keeps chat, epoch and target and refuses the rest', async () => {
  const { parseParams, helloParams } = await import('../shared/host/schema.mjs');
  const moved = [{ chatId: CHAT, epoch: 1, targetHostId: 'B' }];
  assert.deepEqual((parseParams as any)('host.hello', { ...helloParams(), moved }).moved, moved);
  assert.deepEqual((parseParams as any)('host.hello', helloParams()).moved, []);
  for (const bad of ['x', [{ ...moved[0], epoch: -1 }], [{ ...moved[0], targetHostId: '' }], [null], Array(300).fill(moved[0])])
    assert.throws(
      () => (parseParams as any)('host.hello', { ...helloParams(), moved: bad }),
      (e: any) => e.code === 'invalid',
    );
});
