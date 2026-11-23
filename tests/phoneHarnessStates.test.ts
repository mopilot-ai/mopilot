// The phone keeps what the Mac says about each agent and machine: Host sign-in wait, path and last seen; every agent's state and whether a chat can move to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { scripted } from './support/phone/m3';
const machinesPath = '../mobile/src/remote/machines';
const clientPath = '../mobile/src/remote/client';
const statesPath = '../mobile/src/remote/harnessStates';
const { parseMachines } = await import(machinesPath);
const { ownedRequest } = await import(clientPath);
const { parseHarnessStates, loadHarnessStates, switchTargets } = await import(statesPath);

test('a machine keeps its Host sign-in wait, path and last seen; unknown words are quiet', () => {
  const [host, odd] = parseMachines({
    machines: [
      { id: 'h', line: 'Waiting for sign-in', path: 'relay', lastSeen: 1700, waitingForLogin: 'restarted' },
      { id: 'o', line: 'x', path: 'wormhole', lastSeen: 'yesterday', waitingForLogin: 'locked' },
    ],
  });
  assert.deepEqual([host.path, host.lastSeen, host.waitingForLogin], ['relay', 1700, 'restarted']);
  assert.deepEqual([odd.path, odd.lastSeen, odd.waitingForLogin], [null, null, null]);
  assert.equal(parseMachines({ machines: [{ id: 'd', line: 'x', path: 'direct', waitingForLogin: 'signed-out' }] })[0].path, 'direct');
});

const rows = [
  { id: 'claude', label: 'Claude Code', kind: 'builtin', state: 'ready', canSwitch: true },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'builtin',
    state: 'ready',
    canSwitch: false,
    switchReason: 'Pick a model for Codex in MoPilot first.',
  },
  { id: 'acp:gem', label: 'Gemini', kind: 'acp', state: 'signin', reason: 'Sign in', canSwitch: false },
  { id: 'acp:kimi', label: 'Kimi Code', kind: 'acp', state: 'weird', canSwitch: true },
  { label: 'no id' },
  null,
];

test('agent rows keep the Mac’s label, state and switch answer; an old Mac sends none', () => {
  const parsed = parseHarnessStates({ states: rows })!;
  assert.deepEqual(
    parsed.map((h: any) => [h.id, h.label, h.kind, h.state, h.canSwitch, h.switchReason]),
    [
      ['claude', 'Claude Code', 'builtin', 'ready', true, null],
      ['codex', 'Codex', 'builtin', 'ready', false, 'Pick a model for Codex in MoPilot first.'],
      ['acp:gem', 'Gemini', 'acp', 'signin', false, null],
      ['acp:kimi', 'Kimi Code', 'acp', 'checking', true, null],
    ],
  );
  assert.equal(parsed[2].reason, 'Sign in');
  assert.equal(parseHarnessStates({}), null);
  assert.equal(parseHarnessStates({ states: 'no' }), null);
  assert.equal(parseHarnessStates(null), null);
  assert.deepEqual(parseHarnessStates({ states: [{ id: 'x' }] })![0], {
    id: 'x',
    label: 'x',
    kind: 'builtin',
    state: 'checking',
    reason: null,
    canSwitch: false,
    switchReason: null,
  });
});

test('switch targets are what the Mac accepts, minus the chat’s own agent', () => {
  const parsed = parseHarnessStates({ states: rows });
  assert.deepEqual(
    switchTargets(parsed, 'claude')!.map((h: any) => h.id),
    ['acp:kimi'],
  );
  assert.deepEqual(
    switchTargets(parsed, null)!.map((h: any) => h.id),
    ['claude', 'acp:kimi'],
  );
  assert.equal(switchTargets(null, 'claude'), null);
});

test('loadHarnessStates asks for states once; a Mac without the method, or one that sends none, gives null', async () => {
  const mk = (methods: string[], reply: any) => {
    const { runtime, calls } = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods } } : reply));
    return { request: ownedRequest(runtime), calls };
  };
  const ok = mk(['harnesses.list'], { harnesses: [], states: rows });
  assert.equal((await loadHarnessStates(ok.request))!.length, 4);
  assert.deepEqual(ok.calls.at(-1), ['harnesses.list', { states: true }]);
  assert.equal(await loadHarnessStates(mk([], {}).request), null);
  assert.equal(await loadHarnessStates(mk(['harnesses.list'], { harnesses: [] }).request), null);
  const { runtime } = scripted((m) => {
    if (m === 'machine.hello') throw new Error('old');
    return { states: rows };
  });
  assert.equal((await loadHarnessStates(ownedRequest(runtime)))!.length, 4);
});
