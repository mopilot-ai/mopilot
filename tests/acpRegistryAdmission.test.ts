// Installed registry agents join normal admission, flags and renderer catalog contracts while native harnesses retain their identities.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSpawn, INIT } from './support/electron-acp-fake.ts';
import { agent, directory, fakeInstall, which } from './support/acp-registry.ts';
import { SHIPPED_OFF_NATIVE } from './support/native-build-flags.ts';
import { ACP_CATALOG, ACP_IDS, ACP_PUBLIC_IDS, registerRegistryAgents } from '../shared/harnessCatalog.mjs';
import { registerInstalledRegistryHarnesses, harnessInfo } from '../src/harness/registry.ts';
import { loginCommand } from '../src/harness/acpLogin.ts';

const require = createRequire(import.meta.url);
const { openAdmission, NO_SAGE_MCP } = require('../electron/app/acpAdmission.cjs');
const { quirks } = require('../electron/harness/quirks/index.cjs');
const { Flags, isEnabled, sanitize, defaultsFor, localOverride } = require('../electron/platform/flags.cjs');

test('default registry discovery resolves package managers through the shared login-shell environment', (t) => {
  const lookup = mock.method(require('../electron/platform/env.cjs'), 'which', which);
  t.after(() => lookup.mock.restore());
  const dir = directory();
  const admission = openAdmission({
    common: { ids: [], quirks, resolveBin: () => null, env: () => ({}), dataDir: dir, tools: NO_SAGE_MCP },
    app: Object.assign(new EventEmitter(), { getPath: () => dir }),
    broadcastAll: () => {},
  });
  t.after(() => admission.registry.dispose());
  assert.equal(admission.registry.distribution(agent('discovered')).kind, 'npx');
  assert.deepEqual(
    lookup.mock.calls.map((call: any) => call.arguments[0]),
    ['npm', 'npx', 'uv', 'uvx'],
  );
});

test('installed metadata registers atomically and independently in shared catalogs, including a later pinned version', () => {
  const original = ACP_CATALOG.kimi;
  const descriptors = registerRegistryAgents([agent('registered')]);
  const count = ACP_IDS.length;
  registerRegistryAgents([agent('registered')]);
  assert.equal(ACP_IDS.length, count);
  assert.equal(ACP_PUBLIC_IDS.includes('registry-registered'), true);
  assert.equal(quirks('registry-registered').label, 'Agent registered (ACP registry)');
  assert.throws(() => registerRegistryAgents([agent('duplicates'), agent('duplicates')]), /duplicate/);
  assert.equal(ACP_CATALOG['registry-duplicates'], undefined);
  ACP_CATALOG['registry-conflict'] = original;
  try {
    assert.throws(() => registerRegistryAgents([agent('unpublished'), agent('conflict')]), /cannot replace the native/);
    assert.equal(ACP_CATALOG['registry-unpublished'], undefined);
  } finally {
    delete ACP_CATALOG['registry-conflict'];
  }
  registerInstalledRegistryHarnesses([{ descriptor: descriptors[0] }]);
  assert.equal(harnessInfo('acp:registry-registered')!.label, descriptors[0].label);
  registerInstalledRegistryHarnesses([{}, { descriptor: { ...descriptors[0], registry: agent('registered', '2.0.0') } }]);
  assert.equal(ACP_CATALOG['registry-registered'].registry!.version, '2.0.0');
  assert.equal(descriptors[0].registry!.version, '1.2.3');
  assert.equal(ACP_CATALOG.kimi, original);
});

test('dynamic installed agents default on, retain remote kill switches and do not turn on uninstalled or disabled native agents', async () => {
  registerRegistryAgents([agent('flagged')]);
  const key = 'harness.acp.registry-flagged.enabled';
  assert.equal(isEnabled(key), true);
  assert.equal(isEnabled('harness.acp.registry-absent.enabled'), false);
  assert.deepEqual(sanitize({ [key]: false, 'harness.acp.registry-absent.enabled': true }), { [key]: false });
  const disabledNativeKey = SHIPPED_OFF_NATIVE;
  assert.equal(defaultsFor(process.platform)[disabledNativeKey], false, 'the native fixture must ship disabled');
  const flags = new Flags({
    file: path.join(directory(), 'flags.json'),
    url: 'https://flags.example.test/api/flags',
    version: '1',
    channel: () => 'stable',
    fetch: async () => ({ ok: true, json: async () => ({ [key]: false, [disabledNativeKey]: true }) }),
  });
  assert.equal(flags.snapshot()[key], true);
  await flags.refresh();
  assert.equal(flags.snapshot()[key], false);
  assert.equal(flags.isEnabled(disabledNativeKey), false);
  flags.stop();
});

test('installed registry switches coexist with native platform defaults and unpackaged development overrides', () => {
  registerRegistryAgents([agent('platform-flags')]);
  const key = 'harness.acp.registry-platform-flags.enabled';
  for (const platform of ['darwin', 'linux', 'win32']) {
    const defaults = defaultsFor(platform);
    assert.equal(defaults['harness.claude.enabled'], true);
    assert.equal(defaults['tier.basic.enabled'], true);
    assert.equal(Object.hasOwn(defaults, key), false, 'installed metadata cannot rewrite native build defaults');
    const flags = new Flags({ platform, file: path.join(directory(), 'flags.json'), version: '1', channel: () => 'stable' });
    try {
      const snapshot = flags.snapshot();
      assert.deepEqual(Object.fromEntries(Object.keys(defaults).map((nativeKey) => [nativeKey, snapshot[nativeKey]])), defaults);
      for (const [nativeKey, enabled] of Object.entries(defaults))
        assert.equal(flags.isEnabled(nativeKey), enabled, `${platform}: ${nativeKey}`);
      assert.equal(snapshot[key], true);
      assert.equal(flags.isEnabled(key), true);
    } finally {
      flags.stop();
    }
  }
  const raw = `@dev,${key}=0`;
  const options = {
    now: Date.UTC(2026, 10, 3),
    defs: [{ key: 'shared.perf.probe', mode: 'toggle', remove: '2026-12-01' }],
  };
  const override = localOverride(false, raw, options);
  assert.deepEqual(override, { 'shared.perf.probe': true, [key]: false });
  assert.deepEqual(localOverride(true, raw, options), {});
  const flags = new Flags({ file: path.join(directory(), 'flags.json'), version: '1', channel: () => 'stable', override });
  assert.equal(flags.snapshot()[key], false);
  assert.equal(flags.isEnabled('shared.perf.probe'), true);
  assert.equal(flags.isEnabled('harness.claude.enabled'), true);
  assert.equal(isEnabled(key), true, 'a local override cannot change another Flags owner');
  flags.stop();
});

test('startup preserves the native admission set and adds only registry agents installed in this user-data scope', () => {
  registerRegistryAgents([agent('metadata-only')]);
  const dir = directory();
  const common = { ids: ['kimi'], quirks, resolveBin: () => null, env: () => ({}), dataDir: dir, tools: NO_SAGE_MCP };
  const admission = openAdmission({
    common,
    app: Object.assign(new EventEmitter(), { getPath: () => dir }),
    broadcastAll: () => {},
  });
  try {
    assert.deepEqual(common.ids, ['kimi']);
    assert.equal(admission.o.ids.includes('registry-metadata-only'), false);
  } finally {
    admission.registry.dispose();
  }
});

test('main installs and admits agents with no window, restores managed paths on restart and refuses missing resume or tool handshakes', async () => {
  for (const blocked of ['none', 'resume', 'tools']) {
    const dir = directory();
    const app = Object.assign(new EventEmitter(), { getPath: () => dir });
    const broadcasts: any[] = [];
    const discovered: string[] = [];
    const common = {
      ids: ['kimi'],
      quirks,
      resolveBin: (_id: string) => null,
      discoverBin: (id: string) => {
        discovered.push(id);
      },
      env: () => ({}),
      dataDir: dir,
      tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => blocked !== 'tools', end: () => {} },
      spawnFn: fakeSpawn({ initialize: () => INIT({ loadSession: blocked !== 'resume' }) }).spawnFn,
    };
    const admission = openAdmission({ common, app, broadcastAll: (ch: string, value: any) => broadcasts.push([ch, value]) });
    const service = admission.registry;
    service.which = which;
    service.platform = 'linux';
    service.catalog.agents = [agent(`admission-${blocked}`)];
    service.installer = fakeInstall;
    const installed = await service.install(`admission-${blocked}`, () => assert.fail('fake needs no manager'));
    const h = admission.list().find((h: any) => h.id === installed.id)!;
    assert.equal(h.state, blocked === 'none' ? 'admitted' : 'unsupported', h.reason);
    assert.ok(h.descriptor.registry);
    assert.ok(h.authBin.endsWith('/authenticate'));
    assert.equal(common.resolveBin(installed.id), installed.file);
    assert.equal(common.resolveBin('kimi'), null);
    assert.deepEqual(discovered, [], 'managed launchers bypass automatic selection');
    await admission.refresh({ only: 'kimi' });
    assert.deepEqual(discovered, ['kimi'], 'external harnesses use the selection policy');
    assert.equal(
      broadcasts.some(([ch]) => ch === 'acp:harnesses'),
      true,
    );
    assert.equal(broadcasts.find(([ch]) => ch === 'flags:changed')[1][`harness.acp.${installed.id}.enabled`], true);
    const restored = openAdmission({
      common: { ...common, ids: ['kimi'] },
      app: Object.assign(new EventEmitter(), { getPath: () => dir }),
      broadcastAll: () => {},
    });
    assert.equal(restored.registry.resolve(installed.id), installed.file);
    assert.equal(restored.o.ids.includes(installed.id), true);
    restored.registry.dispose();
    app.emit('will-quit');
    assert.equal(service.closed, true);
  }
  await assert.rejects(NO_SAGE_MCP.prepare(), /tool bridge.*missing/);
  assert.equal(await NO_SAGE_MCP.admission(), false);
  NO_SAGE_MCP.end();
});

test('terminal authentication replaces the registry ACP arguments through its separate managed launcher', () => {
  const h: any = {
    label: 'Registry agent',
    bin: '/managed/launch',
    authBin: '/managed/authenticate',
    login: null,
    authMethods: [{ id: 'login', type: 'terminal', args: ['login'], env: { LOGIN: '1' } }],
  };
  assert.deepEqual(loginCommand(h, 'login'), {
    command: ['/managed/authenticate', 'login'],
    env: { LOGIN: '1' },
    title: 'Registry agent login',
  });
});
