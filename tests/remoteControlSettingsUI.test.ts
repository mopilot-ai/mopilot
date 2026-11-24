// Settings → Connections → Control from ChatGPT (src/components/pages/settings/RemoteControl.tsx): the switch (asked first), the devices
// paired and their revoke, and the pairing dialog's phases; nothing shows where Codex is not usable.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h, Fragment } from 'react';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({});
let usable = true;
stubStore({ ...store.exports, codexUsable: () => usable });
let view: any = null;
let clientsState: any = { clients: null, error: null };
let pairing: any = { phase: 'loading' };
let onClaimed: () => void = () => undefined;
const sets: boolean[] = [];
const revoked: string[] = [];
let revokeOk = true;
let refreshes = 0;
let restarts = 0;
let usableFor: boolean[] = [];
mock.module('../src/session/harness/codexRemoteControl.ts', {
  namedExports: {
    useCodexRemoteControl: (active: boolean) => (usableFor.push(active), view),
    setCodexRemoteControl: async (on: boolean) => void sets.push(on),
    useRemoteControlClients: () => ({ ...clientsState, refresh: () => void refreshes++ }),
    revokeRemoteControlClient: async (id: string) => (revoked.push(id), revokeOk),
    useRemoteControlPairing: (cb: () => void) => ((onClaimed = cb), { pairing, restart: () => void restarts++ }),
  },
});
const { CodexClientRows, CodexSwitchRows, useCodexControl } = await import('../src/components/pages/settings/RemoteControl.tsx');
// the two halves the Control this Mac tab places apart: the switch rows in Other settings, the client rows in the one device list
function ControlThisComputer() {
  const control = useCodexControl();
  return h(Fragment, null, h(CodexSwitchRows, { control }), h(CodexClientRows, { control }));
}

const phone = { clientId: 'a', name: 'Phone', platform: 'iOS', lastSeenAt: Math.floor(Date.now() / 1000) - 7200 };
const status = (s: string, error: string | null = null, extra: object = {}) => ({
  status: s,
  environmentId: s === 'connected' ? 'env1' : null,
  error,
  ...extra,
});
const toggle = (host: HTMLElement) => one(host, '[role="switch"]') as HTMLButtonElement;
const button = (host: ParentNode, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text) as
    | HTMLButtonElement
    | undefined;
beforeEach(() => {
  usable = true;
  view = status('disabled');
  clientsState = { clients: null, error: null };
  pairing = { phase: 'loading' };
  sets.length = 0;
  revoked.length = 0;
  revokeOk = true;
  refreshes = 0;
  restarts = 0;
  usableFor = [];
  store.calls.length = 0;
});

test('nothing shows, and nothing is read, where Codex is not usable', async () => {
  usable = false;
  const r = await render(h(ControlThisComputer));
  assert.equal(r.host.innerHTML, '');
  assert.equal(usableFor.at(-1), false);
  await r.unmount();
});

test('the switch asks before it links, Cancel leaves it off, and off needs no question', async () => {
  const r = await render(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Let your other devices discover and control this computer/);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'false');
  assert.equal(button(r.host, 'Add'), undefined);
  await act(async () => toggle(r.host).click());
  const dialog = () => r.host.querySelector('[role="alertdialog"]');
  assert.match(dialog()!.textContent!, /Allow devices to control this computer\?/);
  await act(async () => button(dialog()!, 'Cancel')!.click());
  assert.equal(dialog(), null);
  assert.deepEqual(sets, []);
  await act(async () => toggle(r.host).click());
  await act(async () => button(dialog()!, 'Allow')!.click());
  assert.deepEqual(sets, [true]);
  view = status('connecting');
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Connecting…/);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'true');
  await act(async () => toggle(r.host).click());
  assert.equal(dialog(), null);
  assert.deepEqual(sets, [true, false]);
  await r.unmount();
});

test('before the first read the switch cannot be pressed, and a refusal is said in the row', async () => {
  view = null;
  const r = await render(h(ControlThisComputer));
  assert.equal(toggle(r.host).disabled, true);
  view = status('errored', 'Sign in with ChatGPT to use Remote Control.');
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Sign in with ChatGPT to use Remote Control\./);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'false');
  await r.unmount();
});

test('with the link up, the devices are listed, an empty list and a failed read say so, and a revoke asks main and reads again', async () => {
  view = status('connected');
  const r = await render(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Authorized devices on your ChatGPT account can discover and control this computer/);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'true');
  // not read yet: no list
  assert.equal(r.host.querySelector('.settings-row-desc[data-client]'), null);
  clientsState = { clients: [], error: null };
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /No devices added yet/);
  assert.doesNotMatch(r.host.textContent!, /Revoke access/);
  clientsState = { clients: null, error: 'Sign in to ChatGPT again' };
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Couldn't load the devices/);
  assert.doesNotMatch(r.host.textContent!, /No devices added yet/);
  await act(async () => button(r.host, 'Retry')!.click());
  assert.equal(refreshes, 1);
  clientsState = { clients: [phone, { clientId: 'b', name: null, platform: null, lastSeenAt: null }], error: null };
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Phone/);
  assert.match(r.host.textContent!, /iOS · Last connected 2h/);
  assert.match(r.host.textContent!, /Device/);
  assert.match(r.host.textContent!, /Authorized device/);
  // revoking asks first, naming the device and what it costs; Cancel changes nothing
  await act(async () => button(r.host, 'Revoke access for Phone')!.click());
  assert.match(r.host.textContent!, /must be added again to control this computer/);
  await act(async () => button(r.host.querySelector('[role=alertdialog]')!, 'Cancel')!.click());
  assert.deepEqual(revoked, []);
  await act(async () => button(r.host, 'Revoke access for Phone')!.click());
  await act(async () => button(r.host.querySelector('[role=alertdialog]')!, 'Revoke access')!.click());
  assert.deepEqual(revoked, ['a']);
  // a device that never gave a name is named in the question too
  await act(async () => button(r.host, 'Revoke access for Device')!.click());
  assert.match(r.host.textContent!, /Revoke access for This device\?/);
  await act(async () => button(r.host.querySelector('[role=alertdialog]')!, 'Cancel')!.click());
  assert.deepEqual(store.calls.at(-1), ['toast', 'Revoked device access']);
  assert.equal(refreshes, 2);
  // a revoke that failed says so through its own toast (not this page's) and still reads again
  revokeOk = false;
  store.calls.length = 0;
  await act(async () => button(r.host, 'Revoke access for Phone')!.click());
  await act(async () => button(r.host.querySelector('[role=alertdialog]')!, 'Revoke access')!.click());
  assert.equal(store.calls.length, 0);
  assert.equal(refreshes, 3);
  await r.unmount();
});

test('Add opens the pairing dialog: its code and the time left, a new code once it ended or failed, and a device that used it closes it', async () => {
  view = status('connected');
  clientsState = { clients: [], error: null };
  const r = await render(h(ControlThisComputer));
  await act(async () => button(r.host, 'Add')!.click());
  const dialog = () => r.host.querySelector('[role="dialog"]') as HTMLElement | null;
  assert.match(dialog()!.textContent!, /Getting a code…/);
  // focus starts inside, so Escape reaches the dialog
  assert.equal(document.activeElement, button(dialog()!, 'Close'));
  pairing = { phase: 'ready', code: 'ABCD-1234', secondsLeft: 125 };
  await r.rerender(h(ControlThisComputer));
  assert.equal(one(dialog()!, '[aria-label="Pairing code"]').textContent, 'ABCD-1234');
  assert.match(dialog()!.textContent!, /Expires in 2:05/);
  assert.equal(button(dialog()!, 'New code'), undefined);
  pairing = { phase: 'ready', code: 'ABCD-1234', secondsLeft: 9 };
  await r.rerender(h(ControlThisComputer));
  assert.match(dialog()!.textContent!, /Expires in 0:09/);
  pairing = { phase: 'expired' };
  await r.rerender(h(ControlThisComputer));
  assert.match(dialog()!.textContent!, /The code expired\./);
  await act(async () => button(dialog()!, 'New code')!.click());
  assert.equal(restarts, 1);
  pairing = { phase: 'error', message: 'Turn Remote Control on first.' };
  await r.rerender(h(ControlThisComputer));
  assert.match(dialog()!.textContent!, /Turn Remote Control on first\./);
  await act(async () => button(dialog()!, 'Try again')!.click());
  assert.equal(restarts, 2);
  // Escape and Close leave it
  await act(async () => void dialog()!.parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(dialog(), null);
  await act(async () => button(r.host, 'Add')!.click());
  await act(async () => button(dialog()!, 'Close')!.click());
  assert.equal(dialog(), null);
  // a device used the code: it is said, the devices are read again, and the dialog closes
  await act(async () => button(r.host, 'Add')!.click());
  pairing = { phase: 'ready', code: 'ABCD-1234', secondsLeft: 100 };
  await r.rerender(h(ControlThisComputer));
  const before = refreshes;
  await act(async () => onClaimed());
  assert.deepEqual(store.calls.at(-1), ['toast', 'Device added']);
  assert.equal(refreshes, before + 1);
  assert.equal(dialog(), null);
  await r.unmount();
});

test('while the app-server retries the switch stays on and the row says Reconnecting with the last reason', async () => {
  view = status('errored', "Couldn't connect.", { retrying: true, detail: '503 Service Unavailable' });
  const r = await render(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Reconnecting… Couldn't connect\. · 503 Service Unavailable/);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'true');
  view = status('errored', "Couldn't connect.", { detail: '403 Forbidden' });
  await r.rerender(h(ControlThisComputer));
  assert.match(r.host.textContent!, /Couldn't connect\. · 403 Forbidden/);
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'false');
  await r.unmount();
});
