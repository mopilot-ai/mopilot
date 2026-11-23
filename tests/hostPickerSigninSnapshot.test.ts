// Reopening the remote picker follows the Host's existing sign-in, including a snapshot still in flight after reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, mount } from './support/composer-kit.ts';
import { controlledReads, tick } from './support/async-scenarios.ts';
import { useFakeNative } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';
import type { HostMachineRow } from '../src/lib/hostMachines.ts';

mockSource('src/store/core.ts', { toast: () => undefined });
const { act, createElement: h, Fragment } = await import('react');
const { HostPickerSignin, useHostPickerSignin } = await import('../src/components/composer/HostPickerSignin.tsx');

const machine = {
  id: 'box',
  name: 'Box',
  status: 'online',
  lastSeen: null,
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', logins: [{ id: 'default', label: 'me@example.test', state: 'signedOut' }] },
  ],
} as HostMachineRow;

function Probe({ report = machine }: { report?: HostMachineRow }) {
  const flow = useHostPickerSignin(report.id, report);
  return h(
    Fragment,
    null,
    h('button', { id: 'open', disabled: !flow.available('claude'), onClick: () => flow.open('claude') }, 'Sign in again'),
    flow.dialog && h(HostPickerSignin, flow.dialog),
  );
}

test('a reloaded picker waits for the attempt snapshot, then shows its outcome without starting another attempt', async (t) => {
  const { read, requests } = controlledReads<unknown[]>();
  const profile = controlledReads<unknown>();
  const native = useFakeNative(t, { host: { access: async () => true, signinViews: read, hostStatus: profile.read } });
  const original = await mount(h(Probe));
  assert.equal(($('#open') as HTMLButtonElement).disabled, true);
  await original.unmount();
  const reloaded = await mount(h(Probe));
  try {
    await act(async () => {
      requests[0].resolve([]);
      await tick();
    });
    await click($('#open'));
    assert.equal(($('#open') as HTMLButtonElement).disabled, true, 'a retired snapshot cannot enable the replacement');
    assert.deepEqual(native.callsTo('host.signin'), []);
    await act(async () => {
      requests[1].resolve([{ hostId: 'box', harness: 'claude', state: 'signed-in' }]);
      await tick();
    });
    await click($('#open'));
    assert.equal($('.dialog [role=status]').textContent, 'The last sign-in completed.');
    assert.deepEqual(native.callsTo('host.signin'), []);
    assert.equal($('.dialog .btn-pill.primary'), null, 'the same account report cannot authorize another attempt');
    const check = () => click($('.dialog .btn-pill.soft'));
    await check();
    assert.deepEqual(native.callsTo('host.hostStatus'), [['box']]);
    await reloaded.render(h(Probe, { report: { ...machine, lastSeen: 1 } }));
    assert.equal($('.dialog .btn-pill.primary'), null, 'an older heartbeat arriving late cannot authorize another attempt');
    await act(async () => profile.requests[0].resolve({ harnesses: null }));
    assert.equal($('.dialog [role=alert]').textContent, 'Couldn’t read the account status.');
    await check();
    await act(async () => profile.requests[1].reject(new Error('Couldn’t reach Box.')));
    assert.equal($('.dialog [role=alert]').textContent, 'Couldn’t reach Box.');
    await check();
    await click($('.dialog [aria-label=Close]'));
    await click($('#open'));
    const status = (state: string) => ({
      harnesses: [{ id: 'claude', detected: true, signedIn: state === 'ok', logins: [{ id: 'default', state }] }],
    });
    await act(async () => profile.requests[2].resolve(status('signedOut')));
    assert.equal($('.dialog .btn-pill.primary'), null, 'an older read cannot authorize another attempt');
    await check();
    await act(async () => profile.requests[3].resolve(status('ok')));
    assert.equal($('.dialog [role=status]').textContent, 'Signed in');
    assert.equal($('.dialog .btn-pill.primary'), null);
    await click($('.dialog [aria-label=Close]'));
    await click($('#open'));
    await check();
    await act(async () => profile.requests[4].resolve(status('expired')));
    assert.equal($('.dialog .btn-pill.primary').textContent, 'Sign in again');
    await click($('.dialog .btn-pill.primary'));
    assert.deepEqual(native.callsTo('host.signin'), [['box', 'claude']]);
  } finally {
    await reloaded.unmount();
  }
});
