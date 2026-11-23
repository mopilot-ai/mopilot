// A Host that lost its relay enrollment (reset, reinstalled): the phone's own path to it is dead whatever its stored record says, so the phone says so, repairs it by itself once the Mac shows the machine is up, and a record can be removed (#4721).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAL_AFTER_MS, HEAL_RETRY_MS } from '../shared/remote/phoneHosts.mjs';
import { rig } from './support/phone/host-rig.ts';
import { waitFor } from './support/waitFor.ts';

const clockRig = (o: Parameters<typeof rig>[0] = {}) => {
  const clock = { now: 1_000 };
  const r = rig({ ...o, timers: { setInterval: () => 0, clearInterval: () => undefined, now: () => clock.now } });
  return { r, clock };
};
/** Reads the Host once more and waits for the answer. */
const read = async (r: ReturnType<typeof rig>) => {
  const ok = await r.settle(r.phones.refresh('ssh:box'));
  r.pump();
  return ok;
};
const enrolls = (r: ReturnType<typeof rig>) => r.macCalls.filter((c) => c[0] === 'enroll').length;

test('a Host the phone cannot open a session to is said to be down, and a Host that answers is up again', async () => {
  const { r } = clockRig();
  await r.phones.load();
  assert.equal(r.phones.link('ssh:box'), 'unknown', 'nothing is known before a read');
  r.gone.value = true;
  assert.equal(await read(r), false);
  assert.equal(r.phones.link('ssh:box'), 'down');
  r.gone.value = false;
  assert.equal(await read(r), true);
  assert.equal(r.phones.link('ssh:box'), 'up');
  assert.equal(r.phones.link('nobody'), 'unknown');
});

test('a Host that stays unreachable while the Mac says it is up is enrolled again by the phone, once it has been down a while', async () => {
  const { r, clock } = clockRig();
  await r.phones.load();
  r.gone.value = true;
  await read(r);
  assert.equal(await r.phones.heal('ssh:box'), false, 'the Mac has not said the machine is up');
  r.phones.macSays(['ssh:box']);
  assert.equal(await r.phones.heal('ssh:box'), false, 'a Host that was only just found down may be coming back');
  assert.equal(enrolls(r), 0);
  const old = r.stored()['ssh:box'];
  clock.now += HEAL_AFTER_MS;
  await read(r);
  await waitFor(() => (r.pump(), enrolls(r) === 1), 'the new enrollment');
  await waitFor(() => (r.pump(), r.stored()['ssh:box'].hostId !== old.hostId), 'the record replaced');
  assert.notEqual(r.stored()['ssh:box'].root, old.root, 'a record from the old enrollment is replaced, not kept');
  assert.ok(
    r.requests.some((m) => m.t === 'host.revoke' && m.host === old.hostId),
    'the old relay credential is revoked',
  );
  assert.equal(r.phones.link('ssh:box'), 'unknown', 'what was read through the old enrollment says nothing of the new one');
});

test('a repair is not tried again at once, and not at all while the Mac does not say the machine is up', async () => {
  const { r, clock } = clockRig({ macEnrollFails: true });
  await r.phones.load();
  r.gone.value = true;
  await read(r);
  clock.now += HEAL_AFTER_MS;
  await read(r);
  assert.equal(await r.phones.heal('ssh:box'), false, 'the Mac says nothing');
  assert.equal(enrolls(r), 0);
  // the Mac saying the machine is up starts the repair by itself
  r.phones.macSays(['ssh:box']);
  await waitFor(() => r.phones.setupState('ssh:box') === 'failed', 'the failed set-up');
  assert.equal(enrolls(r), 1);
  assert.equal(r.stored()['ssh:box'].hostId, 'h_x', 'a failed repair keeps the record');
  assert.equal(await r.phones.heal('ssh:box'), false, 'not again at once');
  clock.now += HEAL_RETRY_MS - 1;
  assert.equal(await r.phones.heal('ssh:box'), false, 'not before the pause is over');
  clock.now += 1;
  assert.equal(await r.phones.heal('ssh:box'), true, 'but later');
  await waitFor(() => enrolls(r) === 2, 'the second try');
  await waitFor(() => r.phones.setupState('ssh:box') === 'failed', 'the second failure');
  r.phones.macSays([]);
  clock.now += HEAL_RETRY_MS;
  assert.equal(await r.phones.heal('ssh:box'), false, 'the Mac no longer says it is up');
});

test('a machine the Mac lists is repaired by itself when a read finds it down; a Host that answers is left alone', async () => {
  const { r, clock } = clockRig();
  await r.phones.load();
  r.phones.macSays(['ssh:box']);
  assert.equal(await read(r), true);
  assert.equal(await r.phones.heal('ssh:box'), false, 'a Host that answers needs nothing');
  r.gone.value = true;
  await read(r);
  clock.now += HEAL_AFTER_MS;
  await read(r);
  await waitFor(() => (r.pump(), enrolls(r) === 1), 'the repair a failed read starts');
});

test('setting up again over a record replaces it: the old session ends and the old relay credential goes', async () => {
  const { r } = clockRig();
  await r.phones.load();
  assert.equal(await read(r), true);
  const old = r.stored()['ssh:box'];
  await r.phones.setUp('ssh:box');
  assert.notEqual(r.stored()['ssh:box'].hostId, old.hostId);
  assert.ok(r.requests.some((m) => m.t === 'host.revoke' && m.host === old.hostId));
  assert.equal(r.phones.reachable('ssh:box'), null, 'what the old enrollment read says nothing of the new one');
});

test('removing a machine takes its record, its relay credential and the Mac’s side away', async () => {
  const { r } = clockRig();
  await r.phones.load();
  assert.deepEqual(await r.phones.forget('ssh:box'), { complete: true });
  assert.equal(r.phones.enrolled('ssh:box'), false);
  assert.equal(r.stored()['ssh:box'], undefined);
  assert.ok(r.requests.some((m) => m.t === 'host.revoke' && m.host === 'h_x'));
  assert.deepEqual(r.macCalls, [['forget', 'ssh:box']]);
});
