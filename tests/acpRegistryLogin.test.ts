// Managed registry authentication keeps metadata, typed and legacy terminal commands on the installed owner's launcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCommand, loginTerminal } from '../src/harness/acpLogin.ts';
import { NAV } from '../src/lib/settingsNav.ts';
import { registryAgent, registryDescriptor } from '../shared/acpRegistry.mjs';

const agent = registryAgent({
  id: 'owned-agent',
  name: 'Owned agent',
  version: '1.0.0',
  distribution: { npx: { package: '@owned/agent' } },
});
const harness = (authMethods: any[] = [], extra: object = {}) =>
  ({
    id: 'registry-owned-agent',
    label: 'Owned agent',
    bin: '/managed/launch',
    authBin: '/managed/authenticate',
    descriptor: registryDescriptor(agent),
    login: null,
    authMethods,
    ...extra,
  }) as any;

test('registry metadata own alias and exact launcher path use the auth owner with literal args and env', () => {
  for (const command of ['owned-agent', 'launch', '/managed/launch']) {
    const h = harness([
      {
        id: 'login',
        type: 'terminal',
        args: ['wrong-typed-fallback'],
        _meta: { 'terminal-auth': { command, args: ['login', 'literal $HOME', 7], env: { LOGIN: '1', BAD: false }, label: 'Sign in' } },
      },
    ]);
    const expected = { command: ['/managed/authenticate', 'login', 'literal $HOME'], env: { LOGIN: '1' }, title: 'Sign in' };
    assert.deepEqual(loginCommand(h, 'login'), expected);
    assert.deepEqual(loginTerminal(h), expected);
  }
});

test('registry typed and legacy terminal authentication share the same managed owner', () => {
  const expected = { command: ['/managed/authenticate', 'login'], title: 'Owned agent login' };
  assert.deepEqual(loginCommand(harness([{ id: 'login', _meta: { type: 'terminal', args: ['login'] } }]), 'login'), expected);
  assert.deepEqual(loginTerminal(harness([], { login: ['owned-agent', 'login'] })), expected);
});

test('an explicitly unavailable auth owner never falls back to a PATH copy or the ACP launcher', () => {
  const directory = NAV.find((item) => item.id === 'other-harnesses');
  assert.ok(directory, 'managed agent recovery has a reachable settings section');
  for (const method of [
    { id: 'login', type: 'terminal', args: ['login'] },
    { id: 'login', _meta: { 'terminal-auth': { command: 'owned-agent', args: ['login'] } } },
    { id: 'login', _meta: { 'terminal-auth': { command: '/managed/launch', args: ['login'] } } },
  ]) {
    const h = harness([method], { authBin: null, login: ['owned-agent', 'login'] });
    const selected: any = loginCommand(h, 'login');
    assert.equal(selected.command, null);
    assert.match(selected.reason, /Repair.*Owned agent/);
    assert.ok(selected.reason.includes(`${directory.label} → Agent directory`), 'Repair guidance names the current settings path');
    assert.deepEqual(loginTerminal(h), selected);
  }
});

test('malformed protocol terminal commands yield an explicit refusal without throwing or selecting ACP auth', () => {
  for (const command of [7, {}, true, null, '', 'bad\0command']) {
    const h = harness([{ id: 'login', _meta: { 'terminal-auth': { command } } }]);
    const selected: any = loginCommand(h, 'login');
    assert.equal(selected.command, null);
    assert.match(selected.reason, /invalid terminal sign-in command/);
    assert.deepEqual(loginTerminal(h), selected);
  }
});

test('explicit different helper commands and paths retain their own literal arguments', () => {
  for (const command of ['node', '/different/owned-agent', './owned-agent']) {
    const h = harness([{ id: 'login', _meta: { 'terminal-auth': { command, args: ['helper.js'], env: { HELPER: '1' } } } }]);
    assert.deepEqual(loginCommand(h, 'login'), { command: [command, 'helper.js'], env: { HELPER: '1' }, title: 'Owned agent login' });
  }
});

test('validated registry binary names are genuine own aliases without guessing npm executable names', () => {
  const binary = registryAgent({
    ...agent,
    distribution: {
      binary: {
        'linux-x86_64': { cmd: 'bin/vendor-cli', archive: 'https://example.test/linux.tgz' },
        'darwin-aarch64': { cmd: 'vendor-cli', archive: 'https://example.test/mac.tgz' },
        'windows-x86_64': { cmd: 'bin/vendor-cli.exe', archive: 'https://example.test/win.zip' },
      },
      npx: { package: '@owned/different-package' },
    },
  });
  const descriptor = registryDescriptor(binary);
  assert.deepEqual(descriptor.bins, ['owned-agent', 'vendor-cli', 'vendor-cli.exe']);
  const h = harness([{ id: 'login', _meta: { 'terminal-auth': { command: 'vendor-cli.exe', args: ['login'] } } }], { descriptor });
  assert.deepEqual(loginTerminal(h)?.command, ['/managed/authenticate', 'login']);
});

test('native path/suffix mapping and absent-bin terminal behavior remain supported', () => {
  const native = harness([{ id: 'login', _meta: { 'terminal-auth': { command: 'vendor', args: ['login'] } } }], {
    descriptor: undefined,
    authBin: undefined,
    bin: 'C:\\tools\\vendor.cmd',
  });
  assert.deepEqual(loginTerminal(native)?.command, ['C:\\tools\\vendor.cmd', 'login']);
  assert.equal(loginTerminal(harness([{ id: 'login', type: 'terminal' }], { bin: null, authBin: undefined })), null);
});
