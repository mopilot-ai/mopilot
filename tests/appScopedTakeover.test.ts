// desktop_app_batch when the user takes the app over from the chat's strip (#1906): the batch waits for the hand back and says
// the user took over, never "stopped by the user"; Stop and the cap end the wait.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperFailure, rig } from './support/app-scoped-kit.ts';

/** Waits (a few event-loop turns at a time) until `f()` holds. */
async function until(f: () => boolean) {
  await waitFor(f, 'the condition').catch(() => {});
  assert.ok(f(), 'the condition never held');
}
const waiters = (r: any) => r.apps.held.get('com.apple.notes')?.waiters.size ?? 0;
const twoClicks = {
  app: 'Notes',
  actions: [
    { action: 'click', element_index: 7 },
    { action: 'click', element_index: 7 },
  ],
};
const HANDED_BACK = /^The user took over Notes and handed it back\. Nothing more was done: take a new screenshot, then go on\.$/;

test('take over during a batch running in the helper: it waits for the hand back and says the user took over, not stopped (#1906)', async () => {
  const r = rig({ apps: { takeoverWaitMs: 10_000 } });
  await r.shoot();
  r.helper.answers['app.click'] = () => {
    r.apps.takeOver('c1', 'com.apple.Notes');
    return { ok: true, route: 'pid' };
  };
  const call = r.call('desktop_app_batch', twoClicks);
  await until(() => waiters(r) === 1);
  assert.equal(r.apps.handBack('c1', undefined), false);
  assert.equal(r.apps.handBack('c1', 'com.apple.Notes'), true);
  const out = JSON.parse((await call)[0].text);
  assert.deepEqual([out.completed, out.stoppedAt], [1, 1]);
  assert.match(out.results[1].reason, HANDED_BACK);
  assert.deepEqual(
    r.callsOf('app.cancel').map((c: any) => c.params.batchId),
    [r.callsOf('app.batch')[0].params.batchId],
  );
  // Stop while it waits: stopped, as Stop says
  const stopped = r.call('desktop_app_batch', twoClicks);
  await until(() => waiters(r) === 1);
  r.apps.interrupt('c1');
  assert.equal(JSON.parse((await stopped)[0].text).results[1].reason, 'Stopped by the user');
});

test('take over between steps, and with an older helper (one request per step): the batch waits, then says the user took over', async () => {
  const r = rig({ apps: { takeoverWaitMs: 10_000 } });
  await r.shoot();
  // the app was taken over during a screenshot inside the batch: the click after it is not run
  const shot = r.helper.answers['app.screenshot'];
  r.helper.answers['app.screenshot'] = (p: any) => (r.apps.takeOver('c1', 'com.apple.Notes'), shot(p));
  const clicks = r.callsOf('app.click').length;
  const between = r.call('desktop_app_batch', {
    app: 'Notes',
    actions: [{ action: 'click', element_index: 7 }, { action: 'screenshot' }, { action: 'click', element_index: 7 }],
  });
  await until(() => waiters(r) === 1);
  r.apps.handBack('c1', 'com.apple.Notes');
  const out = JSON.parse((await between)[0].text);
  assert.deepEqual([out.completed, out.stoppedAt], [2, 2]);
  assert.match(out.results[2].reason, HANDED_BACK);
  assert.equal(r.callsOf('app.click').length, clicks + 1);
  r.helper.answers['app.screenshot'] = shot;
  // an older helper: the step in flight is cut short by the take-over
  r.apps.noHelperBatch = true;
  r.helper.answers['app.click'] = () => {
    r.apps.takeOver('c1', 'com.apple.Notes');
    throw helperFailure('aborted', 'aborted by the user before the click');
  };
  const old = r.call('desktop_app_batch', twoClicks);
  await until(() => waiters(r) === 1);
  r.apps.handBack('c1', 'com.apple.Notes');
  const o = JSON.parse((await old)[0].text);
  assert.deepEqual([o.completed, o.stoppedAt], [0, 0]);
  assert.match(o.results[0].reason, HANDED_BACK);
  // cut short with nobody taking over (the helper's own abort): stopped, as before
  r.helper.answers['app.click'] = () => {
    throw helperFailure('aborted', 'aborted by the user before the click');
  };
  const plain = JSON.parse((await r.call('desktop_app_batch', twoClicks))[0].text);
  assert.doesNotMatch(plain.results[0].reason, /took over/);
});

test('take over cutting a batch short, then the cap: busy, with how the user continues', async () => {
  const r = rig({ apps: { takeoverWaitMs: 5 } });
  await r.shoot();
  r.helper.answers['app.click'] = () => {
    r.apps.takeOver('c1', 'com.apple.Notes');
    return { ok: true, route: 'pid' };
  };
  const out = JSON.parse((await r.call('desktop_app_batch', twoClicks))[0].text);
  assert.match(out.results[1].reason, /took over Notes and hasn't handed it back\. Ask them to click "Done, continue"/);
  r.apps.turnEnded('c1');
});
