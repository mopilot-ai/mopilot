// A message that waits for the organization sign-in on this Mac (electron/host/remoteSend.cjs, #3361 Tier 2): it stays queued as 'orgSignin', Send now retries it, signing in sends it, and the organization being unreachable is a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world as remoteWorld, UUID, code, msg } from './support/host/remoteSendKit.ts';

function world(t: any) {
  const w = remoteWorld(t);
  w.remote('c1');
  return {
    ...w,
    get sent() {
      return w.sent.map((s) => s.item.text);
    },
  };
}

test('a lapsed organization sign-in keeps the message queued as orgSignin, and the receipt says so', async (t) => {
  const w = world(t);
  w.host.failWith = code('sign in', 'org_signin_required');
  const receipt = await w.service.send('c1', msg('hello', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1), waitingFor: 'orgSignin' });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'orgSignin');
  assert.deepEqual(w.reports, [], 'a wait for the person is not a failure');
  // held for the person: a resume does not retry it
  w.host.failWith = null;
  await w.service.resume();
  assert.deepEqual(w.sent, []);
});

test('Send now retries it: it goes once signed in, and waits again when the sign-in is still needed', async (t) => {
  const w = world(t);
  w.host.failWith = code('sign in', 'org_signin_required');
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', waitingFor: 'orgSignin' });
  w.host.failWith = null;
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.deepEqual(w.sent, ['hello']);
});

test('signing in sends what waited; with nothing waiting it does nothing', async (t) => {
  const w = world(t);
  await w.service.orgSignedIn();
  w.host.failWith = code('sign in', 'org_signin_required');
  await w.service.send('c1', msg('one', UUID(1)), 1);
  w.host.failWith = null;
  await w.service.orgSignedIn();
  assert.deepEqual(w.sent, ['one']);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('removing a message that waits for the sign-in clears the wait', async (t) => {
  const w = world(t);
  w.host.failWith = code('sign in', 'org_signin_required');
  await w.service.send('c1', msg('one', UUID(1)), 1);
  assert.ok(w.service.remove('c1', UUID(1)));
  w.host.failWith = null;
  await w.service.orgSignedIn();
  assert.deepEqual(w.sent, []);
});

test('an unreachable organization and a busy identity are refusals the person reads, not retried', async (t) => {
  const w = world(t);
  w.host.failWith = code('The IdP did not answer.', 'org_unavailable');
  const receipt = await w.service.send('c1', msg('one', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1), error: 'The IdP did not answer.', waitingFor: 'hostRefused' });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  const b = world(t);
  b.host.failWith = code('Another identity is running.', 'org_identity_busy');
  await b.service.send('c1', msg('two', UUID(2)), 1);
  assert.equal(b.queues.get('c1')![0].waitingFor, 'hostRefused');
  assert.deepEqual(b.reports, []);
});
