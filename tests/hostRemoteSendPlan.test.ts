// Plan on a message to a chat on a machine (electron/host/remoteSend.cjs, remotePicks.cjs): carried as the Host's mode when its Host says it takes Plan for the agent, refused with its words otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';

test('Plan goes to a machine whose Host takes it for the agent: the Host is permitted to plan, the message carries no Plan flag, and the next message without Plan leaves it', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.kinds.set('c1', 'codex');
  w.row.harnesses = [{ id: 'codex', planMode: true }];
  const planned = await w.service.send('c1', { ...msg('plan this', UUID(120)), opts: { plan: true } });
  assert.notEqual(planned.action, 'failed');
  assert.deepEqual(w.permits, [{ chatId: 'c1', value: 'plan' }]);
  assert.equal(w.sent.length, 1);
  assert.equal('plan' in (w.sent[0].item.opts ?? {}), false);
  // Plan is left by saying the mode the chat is in, not by a Mac that remembers it
  await w.service.send('c1', msg('now do it', UUID(121)));
  assert.deepEqual(
    w.permits.map((p) => p.value),
    ['plan', 'default'],
  );
});

test('Plan is refused with its words for an agent the machine’s Host does not say takes it, even when another agent of the machine does', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.kinds.set('c1', 'claude');
  w.row.harnesses = [{ id: 'codex', planMode: true }, { id: 'claude' }];
  const receipt = await w.service.send('c1', { ...msg('keep this plan'), opts: { plan: true } });
  assert.equal(receipt.action, 'failed');
  assert.match(receipt.error, /Plan mode.*machine/i);
  assert.deepEqual([w.sent.length, w.permits.length], [0, 0]);
});

test('Plan keeps the mode the person had picked as the one its tools run under: a message to an open chat enters that mode before Plan, and the first message of a new chat carries it as planBase', async (t) => {
  const pick = { hostId: 'box', harness: 'codex', value: 'auto-review' };
  const w = world(t);
  w.remote('c1');
  w.kinds.set('c1', 'codex');
  w.row.harnesses = [{ id: 'codex', planMode: true }];
  await w.service.send('c1', { ...msg('plan this', UUID(130)), opts: { plan: true, hostPermission: pick } });
  assert.deepEqual(
    w.permits.map((p) => p.value),
    ['auto-review', 'plan'],
  );
  // a new chat: the start carries Plan and the base together (a Host that takes Plan reads planBase)
  const n = world(t);
  n.remote('c2', 'box', 0, '/srv/app');
  n.row.harnesses = [{ id: 'codex', planMode: true }];
  n.service.begin('c2', { harness: 'codex' });
  n.host.receipt = { action: 'started', id: UUID(131) };
  await n.service.send('c2', { ...msg('plan first', UUID(131)), opts: { plan: true, hostPermission: pick } }, 1);
  assert.deepEqual(
    n.started.map((s) => [s.item.permission, s.item.planBase]),
    [['plan', 'auto-review']],
  );
  // no pick: Plan alone, as before
  const bare = world(t);
  bare.remote('c3');
  bare.kinds.set('c3', 'codex');
  bare.row.harnesses = [{ id: 'codex', planMode: true }];
  await bare.service.send('c3', { ...msg('plan', UUID(132)), opts: { plan: true } });
  assert.deepEqual(
    bare.permits.map((p) => p.value),
    ['plan'],
  );
});
