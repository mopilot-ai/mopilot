// Phone push sign-out: the remembered token is forgotten even when the relay did not confirm removing it, so the next account registers (#3098).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPushRegistration } from '../mobile/src/push/registration';
import { controllerRig, tick } from './support/phone/push-controller-rig';

test('a sign-out forgets the token even when the relay did not confirm removing it, on failure and on timeout (#3098)', async () => {
  const failed = controllerRig();
  await failed.ctl.start();
  failed.gate.disableFails = true;
  await failed.ctl.signOut();
  assert.deepEqual(failed.log.slice(-3), ['forget', 'signOut', 'prune:']);
  const slow = controllerRig();
  await slow.ctl.start();
  slow.gate.disable = new Promise(() => {});
  await slow.ctl.signOut();
  assert.deepEqual(slow.log.slice(-3), ['forget', 'signOut', 'prune:']);
});

test('after a sign-out whose removal failed, the next account registers the same token (#3098)', async () => {
  const calls: string[] = [];
  let stored: string | null = null;
  let relayDown = false;
  const registration = createPushRegistration({
    relay: {
      register: async (_platform, token) => void calls.push(`register:${token}`),
      unregister: async () => {
        calls.push('unregister');
        if (relayDown) throw new Error('relay unreachable');
      },
    },
    tokens: { platform: 'apns', get: async () => 'tok1', onRefresh: () => () => {} },
    store: { read: async () => stored, write: async (t) => void (stored = t) },
  });
  const r = controllerRig({ user: { id: 'alice' }, registration });
  await r.ctl.start();
  await tick();
  assert.deepEqual(calls, ['register:tok1']);
  relayDown = true;
  await r.ctl.signOut();
  assert.equal(stored, null, 'the unconfirmed token is not kept as registered');
  r.state.user = { id: 'bob' };
  r.emit();
  await tick();
  assert.deepEqual(calls, ['register:tok1', 'unregister', 'register:tok1'], 'the next account hands the token to the relay');
});
