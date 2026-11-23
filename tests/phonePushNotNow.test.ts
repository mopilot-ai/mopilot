// Not now on the notifications card: hidden at once, however slowly or whether at all the choice is saved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerRig, defer, tick } from './support/phone/push-controller-rig';

test('Not now takes the card away at once, however slowly the choice is saved and even when it cannot be', async () => {
  const slow = controllerRig({ step: 'explain' });
  await slow.ctl.start();
  const hold = defer();
  slow.gate.dismiss = hold.promise;
  const pending = slow.ctl.later();
  await tick();
  assert.equal(slow.ctl.ui().step, 'later', 'hidden while the keychain write is still out');
  hold.resolve();
  await pending;
  const failing = controllerRig({ step: 'explain' });
  await failing.ctl.start();
  failing.gate.dismiss = Promise.resolve();
  failing.gate.dismissFails = true;
  await failing.ctl.later();
  assert.equal(failing.ctl.ui().step, 'later', 'a choice that could not be saved still holds for this run');
});
