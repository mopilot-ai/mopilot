// Settings pages on the phone: the Notifications page's switches and test button, the opt-in preview, an offline Mac's connection check with its report, and Appearance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer, toggle } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const g = globalThis as any;
const appPath = '../mobile/src/MobileApp';
const settingsPath = '../mobile/src/push/NotificationSettings';
const cardPath = '../mobile/src/push/NotificationsCard';
const diagPath = '../mobile/src/diagnostics';
const appearancePath = '../mobile/src/appearance';
const { MobileApp } = await import(appPath);
const { NotificationSettings } = await import(settingsPath);
const pagesPath = '../mobile/src/screens/SettingsPages';
const { PrivacyPage } = await import(pagesPath);
const { NotificationsCard } = await import(cardPath);
const { checkSteps, checkReport } = await import(diagPath);
const { createAppearance, parseAppearance, APPEARANCES } = await import(appearancePath);

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
  g.__phoneShared = [];
  g.__phoneShareFails = false;
});

test('the Notifications page: titles and the open-chat policy switch on this phone, and Live Activity is not drawn until the build has one', async () => {
  const calls: any[] = [];
  const push: any = { setPrefs: async (p: any) => void calls.push(p), sendTest: async () => true };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null }));
  assert.equal(toggle('Chat titles on the lock screen'), 'Off');
  assert.match(host.textContent!, /only this phone can read them/);
  assert.equal(toggle('Skip alerts for the chat I have open'), 'On');
  assert.doesNotMatch(host.textContent!, /Live Activity/, 'the activity does not exist yet, so its switch is not offered');
  await click('Chat titles on the lock screen');
  await click('Skip alerts for the chat I have open');
  assert.deepEqual(calls, [{ titles: true }, { skipOpenChat: false }]);
  assert.match(host.textContent!, /say only "A chat needs you"/, 'the fixed title is named on the page');
  assert.match(host.textContent!, /Allow and Deny from a notification ask for Face ID or your passcode/);
});

test('no static copy on the phone names MoMo, so a phone of an account without it reads nothing of it', async () => {
  const push: any = {
    setPrefs: async () => undefined,
    sendTest: async () => true,
  };
  const notifications = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null }));
  assert.doesNotMatch(notifications.textContent!, /MoMo/);
  const privacy = await mount(createElement(PrivacyPage, { back: () => undefined }));
  assert.doesNotMatch(privacy.textContent!, /MoMo/);
  assert.match(privacy.textContent!, /seal a chat title that only\s+this phone can read|seal a chat title that only this phone can read/);
});

test('the Live Activity switch, once the build offers it, is off by default and carries its one-line promise', async () => {
  const calls: any[] = [];
  const push: any = { setPrefs: async (p: any) => void calls.push(p) };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null, liveActivityAvailable: true }));
  assert.equal(toggle('Live Activity'), 'Off');
  assert.match(host.textContent!, /Shows how many chats need you\. Chat titles stay hidden unless you turn them on below\./);
  await click('Live Activity');
  assert.deepEqual(calls, [{ liveActivity: true }]);
  const on = await mount(
    createElement(NotificationSettings, { push, prefs: { ...PREFS, liveActivity: true }, token: null, liveActivityAvailable: true }),
  );
  assert.equal(toggle('Live Activity', on), 'On');
});

test('the test notification says whether it was shown, starts over on each press, and is unavailable while alerts are off', async () => {
  let ok = true;
  const answers: Array<(v: boolean) => void> = [];
  const push: any = {
    setPrefs: async () => {},
    sendTest: () => (ok ? Promise.resolve(true) : new Promise<boolean>((resolve) => answers.push(resolve))),
  };
  const host = await mount(createElement(NotificationSettings, { push, prefs: PREFS, token: null }));
  assert.doesNotMatch(host.textContent!, /Sent\./);
  await click('Send a test notification');
  assert.match(host.textContent!, /Sent\. This is how a notification looks on this phone\./);
  ok = false;
  await click('Send a test notification');
  assert.doesNotMatch(host.textContent!, /Sent\./, 'the earlier answer is cleared while the next one is awaited');
  await act(async () => answers[0](false));
  assert.match(host.textContent!, /Could not show a notification/);
  const off = await mount(createElement(NotificationSettings, { push, prefs: { ...PREFS, enabled: false }, token: null }));
  const button = [...off.querySelectorAll('button')].find((b) => b.textContent === 'Send a test notification') as HTMLButtonElement;
  assert.equal(button.disabled, true);
});

test('the opt-in card previews the real, fixed title before it asks, and the blocked card does not', async () => {
  const push: any = { accept: async () => {}, later: async () => {} };
  const host = await mount(createElement(NotificationsCard, { push, step: 'explain', busy: false }));
  assert.ok(host.querySelector('[aria-label="Example notification: A chat needs you"]'), 'the example uses the title a real one carries');
  assert.match(host.textContent!, /MoPilot · now/);
  assert.match(host.textContent!, /never appear in a notification/);
  assert.match(host.textContent!, /Not now/, 'declining is as easy to reach as accepting');
  const blocked = await mount(createElement(NotificationsCard, { push, step: 'blocked', busy: false }));
  assert.doesNotMatch(blocked.textContent!, /MoPilot · now/);
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: { p1: { state: 'online', lastSeen: 1 } },
};
const at = 1_000_000;
const pushUi = (over: any = {}) => ({ step: 'granted', token: 'registered', ...over });

test('Check connection names each step with a problem or a wait, never a secret', () => {
  const steps = (state: any, push: any = null) => checkSteps({ ...online, pendingPair: false, ...state }, push, at);
  const states = (list: any[]) => list.map((s) => `${s.name}:${s.state}`);
  assert.deepEqual(states(steps({})), [
    'Signed in:ok',
    'Computer paired:ok',
    'Reached the relay:ok',
    'Computer is awake:ok',
    'Connected:ok',
  ]);
  const signedOut = steps({ user: null, pairs: [], selectedPair: null, phase: 'signedOut', presence: {} });
  assert.deepEqual(states(signedOut), [
    'Signed in:bad',
    'Computer paired:bad',
    'Reached the relay:wait',
    'Computer is awake:wait',
    'Connected:bad',
  ]);
  assert.equal(steps({ phase: 'error', presence: {} })[2].state, 'bad', 'an errored connection is a relay problem');
  const asleep = steps({ phase: 'offline', presence: { p1: { state: 'sleeping', lastSeen: at - 120_000 } } });
  assert.equal(asleep[2].state, 'ok', 'the relay answered about the computer');
  assert.match(asleep[3].note, /^Asleep · last seen .* ago\. Is it awake and signed in\?$/);
  const unnamed = steps({ selectedPair: null, presence: { p1: { state: 'gone', lastSeen: null } } });
  assert.match(unnamed[3].note, /^Not reachable\. Is it awake/, 'with no pair selected the first one is checked');
  const notif = (ui: any) => steps({}, ui).at(-1);
  assert.deepEqual(notif(pushUi({ token: 'registered' })), { name: 'Notifications', state: 'ok' });
  assert.equal(notif(pushUi({ token: 'waiting' })).state, 'wait');
  assert.equal(notif(pushUi({ token: null })).state, 'wait');
  assert.match(notif(pushUi({ token: 'unavailable' })).note, /Not available in this build/);
  assert.match(notif(pushUi({ step: 'blocked' })).note, /phone's settings/);
  assert.equal(notif(pushUi({ step: 'later' })).state, 'na');
  assert.equal(
    steps({}, null).some((s: any) => s.name === 'Notifications'),
    false,
    'a build without push has no such step',
  );
});

test('the report holds the steps, their notes and the version, and nothing the person or the computer called anything', () => {
  const report = checkReport(
    checkSteps({ ...online, phase: 'offline', presence: { p1: { state: 'sleeping', lastSeen: at - 60_000 } } }, pushUi(), at),
    '1.2.3',
  );
  assert.match(report, /^MoPilot connection check \(1\.2\.3\)\n✓ Signed in\n/);
  assert.match(report, /✗ Computer is awake — Asleep · last seen/);
  assert.doesNotMatch(report, /Studio Mac|Dana|p1|m1/, 'no name, id or pair appears');
  assert.match(checkReport([{ name: 'Signed in', state: 'ok' }]), /^MoPilot connection check\n/);
});

async function openSettings(snap: any, props: any = {}) {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), snap);
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, version: '9.9.9', ...props }));
  await click('Settings');
  return host;
}

test('Settings › an offline Mac shows the connection check as its detail, shares the report only when asked, and goes back', async () => {
  const host = await openSettings({ ...online, phase: 'offline' });
  assert.doesNotMatch(host.textContent!, /Notifications/, 'no push wiring, no Notifications row');
  await openComputer();
  assert.match(host.textContent!, /Connection check/);
  assert.match(host.textContent!, /✓Signed in/);
  assert.match(host.textContent!, /✗ConnectedNot connected\. Connect it under Computers\./);
  assert.match(host.textContent!, /no codes, keys, names or chat text/);
  assert.deepEqual(g.__phoneShared ?? [], [], 'nothing leaves the phone before the person chooses');
  await click('Share report');
  assert.match(g.__phoneShared[0], /^MoPilot connection check \(9\.9\.9\)\n✓ Signed in/);
  assert.doesNotMatch(host.textContent!, /could not be shared/);
  g.__phoneShareFails = true;
  await click('Share report');
  assert.match(host.textContent!, /The report could not be shared\./);
  g.__phoneShareFails = false;
  await click('Share report');
  assert.doesNotMatch(host.textContent!, /could not be shared/, 'a new attempt clears the old failure');
  await click('Back');
  assert.match(host.textContent!, /MoPilot account/);
});

test('with push wired the step for notifications is part of the check', async () => {
  const push: any = {
    ui: () => ({ step: 'blocked', target: null, busy: false, notice: null, prefs: PREFS, token: null }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const host = await openSettings({ ...online, phase: 'offline' }, { push });
  await openComputer();
  assert.match(host.textContent!, /✗NotificationsOff in your phone's settings\./);
});

test('appearance: only System, Light and Dark; an unreadable choice is System; the choice is applied and kept', async () => {
  assert.deepEqual([...APPEARANCES], ['system', 'light', 'dark']);
  assert.equal(parseAppearance('dark'), 'dark');
  assert.equal(parseAppearance('sepia'), 'system');
  assert.equal(parseAppearance(null), 'system');
  const applied: Array<string | null> = [];
  const stored: { value: string | null; failRead: boolean; failWrite: boolean } = { value: 'dark', failRead: false, failWrite: false };
  const control = createAppearance({
    store: {
      read: async () => {
        if (stored.failRead) throw new Error('keychain locked');
        return stored.value;
      },
      write: async (v: string) => {
        if (stored.failWrite) throw new Error('full');
        stored.value = v;
      },
    },
    apply: (scheme: string | null) => void applied.push(scheme),
  });
  assert.equal(await control.read(), 'dark');
  assert.deepEqual(applied, ['dark']);
  await control.set('system');
  assert.deepEqual([stored.value, applied.at(-1)], ['system', null], 'System hands the choice back to the phone');
  await control.set('light');
  assert.deepEqual([stored.value, applied.at(-1)], ['light', 'light']);
  stored.failWrite = true;
  await assert.rejects(control.set('dark'), /full/);
  assert.equal(applied.at(-1), 'light', 'a choice that was not kept is not applied');
  stored.failRead = true;
  assert.equal(await control.read(), 'system');
});

test('Settings › Appearance cycles System, Light, Dark and shows the saved choice; a refused save puts the old one back', async () => {
  const set: string[] = [];
  const control = {
    fail: false,
    read: async () => 'light',
    set: async (v: string) => (set.push(v), control.fail && Promise.reject(new Error('full'))),
  };
  const host = await openSettings({ ...online, phase: 'offline' }, { appearance: control });
  assert.match(host.textContent!, /AppearanceLight/);
  await click('Appearance, Light');
  assert.ok(document.querySelector('button[aria-label="Light"][aria-selected="true"]'), 'the saved choice is checked');
  await click('Dark');
  await click('System');
  await click('Back');
  assert.match(host.textContent!, /AppearanceSystem/);
  await click('Appearance, System');
  control.fail = true;
  await click('Light');
  await click('Back');
  assert.match(host.textContent!, /AppearanceSystem/, 'back to what is stored');
  assert.deepEqual(set, ['dark', 'system', 'light']);
  const without = await openSettings({ ...online, phase: 'offline' });
  assert.doesNotMatch(without.textContent!, /Appearance/);
});

test('Settings summarises the page row with the Live Activity only when the build has one, and the page follows a permission that goes away', async () => {
  const settingsScreen = '../mobile/src/screens/Settings';
  const { Settings } = await import(settingsScreen);
  let ui: any = { step: 'granted', target: null, busy: false, notice: null, prefs: { ...PREFS, liveActivity: true }, token: null };
  const listeners = new Set<() => void>();
  const push: any = { setPrefs: async () => {}, sendTest: async () => true };
  const runtime: any = scripted(() => undefined, { ...online, phase: 'online' }).runtime;
  const render = (props: any) =>
    createElement(Settings, {
      runtime,
      state: { ...online, phase: 'online' },
      push,
      pushUi: ui,
      busy: false,
      error: null,
      pair: () => {},
      connect: () => {},
      remove: () => {},
      signOut: () => {},
      ...props,
    });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(render({ liveActivityAvailable: true })));
  assert.match(host.textContent!, /On · Live Activity on/);
  await act(async () => root.render(render({ liveActivityAvailable: true, pushUi: { ...ui, prefs: { ...PREFS, enabled: false } } })));
  assert.match(host.textContent!, /Off · Live Activity off/);
  await act(async () => root.render(render({})));
  assert.doesNotMatch(host.textContent!, /Live Activity/, 'this build has no activity, so the summary does not mention one');
  await click('Notifications');
  assert.equal(toggle('Alerts'), 'On');
  ui = { ...ui, step: 'blocked' };
  await act(async () => root.render(render({})));
  assert.match(host.textContent!, /Notifications are off\. Turn them on for MoPilot in your phone's settings/);
  assert.doesNotMatch(host.textContent!, /Alerts: /);
  void listeners;
});

test('a choice made while the saved appearance is still being read is not undone by it', async () => {
  let release!: (v: string) => void;
  const set: string[] = [];
  const control = {
    read: () => new Promise<string>((resolve) => (release = resolve)),
    set: async (v: string) => void set.push(v),
  };
  const host = await openSettings({ ...online, phase: 'offline' }, { appearance: control });
  await click('Appearance, System');
  await click('Light');
  await act(async () => release('dark'));
  await click('Back');
  assert.match(host.textContent!, /AppearanceLight/, 'the tap stands');
  assert.deepEqual(set, ['light']);
});

test('Settings › a Mac that went to sleep reads Asleep, and its page says how to keep it reachable', async () => {
  const [pair] = (online as any).pairs;
  const host = await openSettings({ ...online, phase: 'offline', presence: { [pair.pairId]: { state: 'sleeping', lastSeen: 1 } } });
  assert.match(host.textContent!, /Asleep/);
  await openComputer();
  assert.match(host.textContent!, /turn on Keep running in the menu bar in Settings › Connections/);
});

// Mobile Remote left the closed alpha: an account the service lists no invites for is any other account
const noInviteApp = async (snap: any) => {
  const r = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), snap);
  r.runtime.start = async () => {};
  r.runtime.subscribe = () => () => {};
  r.runtime.features = async () => [];
  const host = await mount(createElement(MobileApp, { runtime: r.runtime, version: '9.9.9' }));
  await flush();
  return host;
};

test('an account with no invites gets Home as anyone does: a way to add a computer, never "not available"', async () => {
  const noComputer = { ...online, phase: 'ready', pairs: [], selectedPair: null, presence: {} };
  const home = await noInviteApp({ ...noComputer, user: { id: 'u', email: 'ann@example.com' } });
  assert.match(home.textContent!, /Add a computer/);
  assert.doesNotMatch(home.textContent!, /isn't available for/);
});

test('a listed computer that is away reads offline, not "not available for this account"', async () => {
  const host = await noInviteApp({ ...online, phase: 'offline', selectedPair: null, presence: {} });
  await click('Settings');
  assert.match(host.textContent!, /Offline/);
  assert.doesNotMatch(host.textContent!, /Not available for this account/);
});
