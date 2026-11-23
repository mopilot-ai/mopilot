// Settings reports an unavailable managed terminal owner instead of launching another authentication protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctl, calls, store, OtherHarnesses, harness, rowOf, h, render, click, byText } from './support/other-harnesses-harness.ts';
import { loginCommand } from '../src/harness/acpLogin.ts';

test('Settings terminal and legacy sign-ins refuse a missing managed auth owner with Repair guidance', async () => {
  for (const legacy of [false, true]) {
    const managed = harness({
      id: 'managed',
      label: 'Managed agent',
      state: 'signin',
      bin: '/managed/launch',
      authBin: null,
      authMethods: legacy ? [] : [{ id: 'login', name: 'Terminal login', type: 'terminal', args: ['login'] }],
      login: legacy ? ['managed', 'login'] : null,
    });
    ctl.loginFor = { [`managed:${legacy ? null : 'login'}`]: loginCommand(managed, legacy ? null : 'login') };
    store.setState({ basicHarnesses: [managed], basicSignIns: {}, prefs: {}, home: '/home/ada' });
    const view = await render(h(OtherHarnesses));
    calls.length = 0;
    await click(byText(rowOf(view.host, 'managed'), legacy ? 'Sign in' : 'Terminal login'));
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'auth'),
      [],
    );
    const toast = calls.find(([kind]) => kind === 'toast');
    assert.match(toast?.[1], /Repair.*Managed agent/);
    assert.equal(ctl.exitTerm, null);
    await view.unmount();
  }
});
