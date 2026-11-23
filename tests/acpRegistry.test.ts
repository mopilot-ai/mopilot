// ACP registry metadata cannot inject paths or commands, and unsupported distributions never become usable harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryAgent, registryAgents, registryDistribution, registryDescriptor, containedCommand } from '../shared/acpRegistry.mjs';

const agent = () => ({
  id: 'example',
  name: 'Example',
  version: '1.2.3',
  website: 'https://example.com/docs',
  distribution: { npx: { package: '@example/agent', args: ['--acp'] } },
});

test('registry distributions pin packages, preserve literal arguments and negotiate a target before launch', () => {
  const parsed = registryAgent(agent());
  assert.equal(parsed.distribution.npx!.package, '@example/agent@1.2.3');
  assert.deepEqual(registryDistribution(parsed, { platform: 'linux', arch: 'x64', npm: true }), {
    kind: 'npx',
    package: '@example/agent@1.2.3',
    args: ['--acp'],
    env: Object.create(null),
  });
  assert.equal(registryDistribution(parsed, { platform: 'linux', arch: 'x64' }), null);
  assert.equal(registryDistribution(parsed, { platform: 'freebsd', arch: 'x64', npm: true }), null);
  assert.equal(registryDistribution(parsed, { platform: 'linux', arch: 'ia32', npm: true }), null);
  const descriptor = registryDescriptor(parsed);
  assert.equal(descriptor.id, 'registry-example');
  assert.equal(descriptor.enabled, true);
  assert.equal(descriptor.acp.admission.requireResume, true);
  assert.equal(descriptor.registry, parsed);
});

test('only checksummed binaries outrank package transports and Python packages receive an explicit version', () => {
  const parsed = registryAgent({
    ...agent(),
    distribution: {
      binary: {
        'linux-x86_64': {
          archive: 'https://example.com/agent.tar.gz',
          cmd: './bin/agent',
          sha256: 'A'.repeat(64),
          args: [],
          env: { AGENT_MODE: 'acp' },
        },
      },
      npx: { package: '@example/agent@1.2.3' },
      uvx: { package: 'agent' },
    },
  });
  const binary = registryDistribution(parsed, { platform: 'linux', arch: 'x64', npm: true });
  assert.equal(binary!.kind, 'binary');
  assert.equal((binary as any).sha256, 'a'.repeat(64));
  assert.equal(registryDistribution(parsed, { platform: 'darwin', arch: 'arm64', uv: true })!.kind, 'uvx');
  assert.equal(parsed.distribution.uvx!.package, 'agent==1.2.3');
  delete parsed.distribution.binary!['linux-x86_64'].sha256;
  assert.equal(registryDistribution(parsed, { platform: 'linux', arch: 'x64', npm: true })!.kind, 'npx');
  assert.equal(registryDistribution(parsed, { platform: 'linux', arch: 'x64' }), null);
});

test('malformed identities, paths, URLs, packages, arguments and environments are refused before installation', () => {
  const invalid = [
    null,
    [],
    {},
    { ...agent(), id: '../agent' },
    { ...agent(), id: '__proto__' },
    { ...agent(), version: 'latest' },
    { ...agent(), name: '' },
    { ...agent(), website: 'file:///tmp/agent' },
    { ...agent(), website: 'https://user:password@example.com' },
    { ...agent(), distribution: {} },
    { ...agent(), distribution: { npx: { package: '--package=other' } } },
    { ...agent(), distribution: { npx: { package: 'https://example.com/agent' } } },
    { ...agent(), distribution: { npx: { package: 'agent', args: ['\0'] } } },
    { ...agent(), distribution: { npx: { package: 'agent', env: { 'X=Y': 'value' } } } },
    { ...agent(), distribution: { binary: { 'linux-x86_64': { archive: 'https://example.com/a', cmd: '../../bin/agent' } } } },
    { ...agent(), distribution: { binary: { 'linux-x86_64': { archive: 'https://example.com/a', cmd: './agent', sha256: 'bad' } } } },
  ];
  for (const entry of invalid) assert.throws(() => registryAgent(entry), /ACP registry contains an invalid/);
  for (const command of ['../agent', '/bin/agent', 'C:\\agent.exe', './bin/../agent', '.', '', 'bin\\agent', 'agent\0'])
    assert.equal(containedCommand(command), false, command);
  assert.equal(containedCommand('./bin/agent'), true);
  assert.equal(containedCommand('agent'), true);
});

test('a full snapshot validates atomically and cannot replace an agent with a duplicate identity', () => {
  assert.equal(registryAgents({ agents: [agent()] }).length, 1);
  for (const snapshot of [null, {}, { agents: {} }, { agents: [agent(), agent()] }, { agents: [agent(), null] }])
    assert.throws(() => registryAgents(snapshot), /ACP registry contains an invalid/);
});

test('documentation, authors and descriptions use validated fallbacks instead of trusting optional registry fields', () => {
  for (const website of [false, 4, '', 'https://', 'not a URL'])
    assert.throws(() => registryAgent({ ...agent(), website }), /documentation URL/);
  for (const extra of [{ repository: 'https://example.com/source' }, { docsUrl: 'https://example.com/help' }, {}]) {
    const parsed = registryAgent({ ...agent(), website: undefined, ...extra });
    assert.equal(parsed.docsUrl, Object.values(extra)[0] ?? 'https://agentclientprotocol.com/registry');
  }
  for (const [authors, vendor, expected] of [
    [['Ada', 'Lin'], 'Vendor', 'Ada, Lin'],
    [[], 'Vendor', 'Vendor'],
    [[''], 'Vendor', 'Vendor'],
    [null, '', 'ACP registry'],
  ] as const) {
    const parsed = registryAgent({ ...agent(), authors, vendor, description: 'A coding agent' });
    assert.equal(parsed.vendor, expected);
    assert.equal(parsed.description, 'A coding agent');
  }
});

test('non-object distributions and malformed binary targets are refused, while Windows commands and optional checksums normalize', () => {
  for (const distribution of [null, false, [], { binary: null }, { binary: [] }, { binary: { 'linux-x86_64': null } }])
    assert.throws(() => registryAgent({ ...agent(), distribution }), /invalid/);
  for (const kind of ['npx', 'uvx'])
    for (const raw of [null, [], false, 1, 'package'])
      assert.throws(() => registryAgent({ ...agent(), distribution: { [kind]: raw } }), /package/);
  for (const cmd of [undefined, null, 1])
    assert.throws(
      () => registryAgent({ ...agent(), distribution: { binary: { 'windows-x86_64': { cmd, archive: 'https://example.com/a.zip' } } } }),
      /binary target/,
    );
  const parsed = registryAgent({
    ...agent(),
    distribution: { binary: { 'windows-x86_64': { archive: 'https://example.com/a.zip', cmd: 'bin\\agent.exe' } } },
  });
  assert.deepEqual(
    { ...parsed.distribution.binary!['windows-x86_64'] },
    {
      archive: 'https://example.com/a.zip',
      cmd: 'bin/agent.exe',
      args: [],
      env: Object.create(null),
    },
  );
  assert.equal(registryDistribution(parsed, { platform: 'win32', arch: 'x64' }), null, 'an unchecked binary is never selected');
});
