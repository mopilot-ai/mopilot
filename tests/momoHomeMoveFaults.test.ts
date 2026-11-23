// Fault injection on the first half of moving MoMo's home (pause, seal, copy) and on the rollback steps: kill, disconnect, duplicate and lose each frame and check that no two homes act, none is lost and nothing is deleted without a receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoMachines, drive, violations, sealedHashes, observe, FACT } from './momoEvals/home/world.ts';
import { Crash } from './momoEvals/home/faultFs.ts';
import { casesFor, failures } from './momoEvals/home/matrix.ts';

test('harness control: it sees two homes and a lost home, so a green matrix means something', async () => {
  // two homes
  const two = await twoMachines();
  await two.m.B!.home.start({ homeId: 'home-bbbb-2222', name: 'Mac mini' });
  assert.match((await violations(two)).join(), /two homes act/);
  two.dispose();
  // a home whose data is gone
  const lost = await twoMachines();
  lost.m.A!.kill();
  assert.equal(lost.m.A!.acts(), false, 'a killed machine acts for nobody');
  const fs = await import('node:fs');
  fs.rmSync(lost.m.A!.keyDir, { recursive: true, force: true });
  assert.match((await violations(lost)).join(), /no home/);
  lost.dispose();
});

test('harness control: a killed machine cannot change a file any more, and a restart brings back a new process over the same folders', async () => {
  const w = await twoMachines();
  const a = w.m.A!;
  a.v.countdown = 1;
  await assert.rejects(
    a.home.swap(1, (r: any) => ((r.name = 'x'), false)),
    (e: any) => e instanceof Crash || e.code === 'crash' || /killed/.test(e.message),
  );
  assert.equal(a.alive, false);
  assert.equal(a.record().name, 'Studio', 'the write that was cut did not happen');
  a.restart();
  assert.equal(a.acts(), true);
  assert.ok(
    (await a.home.stores().memory.list()).facts.some((f: any) => f.text === FACT),
    'the data survived the kill',
  );
  w.dispose();
});

test('an undisturbed move: one home before, one after, every invariant holds at each step boundary', async () => {
  const w = await twoMachines();
  const seen: string[][] = [];
  const r = await drive(w, {
    step: (s: string) => {
      void s;
      seen.push(
        observe(w)
          .filter((o) => o.acts)
          .map((o) => o.key),
      );
    },
  });
  assert.deepEqual([r.ok, r.oldHome, r.leaseEpoch], [true, 'cleared', 2]);
  assert.ok(r.receipt);
  assert.ok(
    seen.every((acting) => acting.length <= 1),
    JSON.stringify(seen),
  );
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('pause, offer and seal: every lost frame, lost answer, duplicate and kill at each state change leaves one home or a stated recoverable one', async () => {
  const cases = await casesFor(['begin', 'offer', 'seal']);
  assert.ok(cases.length >= 12, `${cases.length} cases`);
  assert.deepEqual(await failures(cases), []);
});
