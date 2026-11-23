// The phone's reader keeps every login the Mac sends (signed-out ones marked) and each model's auto mode, for whatever UI draws them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
const sheetPath = '../mobile/src/components/NewChatSheets';
const clientPath = '../mobile/src/remote/client';
const { readOptions } = await import(clientPath);

const reply = {
  models: [
    { id: 'm', label: 'M', efforts: [], defaultEffort: null, autoMode: true },
    { id: 'n', label: 'N', efforts: [] },
  ],
  model: 'm',
  accounts: [
    { id: 'a', label: 'a@x.com', loggedIn: true },
    { id: 'b', label: 'b@x.com', loggedIn: false },
    { id: 'c', label: 'c@x.com' },
    { id: 'd', label: 'd@x.com', loggedIn: true, limited: true },
    { label: 'no id' },
  ],
  permission: { value: 'default', rows: [] },
};

test('readOptions keeps signed-out logins marked and each model’s auto mode', () => {
  const o = readOptions(reply, 'auto-review');
  assert.deepEqual(o.accounts, [
    { id: 'a', label: 'a@x.com' },
    { id: 'b', label: 'b@x.com', signedOut: true },
    { id: 'c', label: 'c@x.com' },
    { id: 'd', label: 'd@x.com', limited: true },
  ]);
  assert.equal(o.models[0].autoMode, true);
  assert.equal('autoMode' in o.models[1], false);
});

test('the Account page offers Automatic and each signed-in login; a signed-out one says where to sign in and cannot be picked', async () => {
  const { act, createElement, createRoot, flush, click } = await import('./support/phone/component-kit');
  const { ModelSheet } = await import(sheetPath);
  const draw = async (accounts: any[]) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const picked: (string | null)[] = [];
    const options = { ...readOptions(reply, 'auto-review'), accounts };
    await act(async () =>
      root.render(
        createElement(ModelSheet, {
          open: true,
          close: () => {},
          options,
          model: 'm',
          effort: null,
          permission: null,
          account: null,
          pickModel: () => {},
          pickEffort: () => {},
          pickPermission: () => {},
          pickAccount: (id: string | null) => picked.push(id),
        }),
      ),
    );
    await flush();
    return { host, root, picked };
  };
  const a = await draw([
    { id: 'a', label: 'a@x.com' },
    { id: 'b', label: 'b@x.com', signedOut: true },
    { id: 'c', label: 'c@x.com', limited: true },
  ]);
  await click('Account, Automatic');
  assert.match(a.host.textContent!, /b@x\.com.*Signed out · Sign in on your Mac/);
  assert.match(a.host.textContent!, /c@x\.com.*At its limit/);
  assert.ok(
    ![...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '').startsWith('b@x.com')),
    'a signed-out login is not a button',
  );
  assert.ok(document.querySelector('button[aria-label="c@x.com, At its limit"]'), 'the state is part of the row’s spoken label');
  assert.deepEqual(a.picked, []);
  await click('a@x.com');
  assert.deepEqual(a.picked, ['a']);
  await act(async () => a.root.unmount());
  const b = await draw([{ id: 'b', label: 'b@x.com', signedOut: true }]);
  // only signed-out logins: the row is still there, so the person sees why nothing can be picked
  assert.match(b.host.textContent!, /Account/);
  await act(async () => b.root.unmount());
});
