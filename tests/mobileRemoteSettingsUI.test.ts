// Settings → Connections → Phone: the local opt-in and the paired phones; adding one opens Connect your phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, responses, resetCtl, render, click, text, button, buttons, toggle, flush, calls, ctl } from './support/settings-harness.ts';
await setup();
const { createElement: h, act } = await import('react');
const { MobileRemote } = await import('../src/components/pages/settings/MobileRemote.tsx');
await import('../src/lib/native/remoteSettings.ts');
const { closeConnectPhone, isConnectPhoneOpen } = await import('../src/lib/phoneEntry.ts');

const base = { visible: true, signedIn: true, enabled: true, running: true, locked: false, pairing: null, devices: [] as any[] };
const count = (name: string) => calls.filter((c) => c[0] === name).length;

test('hidden until main says visible; the opt-in starts nothing, and Connect opens the dialog', async () => {
  resetCtl();
  let state: any = { visible: false };
  responses['remoteSettings.state'] = () => state;
  const hidden = await render(h(MobileRemote));
  assert.equal(text(hidden.host), '');
  await hidden.unmount();
  state = { ...base, enabled: false, running: false };
  responses['remoteSettings.setEnabled'] = (on: boolean) => {
    state = { ...state, enabled: on, running: on };
    return true;
  };
  const v = await render(h(MobileRemote));
  assert.equal(buttons(v.host, 'Add').length, 0, 'no Add while connections are off');
  await toggle(v.host, 'Allow connections');
  await flush(100);
  assert.equal(count('remoteSettings.begin'), 0, 'no pairing starts behind the page');
  assert.equal(v.host.querySelector('img'), null, 'the QR lives in the dialog');
  await click(button(v.host, 'Add'));
  assert.equal(isConnectPhoneOpen(), true);
  closeConnectPhone();
  state = {
    ...state,
    devices: [
      {
        id: 'a',
        pairId: 'pa',
        name: 'iPhone',
        lastSeenAt: null,
        pairedAt: 1_700_000_000_000,
        online: true,
        connection: 'connected',
        mirrors: false,
        retired: false,
      },
    ],
  };
  await flush(1100);
  assert.match(text(v.host), /Connected · Paired \w+ \d+/);
  assert.match(text(v.host), /1 connected · 1 paired/);
  assert.match(text(v.host), /Pairings stay saved when a phone goes offline or MoPilot restarts/);
  await click(button(v.host, 'Add'));
  assert.equal(isConnectPhoneOpen(), true);
  closeConnectPhone();
  await v.unmount();
  assert.equal(count('remoteSettings.cancel'), 0, 'leaving this page does not end a pairing the dialog owns');
});

test('paired phones: name, last seen, a quiet terminal-and-screen switch, Remove; a refused change is visible', async () => {
  resetCtl();
  let state: any = {
    ...base,
    devices: [
      {
        id: 'a',
        pairId: 'pa',
        name: 'Phone A',
        lastSeenAt: 1_700_000_000_000,
        online: false,
        connection: 'offline',
        mirrors: false,
        retired: false,
      },
      { id: 'b', pairId: 'pb', name: 'Phone B', lastSeenAt: null, online: true, connection: 'connected', mirrors: true, retired: false },
      { id: 'c', pairId: 'pc', name: 'Old phone', lastSeenAt: null, online: false, mirrors: false, retired: true },
    ],
  };
  responses['remoteSettings.state'] = () => state;
  responses['remoteSettings.cancel'] = true;
  responses['remoteSettings.setMirrors'] = true;
  responses['remoteSettings.revoke'] = (id: string) => {
    if (id === 'b') return false;
    state = { ...state, devices: state.devices.filter((d: any) => d.id !== id) };
    return true;
  };
  const v = await render(h(MobileRemote));
  const seenA = new Date(1_700_000_000_000);
  assert.match(text(v.host), /Last seen \w+ \d+, 2023/, 'an old visit reads as a date, not a timestamp');
  assert.equal(
    v.host.querySelector(`[title="${seenA.toLocaleString()}"]`)?.textContent?.startsWith('Offline · Last seen'),
    true,
    'the exact time is in the tooltip',
  );
  assert.match(text(v.host), /Connected/);
  assert.match(text(v.host), /1 connected · 2 paired/);
  assert.match(text(v.host), /Disconnected\. Revoke its access to take it off this Mac/);
  assert.equal(text(v.host).match(/Terminal and screen/g)?.length, 2, 'a quiet label for each live phone');
  await click(v.host.querySelector('[role=switch][aria-label="Terminal and screen for Phone A"]')!);
  assert.deepEqual(
    calls.find((c) => c[0] === 'remoteSettings.setMirrors'),
    ['remoteSettings.setMirrors', 'a', 'pa', true],
  );
  responses['remoteSettings.setMirrors'] = false;
  await click(v.host.querySelector('[role=switch][aria-label="Terminal and screen for Phone B"]')!);
  assert.match(text(v.host), /connection changed/);
  const confirm = async (name: string) => {
    await click(button(v.host, `Revoke access for ${name}`));
    assert.match(text(v.host), new RegExp(`Revoke access for ${name}\\?`));
    await click(button(v.host.querySelector('[role=alertdialog]')!, 'Revoke access'));
  };
  await confirm('Phone B');
  assert.match(text(v.host), /connection changed/);
  await confirm('Phone A');
  assert.deepEqual(calls.filter((c) => c[0] === 'remoteSettings.revoke').at(-1), ['remoteSettings.revoke', 'a', 'pa']);
  await v.unmount();
});

test('signed out, storage recovery, a consent warning and failures are one short line each', async () => {
  resetCtl();
  const show = async (state: any) => {
    responses['remoteSettings.state'] = state;
    const v = await render(h(MobileRemote));
    const t = text(v.host);
    await v.unmount();
    return t;
  };
  assert.match(await show({ ...base, signedIn: false, enabled: false, running: false }), /Sign in to MoPilot/);
  const locked = await show({ ...base, locked: true });
  assert.match(locked, /Phone storage needs recovery/);
  assert.match(locked, /Saved pairings have not been checked/);
  assert.doesNotMatch(locked, /0 paired/, 'unreadable or uncertain storage is not an empty saved-phone list');
  assert.match(await show({ ...base, enabled: false, consentWarning: true }), /Couldn't save this setting/);
  assert.match(await show({ ...base, running: false }), /Saved pairings have not been checked/);
  let reads = 0;
  responses['remoteSettings.state'] = () =>
    ++reads > 1 ? Promise.reject(new Error('Status unavailable')) : { ...base, enabled: false, running: false };
  const v = await render(h(MobileRemote));
  await flush(1050);
  assert.match(text(v.host), /Status unavailable/);
  await v.unmount();
});

test('a phone can be renamed in place: Enter or Save keeps it, Escape or Cancel does not, an empty name cannot be saved, and a refusal is told', async () => {
  resetCtl();
  const phone = {
    id: 'a',
    pairId: 'pa',
    name: 'iPhone',
    lastSeenAt: null,
    pairedAt: 1_700_000_000_000,
    online: true,
    connection: 'connected',
    mirrors: false,
    retired: false,
  };
  let state: any = { ...base, devices: [phone] };
  responses['remoteSettings.state'] = () => state;
  responses['remoteSettings.rename'] = (_id: string, _pair: string, name: string) => {
    state = { ...state, devices: [{ ...phone, name }] };
    return true;
  };
  const v = await render(h(MobileRemote));
  const field = () =>
    v.host.querySelector('input[aria-label="Name for iPhone"], input[aria-label="Name for Work phone"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const key = (name: string, extra: object = {}) =>
    act(async () => void field().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...extra })));
  await click(button(v.host, 'Rename'));
  assert.equal(field().value, 'iPhone');
  await type('   ');
  assert.equal(button(v.host, 'Save').disabled, true, 'an empty name cannot be saved');
  await key('Enter');
  assert.equal(count('remoteSettings.rename'), 0);
  await key('Escape');
  assert.equal(field(), null);
  await click(button(v.host, 'Rename'));
  await click(button(v.host, 'Cancel'));
  assert.equal(field(), null);
  await click(button(v.host, 'Rename'));
  await type('Work phone');
  await key('Enter', { isComposing: true });
  assert.equal(count('remoteSettings.rename'), 0, 'Enter that ends a composition is not a save');
  await key('Enter');
  assert.deepEqual(
    calls.find((c) => c[0] === 'remoteSettings.rename'),
    ['remoteSettings.rename', 'a', 'pa', 'Work phone'],
  );
  assert.equal(field(), null);
  assert.match(text(v.host), /Work phone/);
  responses['remoteSettings.rename'] = false;
  await click(button(v.host, 'Rename'));
  await type('Other');
  await click(button(v.host, 'Save'));
  assert.match(text(v.host), /connection changed/);
  await v.unmount();
});

test('a Mac the relay is turning away says why above its phones, and nothing when it is not', async () => {
  resetCtl();
  let state: any = { ...base, refusal: 'capacity' };
  responses['remoteSettings.state'] = () => state;
  const v = await render(h(MobileRemote));
  assert.match(text(v.host), /Phones can't reach this Mac right now\. Mobile Remote is at capacity\. Try again shortly\./);
  assert.ok(v.host.querySelector('[role="alert"]'));
  state = { ...base, refusal: 'disabled' };
  await flush(1100);
  assert.match(text(v.host), /turned off for this account/);
  state = { ...base, refusal: null };
  await flush(1100);
  assert.doesNotMatch(text(v.host), /can't reach this Mac/);
  // switched off locally there is nothing to say about the relay
  state = { ...base, enabled: false, refusal: 'capacity' };
  await flush(1100);
  assert.doesNotMatch(text(v.host), /can't reach this Mac/);
  // a setting that could not be saved, and a signed-out Mac, say their own thing first
  state = { ...base, consentWarning: true, refusal: 'capacity' };
  await flush(1100);
  assert.match(text(v.host), /Couldn't save this setting/);
  state = { ...base, signedIn: false, refusal: 'capacity' };
  await flush(1100);
  assert.match(text(v.host), /Sign in to MoPilot to connect a phone/);
  assert.doesNotMatch(text(v.host), /can't reach this Mac/);
  await v.unmount();
});

test('Refresh reads the phones again; a change that fails and whose re-read fails too says the change failed and logs the read', async (t) => {
  resetCtl();
  let reads = 0;
  let broken = false;
  responses['remoteSettings.state'] = () => (++reads, broken ? Promise.reject(new Error('Status unavailable')) : base);
  responses['remoteSettings.setEnabled'] = () => Promise.reject(new Error('Could not save'));
  const v = await render(h(MobileRemote));
  t.after(() => v.unmount());
  const before = reads;
  await click(button(v.host, 'Refresh'));
  assert.ok(reads > before, 'Refresh asked main again');
  broken = true;
  await toggle(v.host, 'Allow connections');
  await click(button(v.host.querySelector('[role=alertdialog]')!, 'Turn off'));
  await flush(20);
  assert.match(text(v.host), /Could not save/);
});

test('a read that failed once and then works clears its error row; a change’s own error is not cleared by a read', async (t) => {
  resetCtl();
  let reads = 0;
  responses['remoteSettings.state'] = () => (++reads === 2 ? Promise.reject(new Error('Status unavailable')) : base);
  const v = await render(h(MobileRemote));
  t.after(() => v.unmount());
  await flush(1300);
  assert.match(text(v.host), /Status unavailable/);
  await flush(1100);
  assert.doesNotMatch(text(v.host), /Status unavailable/);
});

test('the phone group with nothing else to show: a first read that fails shows its error; a later failure after a hidden answer shows nothing', async (t) => {
  resetCtl();
  responses['remoteSettings.state'] = () => Promise.reject(new Error('Status unavailable'));
  const failing = await render(h(MobileRemote));
  await flush(50);
  assert.match(text(failing.host), /Status unavailable/);
  await failing.unmount();
  let reads = 0;
  responses['remoteSettings.state'] = () => (++reads === 1 ? { visible: false } : Promise.reject(new Error('Status unavailable')));
  const hidden = await render(h(MobileRemote));
  t.after(() => hidden.unmount());
  await flush(1300);
  assert.equal(text(hidden.host), '', 'it was hidden, and a failed read does not bring it back');
});

test('with pairing by code on, Add asks Phone or Computer; Phone opens the phone dialog as before', async (t) => {
  resetCtl();
  ctl.flags['host.codePair'] = true;
  responses['remoteSettings.state'] = { ...base };
  responses['codePair.status'] = () => ({ approval: { available: false, reason: 'no_approval_helper' }, connections: true, offers: [] });
  const v = await render(h(MobileRemote));
  t.after(() => {
    ctl.flags['host.codePair'] = false;
    return v.unmount();
  });
  await flush(20);
  await click(button(v.host, 'Add'));
  assert.ok(button(v.host, 'Computer'), 'the kind of device is asked');
  await click(button(v.host, 'Show the code'));
  assert.equal(isConnectPhoneOpen(), true);
  closeConnectPhone();
});
