// A phone installs, signs in and updates through the real chain with only the machine faked: remote service → Host's phone facade → the machine row's agent actions → sign-in and install runners → the machine's Host calls. The page of a phone's sign-in comes back in the view and is not opened on this Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { ok, fail, row } from './support/remoteHostKit.ts';

const require = createRequire(import.meta.url);
const { createHostPhone } = require('../electron/app/hostPhone.cjs');
const { createMachineAgents } = require('../electron/host/machineAgents.cjs');

const PAGE = 'https://claude.ai/login/device?code=WXYZ';
const record = {
  id: 'ssh:box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  status: 'online',
  harnesses: [
    { id: 'claude', detected: true, signedIn: false },
    { id: 'codex', detected: false, installable: true },
  ],
};

function world() {
  const wire: string[] = [];
  const opened: string[] = [];
  let signedIn = false;
  const remote: any = {
    connect: async () => undefined,
    login: async (p: any) => (wire.push(`login ${p.harness}`), { state: 'waiting' }),
    loginStatus: async () => ({ state: 'waiting', links: [PAGE], codes: ['WXYZ'] }),
    loginCancel: async () => true,
    loginInput: async (p: any) => (wire.push(`input ${p.text}`), (signedIn = true), { accepted: true }),
    install: async (p: any) => (wire.push(`install ${p.harness}`), { state: 'running', line: 'Installing Codex…' }),
    installStatus: async () => ({ state: 'running', line: 'Installing Codex…' }),
    installCancel: async () => (wire.push('installCancel'), true),
    status: async () => ({ harnesses: [{ id: 'claude', detected: true, signedIn }] }),
  };
  const agents = createMachineAgents({
    registry: { list: () => [record], check: async () => undefined },
    hostFor: () => remote,
    openExternal: (url: string) => void opened.push(url),
    onSignin: () => undefined,
    onInstall: () => undefined,
    refuseUnlessAllowed: () => undefined,
  });
  const actions = { ...agents.actions, updateHost: async (id: string) => (wire.push(`update ${id}`), { state: 'updating' }) };
  const host = createHostPhone({
    allowed: () => true,
    watch: () => undefined,
    machines: () => ({ list: () => ({ machines: [record] }), row: () => undefined }),
    folders: () => ({ list: async () => ({}) }),
    machineChats: { newChatId: () => 'x', start: async () => ({ listed: Promise.resolve() }) },
    enqueue: () => null,
    setMode: () => undefined,
    announce: () => undefined,
    move: async () => undefined,
    plan: async () => null,
    ownership: { get: () => ({ hostId: 'local' }) },
    orgCovers: () => false,
    agents: () => actions,
    changed: () => undefined,
    projects: () => [],
  });
  host.rows = () => [row({ id: 'ssh:box', agents: [] })];
  host.record = () => record;
  return { host, wire, opened, agents };
}
const until = async (fn: () => Promise<any>) => {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error('timed out');
};

test('a phone signs in to an agent on a machine: the page and code come back for the phone, and typing the code finishes it', async () => {
  const w = world();
  const p = rig({ host: () => w.host }).phone('p1');
  const first = ok(await p.ask('machines.signIn', { id: 'ssh:box', harness: 'claude' }));
  assert.equal(first.harness, 'claude');
  const status = await until(async () => {
    const s = ok(await p.ask('machines.agentStatus', { id: 'ssh:box', harness: 'claude' }));
    return s.signIn?.url ? s : null;
  });
  assert.equal(status.signIn.url, PAGE);
  assert.deepEqual(status.signIn.codes, ['WXYZ']);
  assert.equal(status.install, null);
  assert.deepEqual(w.opened, [], 'the Mac’s own browser is not opened for a phone’s sign-in');
  assert.deepEqual(ok(await p.ask('machines.signInInput', { id: 'ssh:box', harness: 'claude', text: 'WXYZ' })), { accepted: true });
  assert.deepEqual(ok(await p.ask('machines.signInCancel', { id: 'ssh:box', harness: 'claude' })), { cancelled: true });
  assert.deepEqual(
    w.wire.filter((l) => l !== 'login claude'),
    ['input WXYZ'],
  );
  w.agents.dispose();
});

test('a phone installs an agent the machine can install, follows it, cancels it, and updates the Host', async () => {
  const w = world();
  const p = rig({ host: () => w.host }).phone('p1');
  const view = ok(await p.ask('machines.install', { id: 'ssh:box', harness: 'codex' }));
  assert.deepEqual([view.harness, view.state], ['codex', 'queued']);
  const status = await until(async () => {
    const s = ok(await p.ask('machines.agentStatus', { id: 'ssh:box', harness: 'codex' }));
    return s.install?.line ? s : null;
  });
  assert.equal(status.install.line, 'Installing Codex…');
  assert.deepEqual(ok(await p.ask('machines.installCancel', { id: 'ssh:box', harness: 'codex' })), { cancelled: true });
  assert.deepEqual(ok(await p.ask('machines.update', { id: 'ssh:box' })), { state: 'updating' });
  assert.ok(w.wire.includes('install codex') && w.wire.includes('update ssh:box'));
  w.agents.dispose();
});

test('an agent the machine does not list, and a machine that is not listed, are refused in the Mac’s words', async () => {
  const w = world();
  const p = rig({ host: () => w.host }).phone('p1');
  fail(await p.ask('machines.signIn', { id: 'ssh:box', harness: 'nothing' }), 'invalid', /does not list that agent/);
  fail(await p.ask('machines.install', { id: 'ssh:box', harness: 'claude' }), 'invalid', /cannot install that agent/);
  fail(await p.ask('machines.install', { id: 'ssh:nowhere', harness: 'codex' }), 'unknown_machine');
  w.agents.dispose();
});
