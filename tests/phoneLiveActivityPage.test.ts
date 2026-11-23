// The Notifications page's Live Activity switch with the app's activity behind it: it turns the activity itself on and off, says when iOS or a failure keeps it from running, and is drawn only where the build has the module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, toggle } from './support/phone/component-kit';

const settingsPath = '../mobile/src/push/NotificationSettings';
const availablePath = '../mobile/src/push/liveActivity.ts';
const { NotificationSettings } = await import(settingsPath);

const PREFS = {
  enabled: true,
  sound: true,
  lockScreen: 'show',
  quiet: { on: false, from: '22:00', to: '07:00' },
  liveActivity: false,
  titles: false,
  skipOpenChat: true,
};
const mounted: any[] = [];
async function mount(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(el));
  await flush();
  return host;
}
test.afterEach(async () => {
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
});

function fakeActivity(initial: Partial<{ enabled: boolean; status: string; failed: boolean }> = {}) {
  let ui: any = {
    prefs: { enabled: initial.enabled ?? false, titles: false },
    status: initial.status ?? 'off',
    failed: initial.failed ?? false,
  };
  const listeners = new Set<() => void>();
  const calls: boolean[] = [];
  return {
    activity: {
      ui: () => ui,
      subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
      setEnabled: async (on: boolean) => void calls.push(on),
    } as any,
    calls,
    set: (next: any) => {
      ui = { ...ui, ...next };
      listeners.forEach((l) => l());
    },
  };
}

test('the switch turns the activity itself on and off, not only a saved copy', async () => {
  const a = fakeActivity();
  const prefsCalls: any[] = [];
  const push: any = { setPrefs: async (p: any) => void prefsCalls.push(p), liveActivity: a.activity };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null, liveActivityAvailable: true }));
  assert.equal(toggle('Live Activity'), 'Off');
  assert.match(host.textContent!, /Shows how many chats need you\. Chat titles stay hidden unless you turn them on below\./);
  await click('Live Activity');
  assert.deepEqual(a.calls, [true]);
  assert.deepEqual(prefsCalls, [], 'the saved copy follows the activity, it is not written by the button');
  await act(async () => a.set({ prefs: { enabled: true, titles: false }, status: 'on' }));
  assert.equal(toggle('Live Activity'), 'On');
  await click('Live Activity');
  assert.deepEqual(a.calls, [true, false]);
});

test('iOS having Live Activities off for the app, and a failed update, are said in one line each', async () => {
  const a = fakeActivity({ enabled: true, status: 'blocked' });
  const push: any = { setPrefs: async () => {}, liveActivity: a.activity };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null, liveActivityAvailable: true }));
  assert.match(host.textContent!, /Live Activities are off for MoPilot in your phone's settings\./);
  assert.doesNotMatch(host.textContent!, /Could not update/);
  await act(async () => a.set({ failed: true, status: 'on' }));
  assert.match(host.textContent!, /Could not update the Live Activity\. It will try again\./);
  assert.doesNotMatch(host.textContent!, /Live Activities are off/);
});

test('without the module in the build the switch is not drawn, even when the push controller has an activity', async () => {
  const a = fakeActivity();
  const push: any = { setPrefs: async () => {}, liveActivity: a.activity };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null, liveActivityAvailable: false }));
  assert.doesNotMatch(host.textContent!, /Live Activity/);
});

test('the page offers the switch only where the iOS module is linked', async () => {
  const g = globalThis as any;
  delete g.expo;
  const none = await import(`${availablePath}?none`);
  assert.equal(none.LIVE_ACTIVITY_AVAILABLE, false);
  g.expo = { modules: { MoPilotLiveActivity: {} } };
  const linked = await import(`${availablePath}?linked`);
  assert.equal(linked.LIVE_ACTIVITY_AVAILABLE, true);
  delete g.expo;
});
