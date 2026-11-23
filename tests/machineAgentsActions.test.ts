// The actions a machine's row runs for its agents (electron/host/machineAgents.cjs): each is refused while Host is not available, a sign-in is opened on this Mac unless a phone started it (its page is the phone's to open), and both operations can be read back by machine and agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMachineAgents } = require('../electron/host/machineAgents.cjs');

const record = {
  id: 'ssh:box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  status: 'online',
  harnesses: [
    { id: 'gemini', detected: true, signedIn: false },
    { id: 'codex', detected: false, installable: true },
  ],
};
const PAGE = 'https://accounts.google.com/o/oauth2/auth?x=1';

function world() {
  const state = { allowed: true };
  const opened: string[] = [];
  const host: any = {
    connect: async () => undefined,
    login: async () => ({ state: 'waiting' }),
    loginStatus: async () => ({ state: 'waiting', links: [PAGE], codes: [] }),
    loginCancel: async () => true,
    loginInput: async () => ({ accepted: true }),
    install: async () => ({ state: 'running', line: 'Installing…' }),
    installStatus: async () => ({ state: 'running', line: 'Installing…' }),
    installCancel: async () => true,
    status: async () => ({ harnesses: [] }),
  };
  const agents = createMachineAgents({
    registry: { list: () => [record], check: async () => undefined },
    hostFor: () => host,
    openExternal: (url: string) => void opened.push(url),
    onSignin: () => undefined,
    onInstall: () => undefined,
    refuseUnlessAllowed: () => {
      if (!state.allowed) throw new Error('Host is not available for this account.');
    },
  });
  return { agents, state, opened };
}
const until = async (fn: () => any) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('timed out');
};

test('a sign-in opens its page on this Mac, or only reports it when a phone started it; both can be read back', async () => {
  const mac = world();
  assert.equal(mac.agents.actions.signInStatus('ssh:box', 'gemini'), null);
  mac.agents.actions.signIn('ssh:box', 'gemini');
  await until(() => mac.opened.length === 1);
  assert.equal(mac.agents.actions.signInStatus('ssh:box', 'gemini').url, PAGE);
  mac.agents.dispose();

  const phone = world();
  phone.agents.actions.signIn('ssh:box', 'gemini', undefined, false);
  await until(() => phone.agents.actions.signInStatus('ssh:box', 'gemini')?.url);
  assert.deepEqual(phone.opened, []);
  phone.agents.dispose();
});

test('an install can be read back by machine and agent', async () => {
  const w = world();
  assert.equal(w.agents.actions.installStatus('ssh:box', 'codex'), null);
  w.agents.actions.installAgent('ssh:box', 'codex');
  assert.equal(w.agents.actions.installStatus('ssh:box', 'codex').harness, 'codex');
  w.agents.dispose();
});

test('every action is refused while Host is not available', () => {
  const w = world();
  w.state.allowed = false;
  for (const call of [
    () => w.agents.actions.signIn('ssh:box', 'gemini'),
    () => w.agents.actions.signInStatus('ssh:box', 'gemini'),
    () => w.agents.actions.installStatus('ssh:box', 'codex'),
  ])
    assert.throws(call, /Host is not available/);
});
