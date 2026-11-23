// A scheduled task's machine: which store and native app own it (shared/scheduleTask.mjs), the agent a machine runs it with, how a machine's agent stands for an unattended run (shared/host/agentReadiness.mjs, electron/host/machineChatStart.cjs), and what the dialog says of it (src/lib/scheduleMachine.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { machineOf, nativeAppOf, storeHomeOf, desktopRuns, machineHarnessOf, canRememberChat } from '../shared/scheduleTask.mjs';
import { agentsOf } from '../shared/host/agentReadiness.mjs';
import { parseMachineList, type HostMachineRow } from '../src/lib/hostMachines.ts';
import {
  THIS_MAC,
  agentIdOf,
  machineCredential,
  machineHint,
  machineRunWith,
  machineWhere,
  ownSignIn,
  runWithOfAgent,
} from '../src/lib/scheduleMachine.ts';

const require = createRequire(import.meta.url);
const { createMachineChatStart, harnessName } = require('../electron/host/machineChatStart.cjs');

test('a task’s machine, store and native app: a machine task is MoPilot’s on every harness', () => {
  assert.equal(machineOf({}), null);
  assert.equal(machineOf({ host_id: '' }), null);
  assert.equal(machineOf({ host_id: 7 }), null);
  assert.equal(machineOf({ host_id: 'box' }), 'box');
  assert.equal(nativeAppOf({}), 'codex-app');
  assert.equal(nativeAppOf({ harness: 'claude' }), 'claude-desktop');
  assert.equal(nativeAppOf({ harness: 'acp:kimi' }), null);
  assert.equal(nativeAppOf({ harness: 'claude', host_id: 'box' }), null);
  assert.equal(storeHomeOf({}), 'codex');
  assert.equal(storeHomeOf({ harness: 'codex', host_id: 'box' }), 'mopilot');
  assert.equal(storeHomeOf({ harness: 'claude' }), 'mopilot');
  assert.equal(desktopRuns({ harness: 'claude' }), true);
  assert.equal(desktopRuns({ harness: 'claude', host_id: 'box' }), false);
  assert.equal(desktopRuns({ harness: 'codex' }), false);
  assert.equal(machineHarnessOf({}), 'codex');
  assert.equal(machineHarnessOf({ harness: 'claude' }), 'claude');
  assert.equal(machineHarnessOf({ harness: 'acp:kimi' }), 'kimi');
  const hb = { kind: 'heartbeat', harness: 'claude', host_id: 'box' };
  assert.equal(canRememberChat(hb, hb), true);
  assert.equal(canRememberChat(hb, { ...hb, host_id: 'other' }), false);
  assert.equal(canRememberChat(hb, { ...hb, host_id: undefined }), false);
});

test('an agent ready only through this Mac’s key or lease is marked lent; one signed in there is not', () => {
  const agents = agentsOf(
    [
      { id: 'claude', detected: true, signedIn: true },
      { id: 'codex', detected: true, signedIn: false, keyed: true },
      { id: 'kimi', detected: true, signedIn: false },
    ],
    'box',
  );
  assert.deepEqual(
    agents.map((a) => [a.id, a.state, a.lent ?? false]),
    [
      ['claude', 'ready', false],
      ['codex', 'ready', true],
      ['kimi', 'signin', false],
    ],
  );
  const list = parseMachineList({
    resolved: true,
    machines: [
      {
        id: 'box',
        name: 'box',
        status: 'online',
        note: '',
        agents: [...agents, { id: 'x', label: 'X', state: 'ready', reason: '', lent: 'yes' }],
      },
    ],
  });
  assert.deepEqual(
    list?.machines[0].agents.map((a) => a.lent ?? false),
    [false, true, false, false],
  );
});

const row = (o: Partial<HostMachineRow> = {}): HostMachineRow => ({
  id: 'box',
  name: 'box',
  status: 'online',
  note: '',
  signin: null,
  capabilities: { iab: true, cu: true },
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'codex', label: 'Codex', state: 'ready', reason: '', lent: true },
    { id: 'kimi', label: 'Kimi Code', state: 'signin', reason: 'Sign in on box' },
    { id: 'gemini', label: 'Gemini CLI', state: 'missing', reason: 'Not installed on box' },
  ],
  installable: [],
  lastSeen: null,
  localNetwork: 'unknown',
  waitingForLogin: null,
  startsAtBoot: 'unknown',
  fileVault: 'unknown',
  platform: '',
  ...o,
});

test('Runs on: the machine’s hint, the agents it can run a task with, and their harness ids', () => {
  assert.equal(THIS_MAC, 'local');
  assert.equal(machineHint(row()), '');
  assert.equal(machineHint(row({ status: 'offline' })), 'Offline');
  assert.equal(machineHint(row({ status: 'attention' })), 'Sign in on box');
  assert.equal(machineHint(row({ status: 'attention', agents: [] })), 'Needs attention');
  assert.deepEqual(machineRunWith(row()), [
    { id: 'claude', label: 'Claude Code', note: '', disabled: false },
    { id: 'codex', label: 'Codex', note: '', disabled: false },
    { id: 'acp:kimi', label: 'Kimi Code', note: 'Needs sign-in', disabled: false },
  ]);
  assert.deepEqual(machineRunWith(undefined), []);
  assert.equal(agentIdOf('acp:kimi'), 'kimi');
  assert.equal(agentIdOf('claude'), 'claude');
  assert.equal(runWithOfAgent('codex'), 'codex');
  assert.equal(runWithOfAgent('kimi'), 'acp:kimi');
  assert.equal(machineWhere('box', true), 'box runs it on schedule, even while this Mac is off.');
  assert.equal(machineWhere('box', false), 'This Mac starts each run on box, so it needs this Mac on.');
  assert.deepEqual(
    ['claude', 'codex', 'acp:kimi', 'acp:gemini', 'acp:none'].map((h) => ownSignIn(row(), h as any)),
    [true, false, false, false, false],
  );
  assert.equal(ownSignIn(undefined, 'claude'), false);
});

test('the credential line says how a run on the machine signs in, before Save', () => {
  assert.deepEqual(machineCredential(row(), 'claude', 'Claude Code'), { text: 'Signed in on box', tone: 'ok' });
  assert.deepEqual(machineCredential(row({ status: 'offline' }), 'claude', 'Claude Code'), {
    text: 'Signed in on box · Offline now',
    tone: 'ok',
  });
  assert.deepEqual(machineCredential(row(), 'codex', 'Codex'), { text: "Uses this Mac's key · needs this Mac online", tone: 'ok' });
  assert.deepEqual(machineCredential(row(), 'acp:kimi', 'Kimi Code'), { text: 'Sign in to Kimi Code on box', tone: 'warn' });
  assert.deepEqual(machineCredential(row(), 'acp:gemini', 'Gemini CLI'), { text: "Gemini CLI isn't installed on box", tone: 'warn' });
  assert.deepEqual(machineCredential(row(), 'acp:none', 'none'), { text: "none isn't installed on box", tone: 'warn' });
  assert.deepEqual(machineCredential(undefined, 'claude', 'Claude Code'), { text: "This machine isn't in your list", tone: 'warn' });
});

function starter(o: { row?: any; key?: boolean; org?: boolean } = {}) {
  const seen: any[] = [];
  const s = createMachineChatStart({
    row: () => ('row' in o ? o.row : { name: 'box', harnesses: [] }),
    apiKeys: { hasFor: () => o.key === true },
    orgAccess: { covers: () => o.org === true },
    bind: (...a: any[]) => seen.push(['bind', ...a]),
    begin: (...a: any[]) => seen.push(['begin', ...a]),
    follow: async (id: string) => void seen.push(['follow', id]),
  });
  return { s, seen };
}

test('the machine starter: ready by its own sign-in, by a lent key or lease, or refused with the reason', async () => {
  const signedOut = { name: 'box', harnesses: [{ id: 'codex', detected: true, signedIn: false, takesKey: true, takesOrg: true }] };
  assert.equal(starter({ row: signedOut }).s.readiness('box', 'codex').error.message, 'Sign in to Codex on box.');
  assert.equal(starter({ row: signedOut, key: true }).s.readiness('box', 'codex').by, 'lent');
  assert.equal(starter({ row: signedOut, org: true }).s.readiness('box', 'codex').by, 'lent');
  const noTake = { name: 'box', harnesses: [{ id: 'codex', detected: true, signedIn: false }] };
  assert.equal(starter({ row: noTake, key: true, org: true }).s.readiness('box', 'codex').ok, false);
  // a basic agent signs in outside MoPilot: installed is ready
  const basic = { name: 'box', harnesses: [{ id: 'kimi', detected: true, signedIn: false }] };
  assert.equal(starter({ row: basic }).s.readiness('box', 'kimi').by, 'machine');
  assert.equal(starter({ row: null }).s.readiness('box', 'kimi').error.code, 'unknown_machine');
  assert.equal(starter().s.readiness('box', 'kimi').error.message, "Kimi Code isn't installed on box.");
  assert.equal(harnessName('claude'), 'Claude Code');
  assert.equal(harnessName('kimi'), 'kimi');
  const { s, seen } = starter({ row: basic });
  assert.match(s.newChatId('kimi'), /^acp:kimi:[0-9a-f-]{36}$/);
  assert.deepEqual(await s.start({ chatId: 'acp:kimi:c', hostId: 'box', folder: '/srv', harness: 'kimi' }), {
    chatId: 'acp:kimi:c',
    by: 'machine',
  });
  assert.deepEqual(seen, [
    ['bind', 'acp:kimi:c', { hostId: 'box', folder: '/srv' }],
    ['begin', 'acp:kimi:c', { harness: 'acp:kimi', projectId: null }],
    ['follow', 'acp:kimi:c'],
  ]);
  await assert.rejects(s.start({ chatId: 'acp:other:c', hostId: 'box', folder: '/srv', harness: 'kimi' }), { code: 'invalid' });
  await assert.rejects(starter({ row: null }).s.start({ chatId: 'acp:kimi:c', hostId: 'box', folder: '/srv', harness: 'kimi' }), {
    code: 'unknown_machine',
  });
});

test('an agent the Host could not check is no promise of an offline-safe run, and says so before Save (#5177)', () => {
  const unsure = row({
    agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: 'Couldn’t check Claude Code on box', unsure: true }],
  });
  assert.deepEqual(machineCredential(unsure, 'claude', 'Claude Code'), { text: 'Couldn’t check Claude Code on box', tone: 'warn' });
  assert.equal(ownSignIn(unsure, 'claude'), false);
});
