// electron/main.cjs wiring of the notification quiet hours: the app notifier reads the saved pref and keeps what waited in the user data folder, and a prefs change makes it look at the clock again.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
const ready = async (cfg: any = {}) => {
  const h = await loadMain(cfg);
  await h.ready();
  return h;
};

test('the notifier is given the saved quiet hours, a file for what waits, and the power monitor', async () => {
  const h = await ready({ state: { prefs: { notifyQuietHours: { start: '23:00', end: '06:00' } } } });
  const notify = calls(h.mod('platform/notify.cjs').registerNotify)[0][1];
  assert.deepEqual(notify.getQuietHours(), { start: '23:00', end: '06:00' });
  assert.match(notify.quietFile, /notify-quiet\.json$/);
  assert.ok(notify.powerMonitor, 'so a Mac that slept says what waited when it wakes');
});

test('quiet hours are none until the prefs hold some', async () => {
  const h = await ready({ state: { prefs: {} } });
  assert.equal(calls(h.mod('platform/notify.cjs').registerNotify)[0][1].getQuietHours(), null);
  const bare = await ready({ state: null });
  assert.equal(calls(bare.mod('platform/notify.cjs').registerNotify)[0][1].getQuietHours(), null);
});

test('a prefs change makes the notifier look at the quiet hours again', async () => {
  const h = await ready({ state: { prefs: {} } });
  const { onPrefs } = calls(h.mod('platform/chats.cjs').registerChats)[0][1];
  const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
  const looked = notifier.quietChanged.mock.callCount();
  onPrefs({ notifyQuietHours: null });
  assert.equal(notifier.quietChanged.mock.callCount(), looked + 1);
});
