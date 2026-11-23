// What a machine row's Install, Sign in and Update do for a paired phone (electron/app/hostPhone.cjs `agents`, electron/remote/methods/host.cjs, shared/remote/schema.mjs): the same operations the Mac's buttons call, a machine that is not listed or is away refused first, a sign-in's page left for the phone to open, and every parameter checked before anything runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { ok, fail, fakeHost } from './support/remoteHostKit.ts';

const require = createRequire(import.meta.url);
const { createHostPhone } = require('../electron/app/hostPhone.cjs');

function facade() {
  const calls: any[][] = [];
  const answer =
    (name: string) =>
    (...args: any[]) => (calls.push([name, ...args]), { name });
  const phone = createHostPhone({
    allowed: () => true,
    watch: () => undefined,
    machines: () => ({
      list: () => ({
        machines: [
          { id: 'on', name: 'Box', status: 'online' },
          { id: 'off', name: 'Mini', status: 'offline' },
        ],
      }),
      row: () => undefined,
    }),
    folders: () => ({ list: async () => ({}) }),
    machineChats: { newChatId: () => 'x', start: async () => ({ listed: Promise.resolve() }) },
    enqueue: () => null,
    setMode: () => undefined,
    announce: () => undefined,
    move: async () => undefined,
    plan: async () => null,
    ownership: { get: () => ({ hostId: 'local' }) },
    orgCovers: () => false,
    agents: () => ({
      installAgent: answer('installAgent'),
      cancelInstall: (...a: any[]) => (calls.push(['cancelInstall', ...a]), true),
      installStatus: answer('installStatus'),
      signIn: answer('signIn'),
      signInInput: async (...a: any[]) => (calls.push(['signInInput', ...a]), false),
      cancelSignIn: (...a: any[]) => (calls.push(['cancelSignIn', ...a]), false),
      signInStatus: () => null,
      updateHost: async (...a: any[]) => (calls.push(['updateHost', ...a]), { state: 'updating' }),
    }),
    changed: () => undefined,
    projects: () => [],
  });
  return { agents: phone.agents, calls };
}

test('install, sign in and update run the row’s own operations; a sign-in is not opened on this Mac', async () => {
  const { agents, calls } = facade();
  assert.deepEqual(agents.install('on', 'codex'), { name: 'installAgent' });
  assert.deepEqual(agents.signIn('on', 'claude'), { name: 'signIn' });
  assert.deepEqual(await agents.update('on'), { state: 'updating' });
  assert.deepEqual(calls, [
    ['installAgent', 'on', 'codex'],
    ['signIn', 'on', 'claude', undefined, false],
    ['updateHost', 'on'],
  ]);
});

test('cancels and the typed code say whether anything was under way; status reports both operations', async () => {
  const { agents, calls } = facade();
  assert.deepEqual(agents.installCancel('on', 'codex'), { cancelled: true });
  assert.deepEqual(agents.signInCancel('on', 'claude'), { cancelled: false });
  assert.deepEqual(await agents.signInInput('on', 'claude', 'ABCD'), { accepted: false });
  assert.deepEqual(agents.status('on', 'codex'), { install: { name: 'installStatus' }, signIn: null });
  assert.deepEqual(calls[2], ['signInInput', 'on', 'claude', 'ABCD']);
});

test('a machine that is not listed or is away is refused before anything starts', async () => {
  const { agents, calls } = facade();
  for (const [name, args] of [
    ['install', ['codex']],
    ['signIn', ['claude']],
    ['update', []],
  ] as const) {
    assert.throws(() => (agents as any)[name]('nowhere', ...args), { code: 'unknown_machine' });
    assert.throws(() => (agents as any)[name]('off', ...args), { code: 'offline', message: /Mini isn't reachable/ });
  }
  assert.deepEqual(calls, []);
});

const ASKS: [string, object, string[]][] = [
  ['machines.install', { id: 'ssh:box', harness: 'codex' }, ['install', 'ssh:box', 'codex']],
  ['machines.installCancel', { id: 'ssh:box', harness: 'codex' }, ['installCancel', 'ssh:box', 'codex']],
  ['machines.signIn', { id: 'ssh:box', harness: 'claude' }, ['signIn', 'ssh:box', 'claude']],
  ['machines.signInInput', { id: 'ssh:box', harness: 'claude', text: 'ABCD' }, ['signInInput', 'ssh:box', 'claude', 'ABCD']],
  ['machines.signInCancel', { id: 'ssh:box', harness: 'claude' }, ['signInCancel', 'ssh:box', 'claude']],
  ['machines.agentStatus', { id: 'ssh:box', harness: 'gemini' }, ['status', 'ssh:box', 'gemini']],
  ['machines.update', { id: 'ssh:box' }, ['update', 'ssh:box']],
];

for (const [method, params, call] of ASKS)
  test(`${method}: a phone reaches Host’s operation with the checked parameters`, async () => {
    const { host, calls } = fakeHost();
    const r = rig({ host: () => host });
    const out = ok(await r.phone('p1').ask(method, params));
    assert.equal(out.name, call[0]);
    assert.deepEqual(calls.at(-1), call);
  });

test('an account without Host gets none of them; a refusal Host coded keeps its code', async () => {
  const { host } = fakeHost();
  host.open = false;
  for (const [method, params] of ASKS)
    fail(
      await rig({ host: () => host })
        .phone('p1')
        .ask(method, params),
      'forbidden',
    );
  const { host: h2 } = fakeHost({
    agents: {
      install: async () => {
        throw Object.assign(new Error('That machine cannot install that agent from here.'), { code: 'invalid' });
      },
    },
  });
  fail(
    await rig({ host: () => h2 })
      .phone('p1')
      .ask('machines.install', { id: 'ssh:box', harness: 'codex' }),
    'invalid',
    /cannot install/,
  );
});

test('parameters that are not a machine, an agent, or a code to type are refused before the operation', async () => {
  const { host, calls } = fakeHost();
  const p = rig({ host: () => host }).phone('p1');
  fail(await p.ask('machines.install', { id: 'x y', harness: 'codex' }), 'invalid', /isn't one of yours/);
  for (const harness of [undefined, '', 'a b', 'x'.repeat(65), 7])
    fail(await p.ask('machines.signIn', { id: 'ssh:box', harness }), 'invalid', /isn't one this machine lists/);
  for (const text of [undefined, '', '   ', 'x'.repeat(1025), 5])
    fail(await p.ask('machines.signInInput', { id: 'ssh:box', harness: 'claude', text }), 'invalid', /Type the code/);
  assert.equal(calls.length, 0);
});
