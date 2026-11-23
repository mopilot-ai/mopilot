// The phone's reader of the Mac's logins and its auto-switch write: strict parsing, an older Mac explained, nothing sent without the method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { scripted } from './support/phone/m3';
const clientPath = '../mobile/src/remote/client';
const accountsPath = '../mobile/src/remote/accounts';
const { ownedRequest } = await import(clientPath);
const { parseAccounts, loadAccounts, setAutoSwitch } = await import(accountsPath);

const good = {
  scope: 'local',
  harnesses: [{ harness: 'codex', autoSwitch: true, pool: 'spread' }],
  accounts: [
    { harness: 'codex', account: 'a', label: 'a@x.com', status: 'ok', billing: 'subscription', active: true, limited: true },
    { harness: 'claude', account: 'b', label: 'b', status: 'signedOut', billing: 'subscription' },
  ],
};

test('parseAccounts keeps every login with its state, and fails on a malformed field', () => {
  const r = parseAccounts(good);
  assert.deepEqual(r.harnesses, [{ harness: 'codex', autoSwitch: true, pool: 'spread' }]);
  assert.deepEqual(
    r.accounts.map((a: any) => [a.account, a.status, a.active, a.limited]),
    [
      ['a', 'ok', true, true],
      ['b', 'signedOut', false, false],
    ],
  );
  for (const raw of [
    null,
    { ...good, scope: 'host' },
    { ...good, harnesses: {} },
    { ...good, accounts: null },
    { ...good, harnesses: [null] },
    { ...good, harnesses: [{ harness: 'codex', autoSwitch: 'yes', pool: 'spread' }] },
    { ...good, accounts: [null] },
    { ...good, accounts: [{ ...good.accounts[0], status: 'gone' }] },
    { ...good, accounts: [{ ...good.accounts[0], label: '' }] },
  ])
    assert.throws(() => parseAccounts(raw));
});

function mac(methods: string[], answers: Record<string, any>) {
  const { runtime, calls } = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods } } : answers[m]));
  return { request: ownedRequest(runtime), calls };
}

test('loadAccounts and setAutoSwitch use the Mac’s methods; an older Mac is told to update, a bad answer fails', async () => {
  const m = mac(['accounts.get', 'accounts.autoSwitch'], { 'accounts.get': good, 'accounts.autoSwitch': { autoSwitch: false } });
  assert.equal((await loadAccounts(m.request)).accounts.length, 2);
  assert.equal(await setAutoSwitch(m.request, 'codex', false), false);
  assert.deepEqual(m.calls.at(-1), ['accounts.autoSwitch', { harness: 'codex', on: false }]);
  const old = mac([], {});
  await assert.rejects(loadAccounts(old.request), /Update MoPilot/);
  await assert.rejects(setAutoSwitch(old.request, 'codex', true), /Update MoPilot/);
  assert.equal(
    old.calls.some((c: any) => c[0].startsWith('accounts.')),
    false,
  );
  const broken = mac(['accounts.autoSwitch'], { 'accounts.autoSwitch': {} });
  await assert.rejects(setAutoSwitch(broken.request, 'codex', true));
});
