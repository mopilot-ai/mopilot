// Phone push UI: the explanation card, the hook binding, a tapped notification opening its chat, and push-aware sign-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, toggle } from './support/phone/component-kit';
const appPath = '../mobile/src/MobileApp';
const hookPath = '../mobile/src/push/usePushUi';
const cardPath = '../mobile/src/push/NotificationsCard';
const { MobileApp } = await import(appPath);
const { usePushUi } = await import(hookPath);
const { NotificationsCard } = await import(cardPath);
const settingsPath = '../mobile/src/push/NotificationSettings';
const { NotificationSettings } = await import(settingsPath);

const DEFAULTS = {
  enabled: true,
  sound: true,
  lockScreen: 'show',
  quiet: { on: false, from: '22:00', to: '07:00' },
  liveActivity: false,
  titles: false,
  skipOpenChat: true,
};
function fakePush(initial: any = { step: 'explain', target: null, busy: false, prefs: DEFAULTS }) {
  let ui = initial;
  const listeners = new Set<() => void>();
  const log: string[] = [];
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => void log.push('start'),
    stop: () => void log.push('stop'),
    accept: async () => void log.push('accept'),
    later: async () => void log.push('later'),
    consumeTarget: () => void log.push('consume'),
    setOpenChat: (...a: any[]) => void log.push(`open:${a.join('|')}`),
    sendTest: async () => true,
    signOut: async () => void log.push('signOut'),
  };
  return { push, log, set: (next: any) => ((ui = next), listeners.forEach((f) => f())) };
}
const mount = async (el: any) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  await flush();
  return { host, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
};
const snapshot = (over: any = {}) => ({
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
  ...over,
});
function fakeRuntime(initial: any) {
  let state = initial;
  // the app root and each screen that reads the outbox subscribe on their own
  const subs = new Set<() => void>();
  return {
    set: (next: any) => ((state = next), subs.forEach((f) => f())),
    runtime: {
      snapshot: () => state,
      subscribe: (f: any) => (subs.add(f), () => void subs.delete(f)),
      start: async () => {},
      onEvent: () => () => {},
      signOut: async () => void (globalThis as any).__signedOut++,
      request: async () => ({
        chats: [
          { id: 'c1', title: 'First' },
          { id: 'c7', title: 'Seventh' },
        ],
      }),
    } as any,
  };
}

test('the card explains before anything is asked, offers two choices, and renders nothing in other steps', async () => {
  const rig = fakePush();
  const view = await mount(createElement(NotificationsCard, { push: rig.push, step: 'explain', busy: false }));
  assert.match(view.host.textContent!, /Know when a chat needs you/);
  assert.match(view.host.textContent!, /never what a chat wrote/);
  await click('Turn on notifications');
  await click('Not now');
  assert.deepEqual(rig.log, ['accept', 'later']);
  await view.unmount();
  const busy = await mount(createElement(NotificationsCard, { push: rig.push, step: 'explain', busy: true }));
  assert.match(busy.host.textContent!, /Asking…/);
  await busy.unmount();
  const blocked = await mount(createElement(NotificationsCard, { push: rig.push, step: 'blocked', busy: false }));
  assert.match(blocked.host.textContent!, /for MoPilot in your phone's settings/);
  assert.doesNotMatch(blocked.host.textContent!, /Turn on notifications/);
  await blocked.unmount();
  for (const step of ['granted', 'later', 'unknown']) {
    const none = await mount(createElement(NotificationsCard, { push: rig.push, step, busy: false }));
    assert.equal(none.host.textContent, '');
    await none.unmount();
  }
});

test('the hook follows the controller, starts it once and stops it on unmount; without a controller it is idle', async () => {
  const rig = fakePush();
  const seen: string[] = [];
  const Probe = ({ push }: any) => (seen.push(usePushUi(push).step), null);
  const view = await mount(createElement(Probe, { push: rig.push }));
  await act(async () => rig.set({ step: 'granted', target: null, busy: false }));
  assert.deepEqual(rig.log, ['start']);
  assert.equal(seen.at(-1), 'granted');
  await view.unmount();
  assert.deepEqual(rig.log, ['start', 'stop']);
  const idle = await mount(createElement(Probe, { push: undefined }));
  assert.equal(seen.at(-1), 'unknown');
  await idle.unmount();
  const failing = fakePush();
  failing.push.start = async () => {
    throw new Error('boom');
  };
  const bad = await mount(createElement(Probe, { push: failing.push }));
  await bad.unmount();
});

test('the app shows the card only when signed in, opens the chat a notification named once online, and signs out through push', async () => {
  (globalThis as any).__signedOut = 0;
  const rig = fakePush();
  const rt = fakeRuntime(snapshot({ phase: 'offline', selectedPair: null }));
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: rig.push }));
  // pairing and connecting come first: the card waits for a connected computer
  assert.doesNotMatch(view.host.textContent!, /Know when a chat needs you/);
  await act(async () => rt.set(snapshot()));
  await flush();
  assert.match(view.host.textContent!, /Know when a chat needs you/);
  await act(async () => rt.set(snapshot({ phase: 'offline', selectedPair: null })));
  await flush();
  await act(async () => rig.set({ step: 'explain', busy: false, target: { pairId: 'p', chatId: 'c7' } }));
  assert.equal(rig.log.includes('consume'), false, 'not consumed until the computer is online');
  await act(async () => rt.set(snapshot()));
  await flush();
  assert.ok(rig.log.includes('consume'));
  assert.doesNotMatch(view.host.textContent!, /Connected/, 'the tapped chat is open, not the list');
  await act(async () => rt.set(snapshot({ phase: 'offline', selectedPair: null })));
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  assert.deepEqual(
    rig.log.filter((l) => l === 'signOut'),
    ['signOut'],
  );
  assert.equal((globalThis as any).__signedOut, 0);
  await view.unmount();
  const out = fakeRuntime(snapshot({ phase: 'signedOut', user: null, selectedPair: null, pairs: [] }));
  const signedOut = await mount(createElement(MobileApp, { runtime: out.runtime, push: fakePush().push }));
  assert.doesNotMatch(signedOut.host.textContent!, /Know when a chat needs you/);
  await signedOut.unmount();
});

test('a tapped pair-only target (computer offline notice) is consumed without opening a chat, and without push the app is unchanged', async () => {
  (globalThis as any).__signedOut = 0;
  const rig = fakePush({ step: 'granted', busy: false, target: { pairId: 'p' }, prefs: DEFAULTS });
  const rt = fakeRuntime(snapshot());
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: rig.push }));
  await flush();
  assert.ok(rig.log.includes('consume'));
  assert.ok(view.host.querySelector('button[aria-label="Open menu"]'), 'still on Chats');
  await view.unmount();
  const plain = await mount(createElement(MobileApp, { runtime: rt.runtime }));
  assert.doesNotMatch(plain.host.textContent!, /Know when a chat needs you/);
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  assert.equal((globalThis as any).__signedOut, 1);
  await plain.unmount();
});

test('settings: iOS offers the shared switches, Android also sound, detail and quiet hours with validated times', async () => {
  const calls: any[] = [];
  const push: any = { setPrefs: async (p: any) => void calls.push(p) };
  const prefs = { ...DEFAULTS, quiet: { on: true, from: '22:00', to: '07:00' } };
  (globalThis as any).__phonePlatform = 'ios';
  const ios = await mount(createElement(NotificationSettings, { push, prefs }));
  assert.equal(toggle('Alerts'), 'On');
  assert.match(ios.host.textContent!, /Focus/);
  assert.doesNotMatch(ios.host.textContent!, /Sound|Quiet/);
  await click('Alerts');
  await ios.unmount();
  (globalThis as any).__phonePlatform = 'android';
  const android = await mount(createElement(NotificationSettings, { push, prefs }));
  await click('Sound');
  await click('Quiet hours');
  await click('Lock screen detail: Show');
  assert.deepEqual(calls, [{ enabled: false }, { sound: false }, { quiet: { on: false } }, { lockScreen: 'private' }]);
  await inputText('From (HH:MM)', '23:15');
  await inputText('To (HH:MM)', '6am');
  await inputText('To (HH:MM)', '06:45');
  assert.deepEqual(calls.slice(4), [{ quiet: { from: '23:15' } }, { quiet: { to: '06:45' } }]);
  await android.unmount();
  const hidden = await mount(createElement(NotificationSettings, { push, prefs: { ...prefs, lockScreen: 'hide' } }));
  await click('Lock screen detail: Hide');
  assert.deepEqual(calls.at(-1), { lockScreen: 'show' });
  await hidden.unmount();
  const off = await mount(createElement(NotificationSettings, { push, prefs: { ...prefs, enabled: false } }));
  assert.equal(toggle('Alerts'), 'Off');
  assert.doesNotMatch(off.host.textContent!, /Sound/);
  await off.unmount();
  const noQuiet = await mount(createElement(NotificationSettings, { push, prefs: { ...prefs, quiet: { ...prefs.quiet, on: false } } }));
  assert.doesNotMatch(noQuiet.host.textContent!, /Silent from/);
  await noQuiet.unmount();
  (globalThis as any).__phonePlatform = undefined;
});

test('the app shows the settings card only for a signed-in user with permission granted', async () => {
  const granted = fakePush({
    step: 'granted',
    target: null,
    busy: false,
    prefs: DEFAULTS,
  });
  const rt = fakeRuntime(snapshot({ phase: 'offline', selectedPair: null }));
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: granted.push }));
  assert.notEqual(toggle('Alerts'), 'On', 'the toggles live in Settings');
  await click('Settings');
  assert.notEqual(toggle('Alerts'), 'On', 'and one level down, on the Notifications page');
  assert.match(view.host.textContent!, /Notifications/);
  await click('Notifications');
  assert.equal(toggle('Alerts'), 'On');
  await click('Back');
  assert.notEqual(toggle('Alerts'), 'On', 'Back returns to Settings');
  await view.unmount();
  const explain = await mount(createElement(MobileApp, { runtime: rt.runtime, push: fakePush().push }));
  await click('Settings');
  assert.doesNotMatch(explain.host.textContent!, /Alerts: /);
  await explain.unmount();
});

test('a tapped notification takes the person out of Settings and into the chat it names', async () => {
  const rig = fakePush({ step: 'granted', busy: false, target: null, prefs: DEFAULTS });
  const rt = fakeRuntime(snapshot({ phase: 'offline', selectedPair: null }));
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: rig.push }));
  await click('Settings');
  assert.match(view.host.textContent!, /MoPilot account/);
  await act(async () => rt.set(snapshot()));
  await act(async () => rig.set({ step: 'granted', busy: false, prefs: DEFAULTS, target: { pairId: 'p', chatId: 'c7' } }));
  await flush();
  assert.ok(rig.log.includes('consume'));
  assert.doesNotMatch(view.host.textContent!, /MoPilot account/, 'Settings is closed');
  assert.doesNotMatch(view.host.textContent!, /Connected/, 'the chat is open');
  assert.equal(rig.log.at(-1), 'open:p|c7', 'the push controller is told which chat is on screen');
  await view.unmount();
  assert.equal(rig.log.at(-1), 'open:|', 'and that none is once the screen goes');
});

test('settings: the time fields follow the stored values when they change underneath', async () => {
  const push: any = { setPrefs: async () => {} };
  const prefs = { ...DEFAULTS, quiet: { on: true, from: '22:00', to: '07:00' } };
  (globalThis as any).__phonePlatform = 'android';
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(NotificationSettings, { push, prefs })));
  const values = () => [...host.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value);
  assert.deepEqual(values(), ['22:00', '07:00']);
  await act(async () =>
    root.render(createElement(NotificationSettings, { push, prefs: { ...prefs, quiet: { on: true, from: '21:30', to: '06:10' } } })),
  );
  assert.deepEqual(values(), ['21:30', '06:10']);
  await act(async () => root.unmount());
  host.remove();
  (globalThis as any).__phonePlatform = undefined;
});

test('a reply typed into a notification opens the chat with the text as a draft after any existing draft, and sends nothing', async () => {
  const rt = fakeRuntime(snapshot());
  const sent: any[] = [];
  rt.runtime.request = async (method: string, params: any) => {
    sent.push(method);
    if (method === 'chats.recent') return { chats: [{ id: 'c7', title: 'Seventh' }] };
    if (method === 'chat.follow')
      return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'items', history: [], items: [] };
    return {};
  };
  const rig = fakePush({ step: 'granted', busy: false, target: null, prefs: DEFAULTS });
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: rig.push }));
  await act(async () => rig.set({ step: 'granted', busy: false, prefs: DEFAULTS, target: { pairId: 'p', chatId: 'c7', draft: 'first' } }));
  await flush();
  const drafts = () => [...document.querySelectorAll('input,textarea')].map((i) => (i as HTMLInputElement).value);
  assert.ok(drafts().includes('first'), 'the chat shows the reply as its draft');
  assert.ok(rig.log.includes('consume'));
  await act(async () => rig.set({ step: 'granted', busy: false, prefs: DEFAULTS, target: { pairId: 'p', chatId: 'c7', draft: 'second' } }));
  await flush();
  // the DOM input stub drops the newline between the two lines
  assert.ok(drafts().includes('firstsecond'), 'a second reply goes after the first');
  assert.equal(
    sent.some((m) => m === 'chat.send'),
    false,
    'nothing is sent',
  );
  await view.unmount();
});

test('the app shows the notice for a reply that could not be kept', async () => {
  const rig = fakePush({
    step: 'granted',
    busy: false,
    target: null,
    prefs: DEFAULTS,
    notice: 'Could not find that chat, so your reply was not kept.',
  });
  const rt = fakeRuntime(snapshot({ phase: 'offline', selectedPair: null }));
  const view = await mount(createElement(MobileApp, { runtime: rt.runtime, push: rig.push }));
  assert.match(view.host.textContent!, /reply was not kept/);
  await view.unmount();
});

test('settings: the token line says registered, waiting or not available in this build, and only while notifications are on', async () => {
  const push: any = { setPrefs: async () => {} };
  const prefs = DEFAULTS;
  for (const [token, line] of [
    ['registered', /Registered/],
    ['waiting', /Waiting for a device token/],
    ['unavailable', /Not available in this build/],
  ] as const) {
    const view = await mount(createElement(NotificationSettings, { push, prefs, token }));
    assert.match(view.host.textContent!, line);
    await view.unmount();
  }
  const none = await mount(createElement(NotificationSettings, { push, prefs, token: null }));
  assert.doesNotMatch(none.host.textContent!, /Registered|Waiting for|Not available/);
  await none.unmount();
  const off = await mount(createElement(NotificationSettings, { push, prefs: { ...prefs, enabled: false }, token: 'unavailable' }));
  assert.doesNotMatch(off.host.textContent!, /Not available/, 'nothing to say about a token nobody wants');
  await off.unmount();
});
