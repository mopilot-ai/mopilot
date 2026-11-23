// The Settings sheet: account, computers, the app's rows and Sign out, reached from the home list and closed again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer, openScanner } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [
    { pairId: 'p1', macId: 'm1', name: 'Studio Mac' },
    { pairId: 'p2', macId: 'm2', name: 'Laptop' },
  ],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};
const mounted: any[] = [];
async function mount(snap: any, props: any = {}) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), snap);
  const listeners = new Set<() => void>();
  s.runtime.start = async () => {};
  s.runtime.signOut = async () => {
    s.state.snap = { ...s.state.snap, user: null, phase: 'signedOut', pairs: [] };
    listeners.forEach((f) => f());
  };
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const calls: string[] = [];
  s.runtime.connect = async (id: string) => void calls.push(`connect:${id}`);
  s.runtime.unpair = async (id: string) => void calls.push(`unpair:${id}`);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, ...props })));
  await flush();
  return { host, calls, s, listeners };
}

test('Settings opens from the home list, shows the account, each computer and About, and Back returns to the list', async () => {
  const { host } = await mount(online, { version: '1.2.3' });
  assert.doesNotMatch(host.textContent!, /Sign out/, 'the home list has no account controls');
  await click('Settings');
  const text = host.textContent!;
  assert.match(text, /Dana.*MoPilot account/);
  assert.match(text, /Studio Mac.*Connected/);
  assert.match(text, /Laptop.*Offline/);
  assert.doesNotMatch(text, /Notifications/, 'no push wiring, no notifications row');
  await click('About');
  assert.match(host.textContent!, /MoPilotVersion 1\.2\.3/);
  await click('Back');
  await click('Close');
  assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home', 'back at the list');
});

test('About names the app without a version when none is given', async () => {
  const { host } = await mount(online);
  await click('Settings');
  await click('About');
  assert.doesNotMatch(host.textContent!, /Version/);
  await click('Back');
  await click('Privacy');
  assert.match(host.textContent!, /end-to-end encrypted/);
});

test('connecting, removing and pairing a computer from Settings go through the runtime', async () => {
  const { host, calls } = await mount({ ...online, phase: 'offline', selectedPair: null });
  await click('Settings');
  await openComputer();
  await click('Connect');
  assert.deepEqual(calls, ['connect:p1']);
  await click('Remove computer');
  await click('Remove');
  assert.deepEqual(calls, ['connect:p1', 'unpair:p1']);
  await click('Add a computer');
  await openScanner();
  assert.match(host.textContent!, /Scan the code on your computer/);
  assert.ok(host.querySelector('button[aria-label="Paste code instead"]'), 'the pairing screen opened, not Settings');
});

test('signing out from Settings returns to a signed-out home', async () => {
  const { host } = await mount(online);
  await click('Settings');
  await click('Sign out');
  assert.doesNotMatch(host.textContent!, /Sign in/, 'one tap only asks');
  await click('Cancel');
  assert.ok(host.textContent!.includes('Sign out'), 'Cancel keeps the account signed in');
  await click('Sign out');
  await click('Confirm sign out');
  assert.match(host.textContent!, /Sign in/);
  assert.doesNotMatch(host.textContent!, /MoPilot account/);
});

test("Settings has one community row that opens the site's Discord link in the system browser, and a link that cannot open is quiet", async () => {
  const g = globalThis as any;
  g.__openedUrls = [];
  const { host } = await mount(online);
  await click('Settings');
  assert.match(host.textContent!, /Join the community.*Questions, feedback and other users, on Discord\./);
  await click('Join the community');
  assert.deepEqual(g.__openedUrls, ['https://mopilot.ai/discord'], 'the site redirect, never the invite itself');
  g.__linkFails = true;
  await click('Join the community');
  g.__linkFails = false;
  assert.equal(g.__openedUrls.length, 2);
  assert.match(host.textContent!, /Join the community/, 'still on Settings, no error');
});

test('the Account page has its own Sign out: one tap asks, Cancel keeps the account, Confirm leaves it', async () => {
  const { host } = await mount(online);
  await click('Settings');
  await click('Dana');
  assert.match(host.textContent!, /Account/);
  await click('Sign out');
  assert.doesNotMatch(host.textContent!, /Sign in/, 'one tap only asks');
  await click('Cancel');
  assert.ok(host.textContent!.includes('Sign out'), 'Cancel keeps the account signed in');
  await click('Sign out');
  await click('Confirm sign out');
  assert.match(host.textContent!, /Sign in/);
  assert.doesNotMatch(host.textContent!, /MoPilot account/);
});

test('while another action is running, the Account page neither asks nor confirms a sign-out', async () => {
  const pagesPath = '../mobile/src/screens/SettingsPages';
  const { AccountPage } = await import(pagesPath);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let signedOut = 0;
  const render = (busy: boolean) =>
    act(async () =>
      root.render(
        createElement(AccountPage, {
          state: online,
          busy,
          back: () => {},
          deleteAccount: async () => {},
          signOut: () => void signedOut++,
        }),
      ),
    );
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  await render(true);
  assert.equal(button('Sign out'), undefined, 'busy: there is nothing to tap, so not even the question');
  await render(false);
  await click('Sign out');
  await render(true);
  assert.equal(button('Confirm sign out'), undefined, 'busy: the confirmation cannot be tapped');
  assert.equal(signedOut, 0);
  await render(false);
  await click('Confirm sign out');
  assert.equal(signedOut, 1);
  await act(async () => root.unmount());
  host.remove();
});

test('a signed-out phone has no Settings', async () => {
  const { host } = await mount({ ...online, user: null, phase: 'signedOut', pairs: [], selectedPair: null });
  assert.ok(![...host.querySelectorAll('button')].some((b) => b.textContent === 'Settings'));
  assert.ok(host.querySelector('button[aria-label="Sign in"]'));
});

test('with push wired, Settings carries the notification section and an error from an action', async () => {
  const push: any = {
    ui: () => ({ step: 'blocked', target: null, busy: false, notice: 'Push is paused', prefs: {} }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const { host } = await mount(online, { push });
  await click('Settings');
  await click('Notifications, Off');
  assert.match(host.textContent!, /Push is paused/);
  assert.match(host.textContent!, /Notifications are off/);
});

test('Settings opens while a pairing waits for confirmation, and a swipe back returns to that pairing', async () => {
  const { host } = await mount({ ...online, phase: 'ready', selectedPair: null, pendingPair: true, safetyNumber: '123456' });
  await click('Settings');
  assert.match(host.textContent!, /MoPilot account/);
  await click('Swipe back');
  assert.match(host.textContent!, /Confirm on your computer/, 'back at the pairing');
  await click('Check the number');
  assert.match(host.textContent!, /123 456/);
});

test('Settings does not outlive its account: signing out and in again, or another account, starts at the home list', async () => {
  const { host, s, listeners } = await mount(online);
  await click('Settings');
  assert.match(host.textContent!, /MoPilot account/);
  s.state.snap = { ...online, user: null, phase: 'signedOut', pairs: [] };
  await act(async () => listeners.forEach((f) => f()));
  s.state.snap = { ...online, user: { id: 'other', name: 'Sam' } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.doesNotMatch(host.textContent!, /MoPilot account/);
  assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home', 'back at the list');
});

test('opening Settings clears a stale error from an earlier action', async () => {
  const { host, s } = await mount({ ...online, phase: 'offline', selectedPair: null });
  s.runtime.connect = async () => {
    throw new Error('Computer is offline');
  };
  await click('Settings');
  await openComputer();
  await click('Connect');
  assert.match(host.textContent!, /offline or asleep/, 'the reason shows on the Mac’s page');
  await click('Back');
  await click('Close');
  assert.doesNotMatch(host.textContent!, /offline or asleep/, 'and never on the home page while the Mac is away');
  await click('Settings');
  assert.doesNotMatch(host.textContent!, /offline or asleep/);
});

const pushWith = (ui: any) => {
  const calls: string[] = [];
  const push: any = {
    ui: () => ({ target: null, busy: false, notice: null, prefs: {}, ...ui }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    signOut: async () => {},
    accept: async () => void calls.push('accept'),
  };
  return { push, calls };
};

test('after Not now, Settings still offers to turn notifications on; with nothing to show it has no Notifications section', async () => {
  const later = pushWith({ step: 'later' });
  const { host } = await mount({ ...online, phase: 'offline', selectedPair: null }, { push: later.push });
  await click('Settings');
  await click('Notifications, Off');
  assert.match(host.textContent!, /Notifications are off/);
  await click('Turn on notifications');
  assert.deepEqual(later.calls, ['accept']);
  const none = pushWith({ step: 'unknown' });
  const bare = await mount({ ...online, phase: 'offline', selectedPair: null }, { push: none.push });
  await click('Settings');
  await click('Notifications, Off');
  assert.doesNotMatch(bare.host.textContent!, /Notifications are off|Turn on/, 'nothing to offer before the permission is read');
});

test('the permission prompt is on the home list only, and a blocked state is explained in Settings only', async () => {
  const explain = pushWith({ step: 'explain' });
  const home = await mount(online, { push: explain.push });
  assert.match(home.host.textContent!, /Know when a chat needs you/);
  const blocked = pushWith({ step: 'blocked' });
  const quiet = await mount({ ...online, phase: 'offline', selectedPair: null }, { push: blocked.push });
  assert.doesNotMatch(quiet.host.textContent!, /Notifications are off/);
  await click('Settings');
  await click('Notifications, Off');
  assert.match(quiet.host.textContent!, /Notifications are off/);
});

test('Settings offers pairing when no computer is paired, and shows a busy permission request', async () => {
  const none = await mount({ ...online, phase: 'ready', pairs: [], selectedPair: null });
  await click('Settings');
  // Pairing remains available independently of the account and app settings that follow it.
  assert.match(none.host.textContent!, /Computers\+Add a computer/);
  assert.doesNotMatch(none.host.textContent!, /Studio Mac|Laptop/, 'there are no saved computer rows');
  assert.ok(none.host.querySelector('button[aria-label="Add a computer"]'), 'pairing is still actionable');
  assert.ok(none.host.querySelector('button[aria-label="Usage"]'), 'the separate usage entry remains available');
  const busy = pushWith({ step: 'later', busy: true });
  const { host } = await mount({ ...online, phase: 'offline', selectedPair: null }, { push: busy.push });
  await click('Settings');
  await click('Notifications, Off');
  assert.match(host.textContent!, /Asking…/);
  const asking = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Asking…') as HTMLButtonElement;
  assert.equal(asking.disabled, true);
});

test('Settings keeps its way back when the connection fails under it, so there is always a way out', async () => {
  const { host, s, listeners } = await mount(online);
  await click('Settings');
  assert.match(host.textContent!, /MoPilot account/);
  for (const phase of ['error', 'pairing', 'loading']) {
    s.state.snap = { ...online, phase, error: 'Could not connect' };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
    assert.ok(host.querySelector('button[aria-label="Close"]'), `the way back stays in phase ${phase}`);
  }
  await click('Close');
  assert.doesNotMatch(host.textContent!, /Sign out/);
});
