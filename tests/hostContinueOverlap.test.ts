// A1: two continues of one chat at once (one app, or the Mac and the phone): exactly one wins, the other is refused with a reason, and nothing it prepared is left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, makeApp, makeHost, req, scene } from './support/hostContinueKit.ts';

const code = (c: string) => (e: any) => e?.code === c;
const later = () => new Promise<void>((r) => setImmediate(r));

test('A1: a second continue of the chat is refused while one runs; another chat is not; the slot is free again afterwards (A4)', async () => {
  const s = scene();
  s.A.state.running.add('claude:c2');
  s.app.ownership.set('claude:c2', { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: null });
  let release!: () => void;
  s.B.state.gate = new Promise<void>((r) => (release = r));
  const first = s.app.machine.continueChat(req());
  await later();
  assert.deepEqual(s.app.machine.status(CHAT), { phase: 'preparing', targetHostId: 'B' });
  await assert.rejects(s.app.machine.continueChat(req({ targetHostId: 'C' })), code('continue_in_flight'));
  const other = s.app.machine.continueChat(req({ chatId: 'claude:c2' }));
  release();
  const [a, b] = await Promise.all([first, other]);
  assert.deepEqual([a.epoch, b.epoch], [1, 1]);
  assert.equal(s.app.machine.status(CHAT), null);
  assert.equal((await s.app.machine.continueChat(req({ targetHostId: 'A', cwd: '/work/a' }))).epoch, 2);
});

test('another continue of the chat through the source wins: this one is refused, adopts where the chat went, and drops its preparation (A1 across clients)', async () => {
  const s = scene();
  const phone = makeApp(s.net, { file: undefined });
  phone.ownership.set(CHAT, { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: null });
  let release!: () => void;
  s.B.state.gate = new Promise<void>((r) => (release = r));
  const mac = s.app.machine.continueChat(req());
  await later();
  // the phone sends the chat to C first (host C is the same fake as B, under another id)
  const C = makeHost('C');
  (s.hosts as any).C = C;
  const won = await phone.machine.continueChat(req({ targetHostId: 'C' }));
  assert.deepEqual([won.hostId, won.epoch], ['C', 1]);
  release();
  await assert.rejects(mac, (e: any) => e.code === 'chat_released' && e.details.targetHostId === 'C');
  const rec = s.app.ownership.get(CHAT);
  assert.deepEqual([rec.ownerHostId, rec.epoch], ['C', 1], 'the Mac follows the source');
  assert.equal(s.B.owners.get(CHAT), null);
  assert.equal(C.owners.get(CHAT), null, 'C serves');
});
