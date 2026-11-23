// The Live Activity controller's saved switch: read once before a change can be written over it, a switch that cannot be read or saved, and an explicit sign-out that leaves it off for the next account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './support/liveActivityRig.ts';

test('a change made before the saved switch is read waits for it, so it cannot write over it', async () => {
  const r = rig({ prefs: { enabled: true, titles: false } });
  const early = r.activity.setTitles(true);
  await r.settle();
  assert.deepEqual(r.only('store'), [], 'nothing is written yet');
  await r.activity.start();
  await early;
  assert.deepEqual(r.saved(), { enabled: true, titles: true });
  assert.equal(r.activity.ui().prefs.enabled, true);
});

test('a saved switch that cannot be read reads as off and does not hold up the changes that waited for it', async () => {
  const r = rig();
  r.failing.read = true;
  const early = r.activity.setEnabled(true);
  await assert.rejects(r.activity.start(), /unreadable/);
  await early;
  assert.equal(r.saved().enabled, true);
  assert.equal(r.activity.ui().status, 'on');
});

test('the saved switch is loaded after start, and an explicit sign-out leaves it off for the next account', async () => {
  const r = rig({ prefs: { enabled: true, titles: true } });
  assert.equal(r.activity.ui().loaded, false);
  await r.activity.start();
  assert.equal(r.activity.ui().loaded, true);
  assert.equal(r.activity.ui().prefs.enabled, true);
  await r.activity.forget();
  assert.deepEqual(r.saved(), { enabled: false, titles: true });
  assert.equal(r.activity.ui().prefs.enabled, false);
  // signing in again starts nothing until the person turns it on
  r.log.length = 0;
  r.emit.account();
  await r.settle();
  assert.deepEqual(r.only('start'), []);
  assert.deepEqual(r.only('isEnabled'), []);
  // forgetting twice has nothing more to save
  await r.activity.forget();
  assert.equal(r.only('store').length, 0);
});

test('a switch that cannot be saved is not applied and is shown as failed, not left on in memory', async () => {
  const r = rig();
  await r.activity.start();
  r.failing.write = true;
  await r.activity.setEnabled(true);
  assert.equal(r.activity.ui().failed, true);
  assert.equal(r.activity.ui().prefs.enabled, false);
  assert.deepEqual(r.only('start'), []);
  await r.activity.setTitles(true);
  assert.equal(r.activity.ui().prefs.titles, false);
  r.failing.write = false;
  await r.activity.setEnabled(true);
  assert.equal(r.activity.ui().prefs.enabled, true);
  assert.equal(r.activity.ui().failed, false);
  assert.equal(r.only('start').length, 1);
});
