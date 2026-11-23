// Settings → Built-in tools → Computer use.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, settingsExports, render, click, byText, type, press, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ threads: { t1: { title: 'Fix login' }, t2: {} } });
let st: any = null;
let changed: (() => void) | null = null;
/** Methods whose request fails, with the error they fail with. */
const failing: Record<string, Error> = {};
const answer = async (name: string, value: unknown) => {
  if (failing[name]) throw failing[name];
  return value;
};

stubStore({
  useStore: store.useStore,
  threadTitle: (t: any) => t?.title ?? '',
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
});
installNativeStub({
  computer: {
    status: async () => {
      calls.push(['status']);
      if (st instanceof Error) throw st;
      return st;
    },
    onChanged: (cb: () => void) => ((changed = cb), () => calls.push(['off'])),
    openSettings: (k: string) => answer('openSettings', calls.push(['openSettings', k])),
    requestPermission: (k: string) => answer('requestPermission', calls.push(['request', k])),
    revoke: (chat: string | null, id: string) => answer('revoke', calls.push(['revoke', chat, id])),
    revokeAll: () => answer('revokeAll', calls.push(['revokeAll'])),
    revokeOnMachine: (m: string, chat: string | null, id: string) => answer('revokeOnMachine', calls.push(['revokeOn', m, chat, id])),
    revokeAllOnMachine: (m: string) => answer('revokeAllOnMachine', calls.push(['revokeAllOn', m])),
    setDeny: (list: string[]) => answer('setDeny', calls.push(['deny', list])),
    setBriefForeground: (on: boolean) => answer('setBriefForeground', calls.push(['brief', on])),
    setCodexNativeComputer: (on: boolean) => answer('setCodexNativeComputer', calls.push(['codexNative', on])),
  },
});
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
// the shared native-control status has its own tests (nativeAvailabilityUI)
mock.module('../src/components/pages/settings/NativeControlStatus.tsx', { namedExports: { NativeControlStatus: () => null } });
const { ComputerUseSettings, engineText } = await import('../src/components/pages/settings/ComputerUse.tsx');
const { createRequire } = await import('node:module');
const { computerHealth } = createRequire(import.meta.url)('../electron/capabilities/capabilityHealth.cjs');
const HELPER = '/repo/native/helper/build/MoPilot.app';
/** The health record main sends with the status (capabilityHealth.cjs), for a helper in this state. */
const healthOf = (helper: any, permissions: any) =>
  computerHealth({
    enabled: true,
    helper: { path: HELPER, installed: true, packaged: false, platform: 'darwin', running: false, version: null, error: null, ...helper },
    permissions,
  });

const status = (over: any = {}) => ({
  enabled: true,
  permissions: { accessibility: true, screenRecording: true, inputMonitoring: true },
  helper: { running: false, error: null, version: null },
  grants: { global: [], chats: [] },
  deny: { builtIn: [], user: [] },
  ...over,
});
const rowDesc = (host: HTMLElement, title: string) => host.querySelector(`[data-row="${title}"] i`)?.textContent;

test('nothing until the status loads, a failed load says so with Retry, and disabled says unavailable', async () => {
  st = new Error('no helper');
  const v = await render(h(ComputerUseSettings));
  await flush();
  const alert = () => v.host.querySelector('[role="alert"]')?.textContent;
  assert.equal(alert(), "Couldn't read the computer use status: no helper Retry", 'a failed read is not a blank page');
  st = status({ enabled: false });
  calls.length = 0;
  await click(byText(v.host, 'Retry'));
  await flush();
  assert.deepEqual(calls, [['status']]);
  assert.equal(v.host.textContent, 'Computer use is unavailable.');
  // a later read that fails keeps the status shown, with the failure over it
  st = new Error('helper restarting');
  await act(async () => changed!());
  await flush();
  assert.equal(v.host.textContent, "Couldn't read the computer use status: helper restarting RetryComputer use is unavailable.");
  st = status({ enabled: false });
  await act(async () => changed!());
  await flush();
  assert.equal(v.host.textContent, 'Computer use is unavailable.');

  calls.length = 0;
  await v.unmount();
  assert.deepEqual(calls, [['off']]);
});

test('all allowed: no guide, empty grant lists and the engine state; focus and changes reload', async () => {
  st = status({ helper: { running: true, error: null, version: '1.2.3' } });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(v.host.querySelector('.cu-guide'), null);
  assert.equal(v.host.querySelectorAll('.status-pill').length, 4);
  assert.equal(v.host.querySelectorAll('[data-row="No apps yet"]').length, 2);
  assert.equal(rowDesc(v.host, 'MoPilot Computer Use'), 'Running');
  assert.equal(v.host.querySelector('[data-row="MoPilot Computer Use"] .status-pill')!.textContent, '1.2.3');
  calls.length = 0;
  await act(async () => window.dispatchEvent(new (window as any).Event('focus')));
  await flush();
  assert.deepEqual(calls, [['status']]);
  st = status();
  await act(async () => changed!());
  await flush();
  assert.equal(rowDesc(v.host, 'MoPilot Computer Use'), 'Starts when an agent first uses it');
  assert.equal(v.host.querySelector('[data-row="MoPilot Computer Use"] .status-pill')!.textContent, '—');
  await v.unmount();
  calls.length = 0;
  await act(async () => window.dispatchEvent(new (window as any).Event('focus')));
  assert.deepEqual(calls, [], 'no reload after unmount');
});

test('missing permissions: the guide opens the first required one; each row requests or opens settings', async () => {
  const permissions = { accessibility: true, screenRecording: false, inputMonitoring: false };
  st = status({ permissions, health: healthOf({ running: true }, permissions) });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(
    v.host.querySelector('.cu-guide-text')!.textContent,
    'Allow Screen Recording for MoPilot in System Settings. Agents can only control apps you approve.',
  );
  calls.length = 0;
  await click(byText(v.host.querySelector('.cu-guide')!, 'Open System Settings'));
  await click(v.host.querySelector('[aria-label="Request Input Monitoring permission"]'));
  await click(v.host.querySelector('[aria-label="Open System Settings for Screen Recording"]'));
  assert.deepEqual(calls, [
    ['openSettings', 'screenRecording'],
    ['request', 'inputMonitoring'],
    ['status'],
    ['openSettings', 'screenRecording'],
  ]);
  await v.unmount();
});

test('Input Monitoring alone is optional: no guide, and its row still offers the request', async () => {
  const permissions = { accessibility: true, screenRecording: true, inputMonitoring: false };
  st = status({ permissions, health: healthOf({ running: true }, permissions) });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(v.host.querySelector('.cu-guide'), null);
  assert.ok(v.host.querySelector('[aria-label="Request Input Monitoring permission"]'));
  assert.equal(rowDesc(v.host, 'Input Monitoring'), 'Optional: pause when you take over.');
  await v.unmount();
});

test('a helper that could not start: the guide says so with Try again; unknown permissions are not shown as missing', async () => {
  st = status({
    permissions: null,
    helper: { running: false, error: 'signature invalid', version: null, path: HELPER },
    health: healthOf({ error: 'signature invalid' }, null),
  });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(v.host.querySelector('.cu-guide-text')!.textContent, 'Computer use couldn’t start. Try again.');
  // nothing to request without the helper; each pane still opens (main opens it without the helper)
  assert.equal(v.host.querySelectorAll('[aria-label^="Request "]').length, 0);
  assert.equal(v.host.querySelectorAll('.status-pill.unknown').length, 3);
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Open System Settings for Accessibility"]'));
  await click(byText(v.host.querySelector('.cu-guide')!, 'Try again'));
  await flush();
  assert.deepEqual(calls, [['openSettings', 'accessibility'], ['status']]);
  assert.equal(rowDesc(v.host, 'MoPilot Computer Use'), 'Computer use couldn’t start. Try again.');
  await v.unmount();
});

test('a helper that is not there: the guide explains the build limitation without developer diagnostics', async () => {
  st = status({
    permissions: null,
    helper: { running: false, error: null, version: null, path: HELPER },
    health: healthOf({ installed: false }, null),
  });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(v.host.querySelector('.cu-guide-text')!.textContent, 'Computer use isn’t available in this build.');
  assert.equal(v.host.querySelector('.cu-guide button'), null);
  // the engine row shares the mapped reason and omits the diagnostic path
  assert.equal(rowDesc(v.host, 'MoPilot Computer Use'), 'Computer use isn’t available in this build.');
  assert.doesNotMatch(v.host.textContent!, /build-helper|native\/helper\/build/);
  await v.unmount();
});

test('the engine row: safe running, first-use and unavailable copy without the helper path', () => {
  const base = status();
  assert.equal(engineText({ ...base, helper: { running: true, error: null, version: '1', path: HELPER } }), 'Running');
  assert.equal(engineText({ ...base, health: healthOf({}, null) }), 'Starts when an agent first uses it');
  const ready = { accessibility: true, screenRecording: true, inputMonitoring: true };
  assert.equal(engineText({ ...base, health: healthOf({}, ready) }), 'Starts when an agent first uses it');
  assert.equal(
    engineText({ ...base, health: { ...healthOf({ error: 'x' }, null), reason: null } }),
    'Computer use couldn’t start. Try again.',
  );
});

test('grants list per app with their level and chat, and remove revokes them', async () => {
  st = status({
    grants: {
      global: [{ bundleId: 'com.a', name: 'App A', level: 'full' }],
      chats: [
        { chatId: 't1', grants: [{ bundleId: 'com.b', name: 'App B', level: 'view' }] },
        { chatId: 't9', grants: [{ bundleId: 'com.c', name: 'App C', level: 'custom' }] },
        { chatId: 't2', grants: [{ bundleId: 'com.d', name: 'App D', level: 'click' }] },
      ],
    },
  });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(rowDesc(v.host, 'App A'), 'Full control');
  assert.equal(rowDesc(v.host, 'App B'), 'View only · Fix login');
  assert.equal(rowDesc(v.host, 'App C'), 'custom · t9');
  assert.equal(rowDesc(v.host, 'App D'), 'Click · t2');
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Remove App A"]'));
  await click(v.host.querySelector('[aria-label="Remove App B"]'));
  assert.deepEqual(calls, [['revoke', null, 'com.a'], ['status'], ['revoke', 't1', 'com.b'], ['status']]);
  await v.unmount();
});

test('what was approved on a machine is its own group, under its name, apart from this Mac’s lists, and Remove acts on that machine', async () => {
  st = status({
    machines: [
      {
        id: 'h1',
        name: 'box',
        global: [{ bundleId: 'com.a', name: 'App A', level: 'click' }],
        chats: [
          { chatId: 't1', grants: [{ bundleId: 'com.b', name: 'App B', level: 'view' }] },
          { chatId: 't2', grants: [{ bundleId: 'com.e', name: 'App E', level: 'full' }] },
        ],
      },
    ],
  });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(rowDesc(v.host, 'App A'), 'Click · always');
  assert.equal(rowDesc(v.host, 'App B'), 'View only · Fix login');
  assert.equal(rowDesc(v.host, 'App E'), 'Full control · t2', 'a chat with no title shows its id');
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Remove App B"]'));
  await click(v.host.querySelector('[aria-label="Remove App A"]'));
  await click(byText(v.host, 'Remove all'));
  assert.deepEqual(
    calls.filter((c) => c[0] !== 'status'),
    [
      ['revokeOn', 'h1', 't1', 'com.b'],
      ['revokeOn', 'h1', null, 'com.a'],
      ['revokeAllOn', 'h1'],
    ],
  );
  await v.unmount();
});

test('blocked apps: built-in ones are locked, yours can be removed, and a typed bundle ID is added on Enter', async () => {
  st = status({ deny: { builtIn: [{ pattern: 'com.apple.keychain*', reason: 'Passwords' }], user: ['com.x', 'com.y'] } });
  const v = await render(h(ComputerUseSettings));
  await flush();
  assert.equal(rowDesc(v.host, 'Passwords'), 'com.apple.keychain*');
  assert.equal(v.host.querySelector('[data-row="com.x"]')!.getAttribute('data-mono'), 'true');
  calls.length = 0;
  await click(byText(v.host.querySelector('[data-row="com.x"]')!, 'Remove'));
  assert.deepEqual(calls, [['deny', ['com.y']], ['status']]);
  const input = v.host.querySelector('[aria-label="Bundle ID to block"]') as HTMLInputElement;
  calls.length = 0;
  await type(input, '   ');
  await press(input, 'Enter');
  assert.deepEqual(calls, [], 'blank is ignored');
  await type(input, ' com.z ');
  await press(input, 'x');
  assert.deepEqual(calls, []);
  await press(input, 'Enter');
  assert.deepEqual(calls, [['deny', ['com.x', 'com.y', 'com.z']], ['status']]);
  assert.equal(input.value, '');
  await v.unmount();
});

test('background control: brief switching is on unless saved off, and the switch saves the other value', async () => {
  const title = "Allow brief switching to the app when background control doesn't work";
  st = status();
  const v = await render(h(ComputerUseSettings));
  await flush();
  const sw = () => v.host.querySelector(`[data-row="${title}"] [role="switch"]`)!;
  assert.equal(sw().getAttribute('aria-checked'), 'true');
  calls.length = 0;
  st = status({ briefForeground: false });
  await click(sw());
  assert.deepEqual(calls, [['brief', false], ['status']]);
  assert.equal(sw().getAttribute('aria-checked'), 'false');
  calls.length = 0;
  await click(sw());
  assert.deepEqual(calls, [['brief', true], ['status']]);
  await v.unmount();
});

test('Codex Computer Use is off unless chosen (#1381): the switch saves the choice and the status is read again', async () => {
  const title = 'Use Codex Computer Use in Codex chats';
  st = status();
  const v = await render(h(ComputerUseSettings));
  await flush();
  const row = () => v.host.querySelector(`[data-row="${title}"]`)!;
  assert.equal(row().querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'false');
  assert.match(row().textContent ?? '', /Off: MoPilot’s computer use, which is faster\. For new chats\./);
  calls.length = 0;
  st = status({ codexNativeComputer: true });
  await click(row().querySelector('[role="switch"]')!);
  assert.deepEqual(calls, [['codexNative', true], ['status']]);
  assert.equal(row().querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'true');
  // a failed save says so
  failing.setCodexNativeComputer = new Error('refused');
  calls.length = 0;
  await click(row().querySelector('[role="switch"]')!);
  assert.ok(calls.some((c) => c[0] === 'toast' && /Couldn't change Codex computer use/.test(String(c[1]))));
  delete failing.setCodexNativeComputer;
  await v.unmount();
});

test('a change that fails says so, the status is read again, and a bundle ID that was not blocked stays typed', async () => {
  st = status({
    permissions: { accessibility: false, screenRecording: true, inputMonitoring: true },
    grants: { global: [{ bundleId: 'com.a', name: 'App A', level: 'full' }], chats: [] },
    deny: { builtIn: [], user: ['com.x'] },
  });
  const v = await render(h(ComputerUseSettings));
  await flush();
  for (const name of ['openSettings', 'requestPermission', 'revoke', 'revokeAll', 'setDeny', 'setBriefForeground'])
    failing[name] = new Error(`${name} refused`);
  try {
    calls.length = 0;
    await click(v.host.querySelector('[aria-label="Open System Settings for Accessibility"]'));
    await flush();
    assert.deepEqual(calls, [
      ['openSettings', 'accessibility'],
      ['toast', "Couldn't open System Settings: openSettings refused", 'error'],
    ]);
    calls.length = 0;
    await click(v.host.querySelector('[aria-label="Request Accessibility permission"]'));
    await click(v.host.querySelector('[aria-label="Remove App A"]'));
    await click(byText(v.host, 'Remove all'));
    await click(byText(v.host.querySelector('[data-row="com.x"]')!, 'Remove'));
    await click(v.host.querySelector('[role="switch"]'));
    await flush();
    // an app still allowed must not look removed: each failure is said, and the status is read again
    assert.deepEqual(calls, [
      ['request', 'accessibility'],
      ['toast', "Couldn't request the permission: requestPermission refused", 'error'],
      ['status'],
      ['revoke', null, 'com.a'],
      ['toast', "Couldn't remove App A: revoke refused", 'error'],
      ['status'],
      ['revokeAll'],
      ['toast', "Couldn't remove the always-allowed apps: revokeAll refused", 'error'],
      ['status'],
      ['deny', []],
      ['toast', "Couldn't unblock com.x: setDeny refused", 'error'],
      ['status'],
      ['brief', false],
      ['toast', "Couldn't change brief switching: setBriefForeground refused", 'error'],
      ['status'],
    ]);
    const input = v.host.querySelector('[aria-label="Bundle ID to block"]') as HTMLInputElement;
    await type(input, 'com.z');
    calls.length = 0;
    await press(input, 'Enter');
    await flush();
    assert.deepEqual(calls, [['deny', ['com.x', 'com.z']], ['toast', "Couldn't block com.z: setDeny refused", 'error'], ['status']]);
    assert.equal(input.value, 'com.z', 'kept for another try');
  } finally {
    for (const name of Object.keys(failing)) delete failing[name];
    await v.unmount();
  }
});

test("System Settings that the helper didn't open says so, and a bundle ID typed while blocking another stays", async () => {
  st = status({ permissions: { accessibility: false, screenRecording: true, inputMonitoring: true }, deny: { builtIn: [], user: [] } });
  const v = await render(h(ComputerUseSettings));
  await flush();
  const { native } = await import('../src/lib/native.ts');
  const computer = native.computer as any;
  const real = { openSettings: computer.openSettings, setDeny: computer.setDeny };
  try {
    // main answers false when the helper couldn't open the pane
    computer.openSettings = async (k: string) => (calls.push(['openSettings', k]), false);
    calls.length = 0;
    await click(v.host.querySelector('[aria-label="Open System Settings for Accessibility"]'));
    await flush();
    assert.deepEqual(calls, [
      ['openSettings', 'accessibility'],
      ['toast', "Couldn't open System Settings: the computer use helper did not open it", 'error'],
    ]);
    let blocked!: () => void;
    computer.setDeny = (list: string[]) => ((calls as unknown[]).push(['deny', list]), new Promise<void>((r) => (blocked = r)));
    const input = v.host.querySelector('[aria-label="Bundle ID to block"]') as HTMLInputElement;
    await type(input, 'com.z');
    await press(input, 'Enter');
    await type(input, 'com.next');
    await act(async () => blocked());
    await flush();
    assert.equal(input.value, 'com.next', 'what was typed meanwhile stays');
  } finally {
    Object.assign(computer, real);
    await v.unmount();
  }
});

test('a Request that leaves the permission off says so on its row with the next step; the newest Request wins', async () => {
  // macOS keeps a stale grant for an older helper build: no prompt shows and the permission stays off
  const permissions = { accessibility: true, screenRecording: false, inputMonitoring: false };
  st = status({ permissions });
  const v = await render(h(ComputerUseSettings));
  await flush();
  const { native } = await import('../src/lib/native.ts');
  const computer = native.computer as any;
  const real = computer.requestPermission;
  const hint = (title: string) => v.host.querySelector(`[data-row="${title}"] .cu-permission-still`);
  const STILL_OFF =
    'macOS still reports Screen Recording unavailable to "MoPilot". Already on? It may still belong to an older copy of "MoPilot": in Screen Recording, select "MoPilot", remove it with −, add it again with +, then try again. If access is still unavailable, restart your Mac before trying again.';
  try {
    const answers: ((granted: boolean) => void)[] = [];
    computer.requestPermission = (k: string) => (calls.push(['request', k]), new Promise<boolean>((r) => answers.push(r)));
    assert.equal(hint('Screen Recording'), null, 'nothing to explain before the user acts');
    // Input Monitoring's answer comes after Screen Recording's: only the newest Request's outcome shows
    await click(v.host.querySelector('[aria-label="Request Input Monitoring permission"]'));
    await click(v.host.querySelector('[aria-label="Request Screen Recording permission"]'));
    await act(async () => answers[1](false));
    await flush();
    assert.equal(hint('Screen Recording')!.textContent, STILL_OFF);
    assert.equal(hint('Screen Recording')!.getAttribute('role'), 'status');
    assert.equal(rowDesc(v.host, 'Screen Recording'), `See your screen. ${STILL_OFF}`);
    await act(async () => answers[0](false));
    await flush();
    assert.equal(hint('Input Monitoring'), null, 'an older Request does not replace the newest one');
    assert.ok(hint('Screen Recording'));
    // the helper stopped (permissions unknown): no claim that it is off
    st = status({ permissions: null });
    await act(async () => changed!());
    await flush();
    assert.equal(hint('Screen Recording'), null);
    // granted meanwhile in System Settings: the row says Allowed, with no hint
    st = status({ permissions: { ...permissions, screenRecording: true } });
    await act(async () => changed!());
    await flush();
    assert.equal(hint('Screen Recording'), null);
    assert.equal(rowDesc(v.host, 'Screen Recording'), 'See your screen.');
    // a Request that turns the permission on shows no hint
    st = status({ permissions });
    await act(async () => changed!());
    await flush();
    assert.ok(hint('Screen Recording'));
    await click(v.host.querySelector('[aria-label="Request Screen Recording permission"]'));
    assert.equal(hint('Screen Recording'), null, 'the old answer goes while the Request runs');
    await act(async () => answers[2](true));
    await flush();
    assert.equal(hint('Screen Recording'), null);
  } finally {
    computer.requestPermission = real;
    await v.unmount();
  }
});
