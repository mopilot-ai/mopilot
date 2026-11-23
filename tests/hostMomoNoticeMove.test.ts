// MoMo's notice records move with the home: sealed with MoMo's own data key (the one the move bundle carries), the matters, the decision log and the cursors open on the new Host, and the old Host keeps nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createNoticeStore } from '../host/src/momoNoticeStore.mjs';
import { moveHome } from '../shared/momoMove.mjs';
import { A, B, host } from './support/host/momoMoveWorld.ts';

test('notice.json moves with the home and opens on the target Host; the old Host keeps none', async (t) => {
  const a = await host(t, A);
  const b = await host(t, B);
  await a.home.start(A);
  const storeA = createNoticeStore({ home: a.home, now: a.clock.now });
  await storeA.notice.putMatter({ matterKey: 'gmail:t1', state: 'open', title: 'Contract', summary: 's', sources: [], updatedAt: 'x' });
  await storeA.addDecision({
    changeId: 'gmail:t1',
    decision: 'tell_now',
    outcome: 'tell_now',
    reason: 'r',
    title: 'Contract',
    decidedBy: 'model:x',
    at: 'x',
  });
  await storeA.setLastRunAt(1234);
  assert.ok(fs.existsSync(path.join(a.momoDir, 'notice.json')));

  const r = await moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(r.ok, true);
  const storeB = createNoticeStore({ home: b.home, now: b.clock.now });
  assert.deepEqual(
    (await storeB.notice.listMatters()).map((m: any) => m.title),
    ['Contract'],
  );
  assert.deepEqual([storeB.decisions().length, storeB.lastRunAt()], [1, 1234]);
  assert.equal(fs.existsSync(path.join(a.momoDir, 'notice.json')), false, 'the old home keeps no records');
});
