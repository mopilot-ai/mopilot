// ACP registry browsing and managed version controls through the real components, with only native IPC and app state faked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  responses,
  calls,
  options,
} from './support/settings-harness.ts';
import { deferred } from './support/async-scenarios.ts';
import { agent } from './support/acp-registry.ts';

await setup();
const { createElement: h, act, StrictMode } = await import('react');
const { RegistryAgents } = await import('../src/components/harness/RegistryAgents.tsx');
const { HarnessVersionRow } = await import('../src/components/harness/HarnessVersionRow.tsx');
const entry = (id: string, extra: any = {}) => ({
  ...agent(id),
  available: true,
  installed: false,
  installedVersion: null,
  repairAvailable: !!extra.installedVersion,
  needsUpdate: !!extra.installedVersion && extra.installedVersion !== '1.2.3',
  ...extra,
});

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  responses['acp.harnesses'] = [];
});

test('browsing fetches only metadata, search filters it, and explicit installation refreshes admission and the list', async () => {
  responses['acp.registryList'] = {
    agents: [
      entry('installable'),
      entry('blocked', { available: false }),
      entry('installed', { installed: true, installedVersion: '1.2.3' }),
      entry('upgrade', { installed: true, installedVersion: '1.0.0' }),
    ],
    error: null,
  };
  const view = await render(h(RegistryAgents));
  assert.equal(
    calls.some((c) => c[0] === 'acp.registryList'),
    false,
  );
  await click(button(view.host, 'Browse agent directory'));
  assert.equal(button(view.host, 'Unavailable here').disabled, true);
  assert.equal(button(view.host, 'Repair').disabled, false);
  assert.equal(button(view.host, 'Update').disabled, false);
  assert.equal(
    calls.some((c) => c[0] === 'acp.registryInstall'),
    false,
  );
  responses['acp.registryInstall'] = { id: 'registry-installable', file: '/agent/launch' };
  responses['acp.registryRepair'] = { id: 'registry-installed', file: '/agent/repaired' };
  await click(button(view.host, 'Repair'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'acp.registryRepair'),
    [['acp.registryRepair', 'installed']],
  );
  await click(button(view.host, 'Install'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'acp.registryInstall'),
    [['acp.registryInstall', 'installable']],
  );
  assert.equal(
    calls.some((c) => c[0] === 'acp.harnesses'),
    true,
  );
  await click(button(view.host, 'Refresh directory'));
  assert.deepEqual(calls.filter((c) => c[0] === 'acp.registryList').at(-1), ['acp.registryList', true]);
  const input = view.host.querySelector('input')!;
  const { setValue } = await import('./support/settings-harness.ts');
  await setValue(input, 'no match');
  assert.match(text(view.host), /No agents match/);
  await view.unmount();
});

test('loading and install errors stay actionable, and double clicks join the main-owned installation', async () => {
  responses['acp.registryList'] = () => {
    throw new Error('offline');
  };
  const view = await render(h(RegistryAgents));
  await click(button(view.host, 'Browse agent directory'));
  assert.match(text(view.host.querySelector('[role=alert]')), /offline/);
  responses['acp.registryList'] = { agents: [entry('retry')], error: 'Cached metadata: offline' };
  await click(button(view.host, 'Browse agent directory'));
  assert.match(text(view.host.querySelector('[role=alert]')), /Cached metadata/);
  const gate = deferred<any>();
  responses['acp.registryInstall'] = () => gate.promise;
  const install = button(view.host, 'Install');
  await act(async () => {
    install.click();
    install.click();
  });
  assert.equal(calls.filter((c) => c[0] === 'acp.registryInstall').length, 1);
  assert.equal(button(view.host, 'Installing…').disabled, true);
  await act(async () => gate.reject(new Error('download failed')));
  assert.match(text(view.host.querySelector('[role=alert]')), /download failed/);
  responses['acp.registryInstall'] = {};
  await click(button(view.host, 'Install'));
  assert.equal(calls.filter((c) => c[0] === 'acp.registryInstall').length, 2);
  await view.unmount();
});

test('unmount retires discovery at success and failure, and a main-owned install can finish after its page closes', async () => {
  for (const failure of [false, true])
    for (const duringInstall of [false, true]) {
      const gate = deferred<any>();
      responses['acp.registryList'] = duringInstall ? { agents: [entry('retired')], error: null } : () => gate.promise;
      responses['acp.registryInstall'] = () => gate.promise;
      const view = await render(h(StrictMode, null, h(RegistryAgents)));
      await click(button(view.host, 'Browse agent directory'));
      if (duringInstall) await click(button(view.host, 'Install'));
      await view.unmount();
      const reads = calls.filter((c) => c[0] === 'acp.registryList').length;
      await act(async () => (failure ? gate.reject(new Error('retired')) : gate.resolve({ agents: [], error: null })));
      assert.equal(calls.filter((c) => c[0] === 'acp.registryList').length, reads, 'a closed page cannot start a replacement read');
    }
});

test('managed registry versions show their source and reveal action without a path override or native update control', async () => {
  for (const version of ['1.2.3', null]) {
    const view = await render(
      h(HarnessVersionRow, {
        managed: true,
        kind: 'acp:registry-example',
        label: 'Example',
        name: 'example',
        bin: '/managed/launch',
        version,
        manual: '/external/example',
        installs: [{ path: '/other', version: '1' }],
        onPick: () => assert.fail('managed files cannot be overridden'),
      }),
    );
    assert.match(text(view.host), /Agent directory/);
    assert.match(text(view.host), /Updates are available in Other agents/);
    await click(button(view.host, 'Example CLI options'));
    assert.deepEqual(options(view.host), ['Show in Finder']);
    await click(button(view.host, 'Show in Finder'));
    assert.deepEqual(calls.at(-1), ['shell.reveal', '/managed/launch']);
    await view.unmount();
  }
});

test('a corrected contract at the same version updates, while an unavailable new version can still repair the installed one', async () => {
  responses['acp.registryList'] = {
    agents: [entry('corrected', { installed: true, installedVersion: '1.2.3', needsUpdate: true })],
    error: null,
  };
  responses['acp.registryInstall'] = {};
  responses['acp.registryRepair'] = {};
  const view = await render(h(RegistryAgents));
  await click(button(view.host, 'Browse agent directory'));
  await click(button(view.host, 'Update'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'acp.registryInstall'),
    [['acp.registryInstall', 'corrected']],
  );
  responses['acp.registryList'] = {
    agents: [entry('corrected', { installed: true, installedVersion: '1.2.3', needsUpdate: true, available: false })],
    error: null,
  };
  await click(button(view.host, 'Refresh directory'));
  assert.equal(button(view.host, 'Unavailable here').disabled, true);
  await click(button(view.host, 'Repair installed version'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'acp.registryRepair'),
    [['acp.registryRepair', 'corrected']],
  );
  await view.unmount();
});
