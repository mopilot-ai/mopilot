// Connect your phone, the dialog every entry opens: sign-in and the opt-in when they are missing, the QR up at once with a code to copy, one Connect / Decline prompt, You're connected, and what happens to a QR nobody scans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, responses, resetCtl, render, click, text, button, flush, calls } from './support/settings-harness.ts';
await setup();
const { createElement: h } = await import('react');
const { ConnectPhoneDialog, MAX_RENEWALS } = await import('../src/components/pages/settings/ConnectPhone.tsx');
const { openConnectPhone, closeConnectPhone, isConnectPhoneOpen } = await import('../src/lib/phoneEntry.ts');
await import('../src/lib/native/remoteSettings.ts');

const base = {
  visible: true,
  signedIn: true,
  account: 'ann@example.com',
  enabled: true,
  running: true,
  locked: false,
  pairing: null,
  devices: [] as any[],
};
const count = (name: string) => calls.filter((c) => c[0] === name).length;

async function dialog(state: () => any) {
  responses['remoteSettings.state'] = state;
  responses['remoteSettings.cancel'] ??= true;
  const v = await render(h(ConnectPhoneDialog));
  openConnectPhone();
  await flush(50);
  return v;
}
test.beforeEach(() => resetCtl());
test.afterEach(() => closeConnectPhone());

test('closed it asks nothing; open, the QR is up at once with who is signed in and a code that copies', async () => {
  responses['remoteSettings.state'] = () => assert.fail('a closed dialog reads nothing');
  const closed = await render(h(ConnectPhoneDialog));
  assert.equal(text(closed.host), '');
  await closed.unmount();
  let state: any = base;
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'pair payload', expiresAt: 42 } };
    return state.pairing;
  };
  const v = await dialog(() => state);
  await flush(1100);
  await flush(100);
  assert.equal(count('remoteSettings.begin'), 1);
  assert.ok(v.host.querySelector('img[alt="Pairing QR code"]'));
  assert.match(text(v.host), /Scan with MoPilot on your phone/);
  assert.match(text(v.host), /Signed in as ann@example\.com/);
  assert.ok(button(v.host, "Don't have the app?"), 'getting the phone app sits under the pairing QR, folded');
  responses['clipboard.write'] = true;
  await click(button(v.host, 'Copy code'));
  assert.deepEqual(
    calls.find((c) => c[0] === 'clipboard.write'),
    ['clipboard.write', 'pair payload'],
  );
  await v.unmount();
  assert.equal(count('remoteSettings.cancel'), 1, 'leaving ends the pairing');
});

test('signed out it offers sign-in; connecting is the consent, so the code follows with no second click (#5320)', async () => {
  let state: any = { ...base, signedIn: false, account: null, enabled: false, running: false };
  const v = await dialog(() => state);
  responses['mopilot.signIn'] = () => {
    state = { ...state, signedIn: true };
    return { ok: true };
  };
  responses['remoteSettings.setEnabled'] = (on: boolean) => {
    state = { ...state, enabled: on, running: on };
    return true;
  };
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'q' } };
    return state.pairing;
  };
  assert.equal(count('remoteSettings.setEnabled'), 0, 'nothing is switched on before anyone is signed in');
  await click(button(v.host, 'Sign in to MoPilot'));
  await flush(1100);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'remoteSettings.setEnabled'),
    [['remoteSettings.setEnabled', true]],
  );
  await flush(1100);
  assert.equal(count('remoteSettings.begin'), 1);
  assert.match(text(v.host), /Only connect devices you own/);
  assert.equal(
    [...v.host.querySelectorAll('button')].some((b) => /Allow & show code|Later/.test(b.textContent ?? '')),
    false,
    'no separate consent step',
  );
  await v.unmount();
  closeConnectPhone();

  responses['mopilot.signIn'] = () => ({ ok: false, error: 'The browser was closed' });
  const refused = await dialog(() => ({ ...base, signedIn: false, enabled: false, running: false }));
  await click(button(refused.host, 'Sign in to MoPilot'));
  assert.match(text(refused.host), /The browser was closed/);
  await refused.unmount();
  closeConnectPhone();

  // a Mac that cannot be switched on says why and tries again on Try again
  resetCtl();
  let tries = 0;
  responses['remoteSettings.setEnabled'] = () => {
    if (++tries === 1) throw new Error('Settings are locked');
    return true;
  };
  const failing = await dialog(() => ({ ...base, enabled: false, running: false }));
  await flush(50);
  assert.match(text(failing.host), /Settings are locked/);
  assert.equal(tries, 1, 'one try, not a loop');
  await click(button(failing.host, 'Try again'));
  assert.equal(tries, 2);
  await failing.unmount();
});

test('after the scan: one prompt with the phone name, Connect and Decline, the number small beside it; then You’re connected', async () => {
  let state: any = { ...base, pairing: { state: 'confirming', device: 'Ann’s iPhone', safetyNumber: '12345678901234567890' } };
  responses['remoteSettings.begin'] = () => state.pairing;
  responses['remoteSettings.answer'] = (allow: boolean) => {
    state = { ...state, pairing: { state: allow ? 'finishing' : 'declined' } };
    return true;
  };
  const v = await dialog(() => state);
  assert.match(text(v.host), /Connect Ann’s iPhone\?/);
  assert.match(text(v.host), /Same number on the phone: 1234 5678 9012 3456 7890/);
  const detail = v.host.querySelector('details')!;
  assert.equal(detail.querySelector('summary')!.textContent, 'Safety number');
  assert.equal(detail.open, false, 'the number is a detail, not the main thing');
  responses['alwaysOn.get'] = {
    prefs: { keepRunning: false, loginItem: false, preventSleep: false, offered: false },
    loginItemSupported: true,
  };
  responses['alwaysOn.set'] = {
    prefs: { keepRunning: true, loginItem: true, preventSleep: true, offered: true },
    loginItemSupported: true,
  };
  await click(button(v.host, 'Connect'));
  assert.deepEqual(calls.filter((c) => c[0] === 'remoteSettings.answer').at(-1), ['remoteSettings.answer', true]);
  assert.match(text(v.host), /Connecting…/);
  state = { ...state, pairing: { state: 'paired' } };
  await flush(1100);
  await flush(50);
  assert.equal(text(v.host), '', 'it closes by itself: no Done');
  assert.ok(calls.some((c) => c[0] === 'toast' && /^Connected: Ann’s iPhone\./.test(String(c[1]))));
  assert.equal(calls.filter((c) => c[0] === 'alwaysOn.set').length, 1);
  assert.equal(count('remoteSettings.begin'), 0, 'no new QR behind it');
  await v.unmount();
  closeConnectPhone();
  state = { ...base, pairing: { state: 'confirming', device: '', safetyNumber: null } };
  const nameless = await dialog(() => state);
  await flush(1100);
  assert.match(text(nameless.host), /Connect this phone\?/);
  responses['remoteSettings.answer'] = true;
  await click(button(nameless.host, 'Decline'));
  assert.deepEqual(calls.filter((c) => c[0] === 'remoteSettings.answer').at(-1), ['remoteSettings.answer', false]);
  await nameless.unmount();
});

test('a lapsed QR is replaced by itself, until nobody seems to be scanning; a failure waits for Try again', async () => {
  let state: any = { ...base, pairing: { state: 'expired', qr: null } };
  const begin = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'next' } };
    return state.pairing;
  };
  responses['remoteSettings.begin'] = begin;
  const v = await dialog(() => state);
  for (let i = 0; i < MAX_RENEWALS + 1; i++) {
    state = { ...state, pairing: { state: 'expired', qr: null } };
    await flush(1100);
    await flush(20);
  }
  assert.equal(count('remoteSettings.begin'), MAX_RENEWALS, 'it stopped renewing');
  assert.match(text(v.host), /The code timed out\./);
  await click(button(v.host, 'Show code'));
  assert.equal(count('remoteSettings.begin'), MAX_RENEWALS + 1);
  state = { ...state, pairing: { state: 'failed', qr: null } };
  await flush(1100);
  const before = count('remoteSettings.begin');
  await flush(1100);
  assert.equal(count('remoteSettings.begin'), before, 'failed does not loop');
  assert.match(text(v.host), /Couldn't pair that phone/);
  await click(button(v.host, 'Try again'));
  assert.equal(count('remoteSettings.begin'), before + 1);
  await v.unmount();
});

test('a pairing open in another window offers to show it here, and starts nothing by itself', async () => {
  let state: any = { ...base, pairing: { state: 'elsewhere', qr: null } };
  const v = await dialog(() => state);
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'mine' } };
    return state.pairing;
  };
  await flush(1100);
  assert.equal(count('remoteSettings.begin'), 0);
  assert.match(text(v.host), /Pairing is open in another window/);
  await click(button(v.host, 'Show here'));
  assert.equal(count('remoteSettings.begin'), 1);
  await v.unmount();
});

test('starting, storage recovery, failures and an account that lost access are one short line each', async () => {
  const show = async (state: any) => {
    const v = await dialog(() => state);
    await flush(1100);
    const t = text(v.host);
    await v.unmount();
    closeConnectPhone();
    return t;
  };
  assert.match(await show({ ...base, running: false }), /Starting…/);
  assert.match(await show({ ...base, locked: true }), /Phone storage needs recovery/);
  assert.equal(count('remoteSettings.begin'), 0, 'no pairing while storage is locked');
  assert.match(await show({ ...base, pairing: { state: 'uncertain', qr: null } }), /Phone storage needs recovery/);
  assert.match(await show({ ...base, pairing: { state: 'storage-locked', qr: null } }), /Phone storage needs recovery/);
  assert.doesNotMatch(await show({ visible: false }), /Scan|Allow/);
});

test('a begin that fails, a status failure and a QR that cannot be drawn say so, and Try again recovers', async () => {
  responses['remoteSettings.begin'] = () => Promise.reject(new Error('Phone relay unavailable'));
  const v = await dialog(() => base);
  await flush(100);
  assert.match(text(v.host), /Phone relay unavailable/);
  const failed = count('remoteSettings.begin');
  await flush(1100);
  assert.equal(count('remoteSettings.begin'), failed, 'a failed start is not retried on its own');
  responses['remoteSettings.begin'] = () => ({ state: 'waiting', qr: 'x' });
  await click(button(v.host, 'Try again'));
  assert.equal(count('remoteSettings.begin'), failed + 1);
  await v.unmount();
  responses['remoteSettings.begin'] = () => Promise.reject(new Error('Phone relay unavailable'));
  const closing = await dialog(() => base);
  await flush(100);
  await click(button(closing.host, 'Close'));
  assert.equal(text(closing.host), '');
  await closing.unmount();
  closeConnectPhone();
  let reads = 0;
  const status = await dialog(() =>
    ++reads > 1 ? Promise.reject(new Error('Status unavailable')) : { ...base, enabled: false, running: false },
  );
  await flush(1100);
  assert.match(text(status.host), /Starting…/, 'a read failing later leaves the page as it is');
  assert.doesNotMatch(text(status.host), /Status unavailable/);
  await status.unmount();
  closeConnectPhone();
  const unreadable = await dialog(() => Promise.reject(new Error('Status unavailable')));
  assert.match(text(unreadable.host), /Status unavailable/, 'a first read that fails says so');
  await unreadable.unmount();
  closeConnectPhone();
  const big = await dialog(() => ({ ...base, pairing: { state: 'waiting', qr: 'x'.repeat(10000) } }));
  await flush(100);
  assert.ok(big.host.querySelector('[role=alert]'));
  await big.unmount();
});

test('while a phone waits on the answer, Escape and a stray click do not decline it; Decline does', async () => {
  let state: any = { ...base, pairing: { state: 'confirming', device: 'iPhone 18', safetyNumber: '12345678901234567890' } };
  responses['remoteSettings.answer'] = () => {
    state = { ...state, pairing: { state: 'declined' } };
    return true;
  };
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'next' } };
    return state.pairing;
  };
  const v = await dialog(() => state);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flush(20);
  assert.equal(isConnectPhoneOpen(), true);
  assert.equal(count('remoteSettings.cancel'), 0, 'the phone is not dropped');
  await click(button(v.host, 'Decline'));
  await flush(1100);
  await flush(100);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flush(20);
  assert.equal(isConnectPhoneOpen(), false, 'with nobody waiting Escape closes it');
  await v.unmount();
});

test('an answer that fails says so beside the prompt, and the prompt stays', async () => {
  const state: any = { ...base, pairing: { state: 'confirming', device: 'iPhone 18', safetyNumber: '12345678901234567890' } };
  responses['remoteSettings.answer'] = () => Promise.reject(new Error('Could not answer'));
  const v = await dialog(() => state);
  await click(button(v.host, 'Connect'));
  assert.match(text(v.host), /Could not answer/);
  assert.ok(button(v.host, 'Decline'));
  await v.unmount();
});

test('the gate closing while it is open closes it, rather than leaving an empty box', async () => {
  let state: any = base;
  responses['remoteSettings.begin'] = () => ({ state: 'waiting', qr: 'q' });
  const v = await dialog(() => state);
  assert.equal(isConnectPhoneOpen(), true);
  state = { visible: false };
  await flush(1100);
  await flush(20);
  assert.equal(isConnectPhoneOpen(), false);
  await v.unmount();
});

test('how the last pairing ended is not shown to the next one; one still being saved is', async () => {
  let state: any = { ...base, pairing: { state: 'failed', qr: null } };
  responses['remoteSettings.cancel'] = async () => {
    state = { ...state, pairing: null };
    return true;
  };
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'fresh' } };
    return state.pairing;
  };
  const v = await dialog(() => state);
  await flush(1100);
  assert.doesNotMatch(text(v.host), /Couldn't pair/);
  assert.equal(count('remoteSettings.begin'), 1);
  await v.unmount();
  closeConnectPhone();
  resetCtl();
  const cancelling = await dialog(() => ({ ...base, pairing: { state: 'cancelled-start', qr: null } }));
  assert.match(text(cancelling.host), /Starting…/, 'the last QR is still being called off');
  assert.equal(count('remoteSettings.begin'), 0);
  await cancelling.unmount();
});

test('an action that worked but cannot be read back is not reported as failed', async () => {
  let reads = 0;
  const state = () => (++reads > 1 ? Promise.reject(new Error('Status unavailable')) : { ...base, enabled: false, running: false });
  responses['remoteSettings.setEnabled'] = true;
  const v = await dialog(state);
  await flush(50);
  assert.doesNotMatch(text(v.host), /Status unavailable/);
  await v.unmount();
});

const paired = { ...base, pairing: { state: 'paired', device: 'Ann’s iPhone' } };
const prefs = (on: boolean, offered = true) => ({ keepRunning: on, loginItem: on, preventSleep: on, offered });
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => String(c[1]));

test('the first pairing turns on the one switch and says so in the toast; the dialog closes by itself', async () => {
  responses['alwaysOn.get'] = { prefs: prefs(false, false), loginItemSupported: true };
  responses['alwaysOn.set'] = async (patch: any) => ({ prefs: { ...prefs(false), ...patch }, loginItemSupported: true });
  const v = await dialog(() => paired);
  await flush(50);
  assert.deepEqual(
    calls.find((c) => c[0] === 'alwaysOn.set'),
    ['alwaysOn.set', { keepRunning: true, loginItem: true, preventSleep: true }],
  );
  assert.deepEqual(toasts(), ['Connected: Ann’s iPhone. This Mac stays reachable; change it in Settings › Connections.']);
  assert.equal(text(v.host), '', 'closed');
  await v.unmount();
});

test('a later pairing leaves what the person chose, and a Mac with no settings still ends the same way', async () => {
  responses['alwaysOn.get'] = { prefs: prefs(false), loginItemSupported: true };
  const off = await dialog(() => paired);
  await flush(50);
  assert.equal(count('alwaysOn.set'), 0);
  assert.deepEqual(toasts(), ['Connected: Ann’s iPhone']);
  assert.equal(text(off.host), '');
  await off.unmount();
  closeConnectPhone();
  resetCtl();
  responses['alwaysOn.get'] = null;
  const none = await dialog(() => ({ ...base, pairing: { state: 'paired' } }));
  await flush(50);
  assert.deepEqual(toasts(), ['Connected: this phone']);
  assert.equal(text(none.host), '');
  await none.unmount();
});

test('a save that fails says so and still leaves the pairing done', async () => {
  responses['alwaysOn.get'] = { prefs: prefs(false, false), loginItemSupported: true };
  responses['alwaysOn.set'] = () => Promise.reject(new Error('disk full'));
  const v = await dialog(() => paired);
  await flush(50);
  assert.deepEqual(toasts(), ["Couldn't keep this Mac reachable: disk full", 'Connected: Ann’s iPhone']);
  assert.equal(text(v.host), '');
  await v.unmount();
});

test('a Mac the relay is turning away shows why instead of a code, starts no pairing, and shows the code once it is let in', async () => {
  let state: any = { ...base, refusal: 'capacity' };
  responses['remoteSettings.begin'] = () => {
    state = {
      ...state,
      pairing: { state: 'waiting', qr: 'mopilot://pair?x=1', expiresAt: Date.now() + 120_000, device: null, safetyNumber: null },
    };
    return state.pairing;
  };
  const v = await dialog(() => state);
  assert.match(text(v.host), /Mobile Remote is at capacity\. Try again shortly\./);
  assert.ok(v.host.querySelector('[role="alert"]'));
  assert.equal(count('remoteSettings.begin'), 0, 'a code the relay cannot register is not asked for');
  assert.equal(v.host.querySelector('img'), null);
  // each reason has its own words
  state = { ...base, refusal: 'account_limit' };
  await flush(1100);
  assert.match(text(v.host), /Too many of your devices are connected/);
  state = { ...base, refusal: 'disabled' };
  await flush(1100);
  assert.match(text(v.host), /turned off for this account/);
  // a phone already answering is not hidden behind the notice
  state = {
    ...base,
    refusal: 'capacity',
    pairing: { state: 'confirming', qr: null, expiresAt: null, device: 'Pixel', safetyNumber: '123456' },
  };
  await flush(1100);
  assert.match(text(v.host), /Connect Pixel\?/);
  for (const phase of ['finishing']) {
    state = { ...base, refusal: 'capacity', pairing: { state: phase, qr: null, expiresAt: null, device: 'Pixel', safetyNumber: null } };
    await flush(1100);
    assert.doesNotMatch(text(v.host), /at capacity/, phase);
  }
  // not running yet: Starting, not the notice
  state = { ...base, running: false, refusal: 'capacity' };
  await flush(1100);
  assert.match(text(v.host), /Starting/);
  state = { ...base, refusal: null };
  await flush(1200);
  assert.equal(count('remoteSettings.begin'), 1, 'let in: the code follows by itself');
  // a pairing that finished while the relay turned this Mac away still ends in the toast, not in the notice
  state = { ...base, refusal: 'capacity', pairing: { state: 'paired', qr: null, expiresAt: null, device: 'Pixel', safetyNumber: null } };
  await flush(1200);
  assert.equal(text(v.host), '');
  assert.ok(calls.some((c) => c[0] === 'toast' && /^Connected: Pixel/.test(String(c[1]))));
  await v.unmount();
});

test('a different account signing in on the open dialog is switched on too, and one turned off elsewhere gets a Turn on (#5320 review)', async () => {
  // A is on; the session lapses; B signs in and has phone access off for B
  let state: any = { ...base, enabled: false, running: false };
  responses['remoteSettings.setEnabled'] = (on: boolean) => {
    state = { ...state, enabled: on, running: on };
    return true;
  };
  responses['remoteSettings.begin'] = () => {
    state = { ...state, pairing: { state: 'waiting', qr: 'q' } };
    return state.pairing;
  };
  const v = await dialog(() => state);
  await flush(1100);
  assert.equal(count('remoteSettings.setEnabled'), 1, 'A is switched on');
  state = { ...state, signedIn: false, account: null, enabled: false, running: false, pairing: null };
  responses['mopilot.signIn'] = () => {
    state = { ...state, signedIn: true, account: 'bea@example.com', enabled: false, running: false };
    return { ok: true };
  };
  await flush(1100);
  await click(button(v.host, 'Sign in to MoPilot'));
  await flush(1100);
  assert.equal(count('remoteSettings.setEnabled'), 2, 'B is switched on too, not left on "Starting…"');
  assert.match(text(v.host), /Only connect devices you own/);
  // phone access is turned off from another window while this one is open: no dead end, and no override of that choice by itself
  state = { ...state, enabled: false, running: false, pairing: null };
  await flush(1100);
  assert.equal(count('remoteSettings.setEnabled'), 2, 'what the person turned off stays off until they say so');
  assert.match(text(v.host), /Phone access is off/);
  await click(button(v.host, 'Turn on'));
  await flush(1100);
  assert.equal(count('remoteSettings.setEnabled'), 3);
  assert.match(text(v.host), /Only connect devices you own/);
  // a phone that is being connected, or already is, is not hidden behind it when access is turned off elsewhere
  state = { ...state, enabled: false, running: true, pairing: { state: 'finishing', device: 'Ann’s iPhone' } };
  await flush(1100);
  assert.match(text(v.host), /Connecting…/);
  assert.doesNotMatch(text(v.host), /Phone access is off/);
  await v.unmount();
});

test('the toast names the phone, not the "Replaces … with …" line of a re-pair, and not the previous prompt’s phone (#5320 review)', async () => {
  responses['alwaysOn.get'] = { prefs: prefs(false), loginItemSupported: true };
  let state: any = {
    ...base,
    pairing: { state: 'confirming', device: 'Replaces "Ann’s iPhone" with "Ann’s iPhone 18"', safetyNumber: '1' },
  };
  const v = await dialog(() => state);
  await flush(50);
  assert.match(text(v.host), /Connect Replaces/, 'the prompt keeps the whole line');
  state = { ...base, pairing: { state: 'paired', device: 'Replaces "Ann’s iPhone" with "Ann’s iPhone 18"' } };
  await flush(1100);
  assert.deepEqual(toasts(), ['Connected: Ann’s iPhone 18']);
  await v.unmount();
  closeConnectPhone();
  resetCtl();
  // phone A is declined, the code renews, and phone B pairs with no name: A's name is not shown for B
  responses['alwaysOn.get'] = { prefs: prefs(false), loginItemSupported: true };
  let seen: any = { ...base, pairing: { state: 'confirming', device: 'A', safetyNumber: '1' } };
  const w = await dialog(() => seen);
  await flush(50);
  seen = { ...base, pairing: { state: 'waiting', qr: 'q' } };
  await flush(1100);
  seen = { ...base, pairing: { state: 'paired' } };
  await flush(1100);
  assert.deepEqual(toasts(), ['Connected: this phone']);
  await w.unmount();
});
