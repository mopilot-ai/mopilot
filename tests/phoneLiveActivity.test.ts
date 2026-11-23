// The phone's Live Activity controller: nothing starts and no permission is asked while the switch is off; turning it on starts the activity when a chat runs or waits; the token reaches the relay once; turning it off, signing out or a dismissal clean up; titles off strips what was pushed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLiveActivityPrefs } from '../mobile/src/push/liveActivityController.ts';
import { rig } from './support/liveActivityRig.ts';

test('the saved switch reads as off for anything unreadable, and on only for an explicit true', () => {
  assert.deepEqual(parseLiveActivityPrefs(null), { enabled: false, titles: false });
  assert.deepEqual(parseLiveActivityPrefs('not json'), { enabled: false, titles: false });
  assert.deepEqual(parseLiveActivityPrefs('{"enabled":"yes","titles":1}'), { enabled: false, titles: false });
  assert.deepEqual(parseLiveActivityPrefs('{"enabled":true,"titles":true}'), { enabled: true, titles: true });
  assert.deepEqual(parseLiveActivityPrefs('{"enabled":true}'), { enabled: true, titles: false });
});

test('with the switch off nothing is started, no permission is asked and the relay is not touched', async () => {
  const r = rig();
  await r.activity.start();
  await r.settle();
  assert.equal(r.activity.ui().status, 'off');
  assert.deepEqual(r.only('start'), []);
  assert.deepEqual(r.only('isEnabled'), []);
  assert.deepEqual(r.only('relay'), []);
  // the widget is told titles are off
  assert.ok(r.log.includes('titles:false'));
  r.emit.foreground();
  await r.settle();
  assert.deepEqual(r.only('start'), []);
});

test('turning the switch on starts the activity with the counts the phone knows and registers its token once', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.equal(r.saved().enabled, true);
  assert.deepEqual(r.only('start'), ['start:1/2/needs/1900000000/0']);
  assert.equal(r.activity.ui().status, 'on');
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.emit.token('aa'.repeat(32));
  r.emit.foreground();
  r.set.token('aa'.repeat(32));
  await r.settle();
  assert.deepEqual(r.only('relay.register'), [`relay.register:${'aa'.repeat(32)}`]);
  // a rotated token replaces it
  r.emit.token('bb'.repeat(32));
  await r.settle();
  assert.deepEqual(r.only('relay.register'), [`relay.register:${'aa'.repeat(32)}`, `relay.register:${'bb'.repeat(32)}`]);
});

test('a token found when the app reconciles (it arrived before the listener) is registered', async () => {
  const r = rig();
  r.set.token('cc'.repeat(32));
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.deepEqual(r.only('relay.register'), [`relay.register:${'cc'.repeat(32)}`]);
});

test('nothing running or waiting starts nothing; chats appearing start it; chats gone end what is left', async () => {
  const r = rig({ counts: { needs: 0, running: 0 } });
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.deepEqual(r.only('start'), []);
  assert.equal(r.activity.ui().status, 'on');
  r.set.counts({ needs: 0, running: 3 });
  r.emit.foreground();
  await r.settle();
  assert.deepEqual(r.only('start'), ['start:0/3/running/1900000000/0']);
  const ends = r.only('end').length;
  r.set.counts({ needs: 0, running: 0 });
  r.emit.foreground();
  await r.settle();
  assert.equal(r.only('end').length, ends + 1);
});

test('an unknown count (no computer connected) changes nothing, and a running activity is not started a second time', async () => {
  const r = rig({ counts: null });
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.deepEqual(r.only('start'), []);
  r.set.counts({ needs: 1, running: 0 });
  r.emit.foreground();
  await r.settle();
  r.emit.foreground();
  await r.settle();
  assert.equal(r.only('start').length, 1);
});

test('when iOS has Live Activities off the switch stays on but nothing starts, and the status says so', async () => {
  const r = rig({ allowed: false });
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.equal(r.activity.ui().status, 'blocked');
  assert.deepEqual(r.only('start'), []);
  r.set.allowed(true);
  r.emit.foreground();
  await r.settle();
  assert.equal(r.activity.ui().status, 'on');
  assert.equal(r.only('start').length, 1);
});

test('a start iOS refuses reads as blocked', async () => {
  const r = rig();
  r.set.startResult(false);
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.equal(r.activity.ui().status, 'blocked');
});

test('turning the switch off ends the activity, removes the relay token and tells the widget; a token that arrives later is ignored', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.log.length = 0;
  await r.activity.setEnabled(false);
  assert.equal(r.saved().enabled, false);
  assert.ok(r.log.includes('end'));
  assert.ok(r.log.includes('relay.unregister'));
  assert.ok(r.log.includes('titles:false'));
  assert.equal(r.activity.ui().status, 'off');
  r.emit.token('bb'.repeat(32));
  await r.settle();
  assert.deepEqual(r.only('relay.register'), []);
});

test('chat titles: the widget switch follows the setting only while the activity is on; turning them off strips pushed titles after the widget stopped reading keys', async () => {
  const r = rig();
  await r.activity.start();
  // titles on while the activity is off: the widget still reads off
  await r.activity.setTitles(true);
  assert.equal(r.log.filter((l) => l === 'titles:true').length, 0);
  await r.activity.setEnabled(true);
  assert.ok(r.log.includes('titles:true'));
  r.log.length = 0;
  await r.activity.setTitles(false);
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('titles') || l === 'stripTitles'),
    ['titles:false', 'stripTitles'],
  );
  assert.equal(r.saved().titles, false);
  r.log.length = 0;
  await r.activity.setTitles(true);
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('titles') || l === 'stripTitles'),
    ['titles:true'],
  );
});

test('an activity the person dismissed stays gone until nothing runs or waits; its relay token is removed', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.emit.ended();
  await r.settle();
  assert.ok(r.log.includes('relay.unregister'));
  r.emit.foreground();
  await r.settle();
  assert.equal(r.only('start').length, 1);
  r.set.counts({ needs: 0, running: 0 });
  r.emit.foreground();
  await r.settle();
  r.set.counts({ needs: 2, running: 0 });
  r.emit.foreground();
  await r.settle();
  assert.equal(r.only('start').length, 2);
  // an end with no token held has nothing to tell the relay
  const before = r.only('relay.unregister').length;
  r.emit.ended();
  await r.settle();
  assert.equal(r.only('relay.unregister').length, before);
});

test('signing out ends the activity and removes the relay token; signing back in starts again', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.log.length = 0;
  r.set.signedIn(false);
  r.emit.account();
  await r.settle();
  assert.ok(r.log.includes('end'));
  assert.ok(r.log.includes('relay.unregister'));
  assert.equal(r.activity.ui().status, 'off');
  r.set.signedIn(true);
  r.emit.account();
  await r.settle();
  assert.equal(r.only('start').length, 1);
});

test('forget ends the activity, removes the token and turns the widget switch off', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.log.length = 0;
  await r.activity.forget();
  assert.deepEqual(
    r.log.filter((l) => l === 'end' || l === 'relay.unregister' || l === 'titles:false'),
    ['titles:false', 'end', 'relay.unregister'],
  );
  assert.equal(r.activity.ui().status, 'off');
});

test('a relay that is down is shown as failed and retried at the next reconcile, which registers the token once', async () => {
  const r = rig();
  r.failing.register = true;
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  assert.equal(r.activity.ui().failed, true);
  r.failing.register = false;
  r.set.token('aa'.repeat(32));
  await r.activity.refresh();
  assert.equal(r.activity.ui().failed, false);
  assert.equal(r.only('relay.register').length, 2);
  await r.activity.refresh();
  assert.equal(r.only('relay.register').length, 2);
});

test('chats that cannot be read are a failure, not a decision', async () => {
  const r = rig();
  r.failing.counts = true;
  await r.activity.start();
  await r.activity.setEnabled(true);
  assert.equal(r.activity.ui().failed, true);
  assert.deepEqual(r.only('start'), []);
});

test('changes run one at a time, and a switch flipped during a reconcile ends on the last value', async () => {
  const r = rig();
  await r.activity.start();
  const first = r.activity.setEnabled(true);
  const second = r.activity.setEnabled(false);
  const third = r.activity.setEnabled(true);
  await Promise.all([first, second, third]);
  r.emit.foreground();
  r.emit.account();
  await r.settle();
  assert.equal(r.maxInFlight(), 1);
  assert.equal(r.saved().enabled, true);
  assert.equal(r.activity.ui().status, 'on');
});

test('without the module (Android, the web preview) the switch is kept and reported unsupported, and nothing throws', async () => {
  const r = rig({ native: false });
  await r.activity.start();
  assert.equal(r.activity.ui().status, 'unsupported');
  await r.activity.setEnabled(true);
  await r.activity.setTitles(true);
  assert.equal(r.saved().enabled, true);
  await r.activity.forget();
  await r.activity.refresh();
  assert.equal(r.activity.ui().status, 'unsupported');
  r.emit.foreground();
  await r.settle();
  assert.deepEqual(r.only('relay'), []);
});

test('start is idempotent, stop unsubscribes, and subscribers are told of each change', async () => {
  const r = rig();
  const seen: string[] = [];
  const off = r.activity.subscribe(() => seen.push(r.activity.ui().status));
  await r.activity.start();
  await r.activity.start();
  assert.equal(r.handlers.foreground.size, 1);
  assert.equal(r.handlers.token.size, 1);
  assert.ok(seen.length > 0);
  r.activity.stop();
  assert.equal(r.handlers.foreground.size + r.handlers.account.size + r.handlers.token.size + r.handlers.ended.size, 0);
  const count = seen.length;
  off();
  await r.activity.setEnabled(true);
  assert.equal(seen.length, count);
});

test('an activity the relay or a timeout ended (not the person) may start again with the next run', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.ended(false);
  await r.settle();
  r.emit.foreground();
  await r.settle();
  assert.equal(r.only('start').length, 2);
});

test('the relay may still hold a token after a relaunch: switching off sends the removal even though this process registered none', async () => {
  // the previous run registered a token and the activity was dismissed while the app was dead: nothing runs now
  const r = rig({ prefs: { enabled: true, titles: false }, counts: { needs: 0, running: 0 } });
  await r.activity.start();
  assert.deepEqual(r.only('relay'), []);
  await r.activity.setEnabled(false);
  assert.deepEqual(r.only('relay.unregister'), ['relay.unregister']);
  // once the relay confirmed, later reconciles leave it alone
  r.emit.foreground();
  await r.settle();
  assert.deepEqual(r.only('relay.unregister'), ['relay.unregister']);
});

test('signing out clears the widget switch first and ends the activity even when the relay cannot be reached; the removal is retried', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  r.log.length = 0;
  r.failing.unregister = true;
  await r.activity.forget();
  assert.deepEqual(
    r.log.filter((l) => l === 'titles:false' || l === 'end' || l === 'relay.unregister'),
    ['titles:false', 'end', 'relay.unregister'],
  );
  assert.equal(r.activity.ui().failed, true);
  assert.equal(r.activity.ui().status, 'off');
  r.failing.unregister = false;
  r.set.signedIn(false);
  await r.activity.refresh();
  assert.equal(r.only('relay.unregister').length, 2);
  assert.equal(r.activity.ui().failed, false);
});

test('a token event that arrives after the activity ended is not registered', async () => {
  const r = rig({ counts: { needs: 0, running: 0 } });
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.emit.token('aa'.repeat(32));
  await r.settle();
  assert.deepEqual(r.only('relay.register'), []);
});

test('the widget switch that cannot be written is a failure, not silence', async () => {
  const r = rig();
  await r.activity.start();
  await r.activity.setEnabled(true);
  r.set.titlesOk(false);
  await r.activity.setTitles(true);
  assert.equal(r.activity.ui().failed, true);
  r.set.titlesOk(true);
  await r.activity.setTitles(true);
  assert.equal(r.activity.ui().failed, false);
});

test('a switch flipped while the saved one is still being read is the newer value', async () => {
  const r = rig({ slowRead: true });
  const starting = r.activity.start();
  await r.activity.setEnabled(true);
  await starting;
  assert.equal(r.activity.ui().prefs.enabled, true);
  assert.equal(r.saved().enabled, true);
});
