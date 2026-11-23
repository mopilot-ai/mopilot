// Adding a machine that fails says why with one action (shared/host/installFailure.mjs, the Add machine card): each cause in words, Try again re-runs the add, Copy command copies the fix; one that succeeds offers Start a chat on it; and removing a machine takes MoPilot's key off it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  click,
  button,
  text,
  setValue,
  flush,
} from './support/settings-harness.ts';
import { useFakeProc } from './support/ports/proc.ts';
// @ts-ignore: plain ESM, typed by its .d.mts
import { explainFailure, explainBootFailure } from '../shared/host/installFailure.mjs';
const require = createRequire(import.meta.url);
const { deauthorizeCommand, revokeKey } = require('../electron/host/sshKey.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Opens the Add machine sheet (one field, no tabs). */
async function openSheet(host: Element) {
  await click(button(host, 'Add machine'));
}

test('each failure is said as its cause with one action', () => {
  const at = (step: string, output: string, destination = 'me@box') =>
    explainFailure({ step, output, target: 'Du’s Mac mini', destination });
  const cases: [string, string, RegExp, string][] = [
    ['connect', "This machine's host key changed since you last connected. If it wasn't reinstalled…", /identity changed/, 'copy'],
    ['connect', 'ssh: connect to host 192.168.1.5 port 22: Connection refused', /^Turn on Remote Login on /, 'wait'],
    ['connect', 'ssh: Could not resolve hostname nowhere: nodename nor servname provided', /^Can’t find Du’s Mac mini$/, 'retry'],
    ['connect', 'ssh: connect to host 10.0.0.9 port 22: Operation timed out', /^Du’s Mac mini didn’t answer$/, 'retry'],
    ['connect', 'me@box: Permission denied (publickey,password).', /didn’t accept the sign-in/, 'account'],
    ['connect', 'FreeBSD amd64: only Linux and macOS machines are supported.', /MoPilot can’t run on/, 'copy'],
    ['connect', 'something odd', /^Couldn’t install on Du’s Mac mini$/, 'retry'],
    ['upload', 'cat: write error: No space left on device', /out of disk space/, 'retry'],
    ['key', "MoPilot couldn't add its key to the machine.", /Couldn’t set up sign-in/, 'retry'],
    ['node', 'something else broke', /Couldn’t set up Node/, 'retry'],
    ['status', 'The Host is installed but not running yet.', /installed but didn’t start/, 'retry'],
    ['start', '', /installed but didn’t start/, 'retry'],
    // M6: the question was declined, so nothing failed on the machine (whatever ssh printed after)
    ['connect', 'MoPilot: no answer was given to ssh.\nHost key verification failed.', /^You didn’t connect to /, 'retry'],
    [
      'connect',
      'MoPilot: no answer was given to ssh.\nme@box: Permission denied (publickey,password).',
      /^You didn’t connect to /,
      'retry',
    ],
    // M11: a machine that takes keys only is not a wrong password
    ['connect', 'me@box: Permission denied (publickey).', /only takes keys/, 'account'],
    // M14
    ['connect', 'Connection closed by 10.0.0.9 port 22', /^Lost the connection to /, 'retry'],
    ['connect', 'kex_exchange_identification: read: Connection reset by peer', /^Lost the connection to /, 'retry'],
    // M15: its sshd turned the key away: copy details, not a Try again that cannot help
    [
      'key',
      "MoPilot's key is on the machine, but the machine still won't sign in with it (does its sshd allow keys?).",
      /won’t sign in with MoPilot’s key/,
      'copy',
    ],
    // M16
    ['node', 'MoPilot needs a 64-bit Intel or ARM machine; this one is Linux armv7l.', /^MoPilot can’t run on /, 'copy'],
    [
      'node',
      'Node v22.1.0 does not run on this machine (Linux needs glibc 2.28 or newer), and it has no Node 22 or newer of its own.',
      /Linux is too old/,
      'retry',
    ],
    ['node', 'Neither this Mac nor the machine could get Node v22.1.0.\ncurl: (6)', /can’t get Node/, 'retry'],
    // M17
    [
      'prepare',
      'MoPilot has no Host build for this machine (linux-arm); a Host already on it keeps running.',
      /^MoPilot has no Host for /,
      'copy',
    ],
    ['prepare', 'Could not ask this machine which Host build it needs: Timed out.', /^Couldn’t prepare the Host for /, 'retry'],
    // M19
    ['upload', 'Timed out.', /^Couldn’t copy MoPilot to /, 'retry'],
    ['verify', 'got abc123', /^Couldn’t copy MoPilot to /, 'retry'],
    ['unpack', 'tar: Unexpected EOF', /^Couldn’t copy MoPilot to /, 'retry'],
  ];
  for (const [step, output, title, kind] of cases) {
    const f = at(step, output);
    assert.match(f.title, title, `${step}: ${output}`);
    assert.equal(f.action.kind, kind, `${step}: ${output}`);
  }
  assert.deepEqual(at('connect', 'host key changed since you last connected', 'me@box').action, {
    kind: 'copy',
    label: 'Copy command',
    text: 'ssh-keygen -R box',
  });
  assert.equal(
    (at('connect', 'host key changed since you last connected', "it's here") as any).action.text,
    "ssh-keygen -R 'it'\\''s here'",
  );
  assert.equal(at('node', '\n\nfirst real line\nmore').reason, 'first real line');
  const reason = (step: string, output: string) => explainFailure({ step, output, target: 'box', destination: 'me@box' }).reason;
  assert.equal(reason('connect', 'MoPilot: no answer was given to ssh.'), 'The question wasn’t answered.');
  assert.match(reason('upload', 'Timed out.'), /too slow/);
  assert.match(reason('verify', 'got abc'), /damaged/);
  assert.equal(reason('unpack', 'tar: Unexpected EOF'), 'tar: Unexpected EOF');
  assert.match(reason('node', 'Node v22 does not run (glibc 2.28), and it has no Node 24 or newer.'), /Install Node 24 on it/);
  assert.match(reason('node', 'glibc'), /Install Node 22 on it/);
  assert.match(reason('key', "still won't sign in with it"), /PubkeyAuthentication/);
  // M11: this Mac's key is offered to authorize; without one the way on is another account
  const key = 'ssh-ed25519 AAAA mopilot';
  assert.deepEqual(at('connect', 'me@box: Permission denied (publickey).').action, { kind: 'account', label: 'Use another account' });
  const keyed = explainFailure({
    step: 'connect',
    output: 'Permission denied (publickey).',
    target: 'box',
    destination: 'me@box',
    publicKey: key,
  });
  assert.deepEqual(keyed.action, {
    kind: 'copy',
    label: 'Copy key',
    text: key,
  });
  assert.match(keyed.reason, /authorized_keys/);
  // a machine that offers a password is the existing wrong-password cause
  assert.match(at('connect', 'Permission denied (publickey,keyboard-interactive).').title, /didn’t accept/);
  // M20/M21/M24: a step that undid the install says so; one that could not undo it keeps the plain cause
  const undone = (step: string, output: string) =>
    explainFailure({
      step,
      output,
      target: 'box',
      destination: 'me@box',
      rolledBack: true,
    });
  assert.deepEqual(undone('unit', 'unit write failed'), {
    title: 'Couldn’t set up the service on box',
    reason: 'unit write failed. The install was undone.',
    action: { kind: 'retry' },
    cause: 'other',
  });
  assert.equal(at('unit', 'unit write failed').reason, 'unit write failed');
  assert.match(at('unit', '').title, /^Couldn’t set up the service on /);
  assert.deepEqual(undone('start', 'Failed to connect to bus.'), {
    title: 'MoPilot didn’t start on box',
    reason: 'Failed to connect to bus. The install was undone.',
    action: { kind: 'retry' },
    cause: 'other',
  });
  assert.equal(
    undone('status', 'The Host is installed but not running yet.').reason,
    'The Host is installed but not running yet. The install was undone.',
  );
  assert.equal(undone('status', '').reason, 'It did not start. The install was undone.');
  assert.match(at('start', 'x').title, /installed but didn’t start/);
  // M29
  assert.equal(explainBootFailure('This app has no relay to add a machine by command.')?.action.kind, 'ssh');
  assert.equal(explainBootFailure('The relay said no.'), null);
});

let finish: (v: unknown) => void = () => undefined;
beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.discover': () => Promise.resolve([]),
    'host.add': () => new Promise((r) => (finish = r)),
    'clipboard.write': () => Promise.resolve(),
  });
  calls.length = 0;
});
async function addBox() {
  const view = await renderMachines();
  await flush();
  await openSheet(view.host);
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  return view;
}

test('a refused sign-in says so and puts the host back in the field for another account', async (t) => {
  const view = await addBox();
  t.after(() => view.unmount());
  finish({
    ok: false,
    paired: false,
    error: 'me@box: Permission denied (publickey,password).',
    id: '',
    steps: [{ id: 'connect', label: 'Connect', state: 'failed', output: 'denied' }],
  });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'me@box didn’t accept the sign-in');
  // the machine's user isn't this Mac's: the field gets the host in and the name still to type, which Add won't take empty
  await click(button(view.host, 'Use another account'));
  const field = view.host.querySelector('input[aria-label="Machine"]') as HTMLInputElement;
  assert.equal(field.value, '@box');
  assert.equal(button(view.host, 'Add').disabled, true);
  assert.equal(view.host.querySelector('.host-install'), null, 'the failure is gone');
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 1);
});

test('a machine not accepting ssh (a Mac with Remote Login off) says how to turn it on, is asked again every 3 s, and is added as soon as it answers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let up = false;
  responses['host.reachable'] = () => Promise.resolve(up);
  const view = await addBox();
  t.after(() => view.unmount());
  finish({
    ok: false,
    paired: false,
    error: 'ssh: connect to host dus-mac-mini.local port 22: Connection refused',
    id: '',
    steps: [{ id: 'connect', label: 'Connect', state: 'failed', output: '' }],
  });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Turn on Remote Login on me@box');
  assert.match(text(view.host.querySelector('[role=alert]')), /System Settings → General → Sharing.*Adding continues by itself\./);
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.reachable'),
    [['host.reachable', 'me@box']],
  );
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 1, 'not yet');
  up = true;
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 2, 'added again by itself');
});

test('waiting stops after ten minutes, and a check that fails or overlaps is not counted as an answer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let answer: (v: boolean) => void = () => undefined;
  let mode: 'hang' | 'fail' | 'no' = 'hang';
  responses['host.reachable'] = () =>
    mode === 'hang' ? new Promise<boolean>((r) => (answer = r)) : mode === 'fail' ? Promise.reject(new Error('x')) : Promise.resolve(false);
  const view = await addBox();
  t.after(() => view.unmount());
  finish({
    ok: false,
    paired: false,
    error: 'Connection refused',
    id: '',
    steps: [{ id: 'connect', label: 'Connect', state: 'failed', output: '' }],
  });
  await flush();
  assert.ok(button(view.host, 'Check again'));
  t.mock.timers.tick(3000);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.reachable').length, 1, 'one check at a time');
  answer(false);
  await flush();
  mode = 'fail';
  t.mock.timers.tick(3000);
  await flush();
  mode = 'no';
  for (let i = 0; i < 205; i++) {
    t.mock.timers.tick(3000);
    await flush();
  }
  const asked = calls.filter((c) => c[0] === 'host.reachable').length;
  assert.ok(asked <= 200, String(asked));
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.reachable').length, asked, 'stopped');
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 1);
});

test('a failure with no message of its own reads from its step; one with neither still says it failed', async (t) => {
  const view = await addBox();
  t.after(() => view.unmount());
  finish({
    ok: false,
    paired: false,
    error: '',
    id: '',
    steps: [{ id: 'node', label: 'Set up Node', state: 'failed', output: 'no curl' }],
  });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Couldn’t set up Node on me@box');
  assert.match(text(view.host.querySelector('[role=alert]')), /^no curl/);
  await click(button(view.host, 'Try again'));
  finish({ ok: false, paired: false, error: '', id: '', steps: [] });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Couldn’t install on me@box');
});

test('a changed host key offers the command that fixes it, copied', async (t) => {
  const view = await addBox();
  t.after(() => view.unmount());
  finish({
    ok: false,
    paired: false,
    error: "This machine's host key changed since you last connected. If it wasn't reinstalled…",
    id: '',
    steps: [],
  });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'me@box’s identity changed');
  await click(button(view.host, 'Copy command'));
  assert.deepEqual(
    calls.find((c) => c[0] === 'clipboard.write'),
    ['clipboard.write', 'ssh-keygen -R box'],
  );
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === 'Copied'));
  responses['clipboard.write'] = () => Promise.reject(new Error('denied'));
  await click(button(view.host, 'Copy command'));
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === 'Couldn’t copy'));
});

test('a machine added and paired offers Start a chat on it, which opens a new chat on that machine', async (t) => {
  const view = await addBox();
  t.after(() => view.unmount());
  finish({ ok: true, paired: true, error: '', id: 'ssh:me@box', steps: [] });
  await flush();
  await click(button(view.host, 'Start a chat on it'));
  assert.deepEqual(
    calls.find((c) => c[0] === 'pickNewChatHost'),
    ['pickNewChatHost', { id: 'ssh:me@box', name: 'me@box' }],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'navigate'),
    ['navigate', { name: 'home' }],
  );
});

test('MoPilot’s key comes off the machine: only its own line, a file with nothing else, a file that is not there', (t) => {
  const home = tmp(t);
  const pub = 'ssh-ed25519 AAAAmine mopilot@mac';
  const file = path.join(home, '.ssh', 'authorized_keys');
  const run = () =>
    spawnSync('/bin/sh', ['-c', deauthorizeCommand(pub)], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(run().stdout.trim(), 'removed', 'no file: nothing to remove');
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  fs.writeFileSync(file, `ssh-ed25519 AAAAother me@laptop\n${pub}\n`);
  assert.equal(run().stdout.trim(), 'removed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ssh-ed25519 AAAAother me@laptop\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, `${pub}\n`);
  assert.equal(run().stdout.trim(), 'removed');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.throws(() => deauthorizeCommand('nope'), /not an ed25519 public key/);
});

test('revokeKey runs the removal with the key’s own public half and says whether it worked', async (t) => {
  const dir = tmp(t);
  const identity = path.join(dir, 'mopilot_ed25519');
  fs.writeFileSync(`${identity}.pub`, 'ssh-ed25519 AAAAmine mopilot@mac\n');
  const ran: string[] = [];
  assert.equal(await revokeKey({ identity, run: async (c: string) => (ran.push(c), { code: 0, stdout: 'removed\n', stderr: '' }) }), true);
  assert.match(ran[0], /AAAAmine/);
  assert.equal(await revokeKey({ identity, run: async () => ({ code: 255, stdout: '', stderr: 'unreachable' }) }), false);
});

test('removing a machine that signed in with MoPilot’s key takes the key off it; one that used its own setup is left alone', async (t) => {
  const records = [
    {
      id: 'ssh:keyed',
      name: 'k',
      address: 'me@keyed',
      socketPath: '',
      harnesses: [],
      capabilities: {},
      identity: '/u/.ssh/mopilot_ed25519',
    },
    { id: 'ssh:own', name: 'o', address: 'me@own', socketPath: '', harnesses: [], capabilities: {}, identity: '' },
  ];
  const registry: any = {
    list: () => records,
    resolved: () => true,
    onChange: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    check: async () => undefined,
    remove: (id: string) =>
      records.splice(
        records.findIndex((r) => r.id === id),
        1,
      ),
  };
  const revoked: string[][] = [];
  let failNext = false;
  const m = createMachines({
    dir: tmp(t),
    registry,
    installer: {} as any,
    allowed: () => true,
    watch: () => () => undefined,
    pool: { get: () => ({}) } as any,
    keyAccess: {
      probe: async () => ({ code: 0, stdout: '', stderr: '' }),
      ensure: async () => ({ file: '', pub: '' }),
      consent: async () => true,
      revoke: async (d: string, i: string) => (revoked.push([d, i]), failNext ? Promise.reject(new Error('gone')) : true),
    },
  });
  t.after(() => m.dispose());
  m.remove('ssh:own');
  m.remove('ssh:keyed');
  assert.deepEqual(revoked, [['me@keyed', '/u/.ssh/mopilot_ed25519']]);
  records.push({
    id: 'ssh:k2',
    name: 'k2',
    address: 'me@k2',
    socketPath: '',
    harnesses: [],
    capabilities: {},
    identity: '/u/.ssh/mopilot_ed25519',
  });
  failNext = true;
  m.remove('ssh:k2');
  await flush();
  assert.equal(revoked.length, 2, 'an unreachable machine only keeps the line');
});

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  pid = 1;
  kill = () => true;
}
test('IPC: the app takes the key off over a connection signed in with that key', async (t) => {
  const dir = tmp(t);
  const identity = path.join(dir, 'mopilot_ed25519');
  fs.writeFileSync(`${identity}.pub`, 'ssh-ed25519 AAAAmine mopilot@mac\n');
  let opts: any;
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { allowed: () => true, create: (o: any) => ((opts = o), { list: () => ({ machines: [], resolved: true }) }) },
  );
  await handlers.get('host:machines')({});
  const spawned: string[][] = [];
  useFakeProc(t, {
    spawn: (_b: string, args: string[]) => {
      spawned.push(args);
      const c = new Child();
      setImmediate(() => (c.stdout.emit('data', Buffer.from('removed\n')), c.emit('close', 0)));
      return c;
    },
  });
  assert.equal(await opts.keyAccess.revoke('me@box', identity), true);
  assert.ok(spawned[0].join(' ').includes(`-i ${identity} -o IdentitiesOnly=yes -- me@box`));
});
