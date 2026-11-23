// MoPilot's own ssh key for a machine that took a password (electron/host/sshKey.cjs): made once per Mac user with ssh-keygen, appended once to the machine's authorized_keys (run for real in a scratch home), proved on a fresh connection, remembered on the machine's record, and used for the tunnel, port forwards and every later command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeProc } from './support/ports/proc.ts';
import { machine, bundle, added, registry as fakeRegistry } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { ensureKey, authorizeCommand, identityArgs, keySignIn, validIdentity, KEY_NAME } = require('../electron/host/sshKey.cjs');
const { createInstaller } = require('../electron/host/install.cjs');
const { createSshChannel, createSshProbe } = require('../electron/host/sshChannel.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { createMachines } = require('../electron/host/machines.cjs');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mpkey-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('the key is made once with ssh-keygen (no passphrase, owner-only) and kept; a half-made pair is made again', async (t) => {
  const home = tmp(t);
  const k = await ensureKey({ home, comment: 'mopilot@Du s Mac' });
  assert.equal(k.file, path.join(home, '.ssh', KEY_NAME));
  assert.match(k.pub, /^ssh-ed25519 \S+ mopilot@Du-s-Mac$/);
  assert.equal(fs.statSync(k.file).mode & 0o777, 0o600);
  // no passphrase: ssh-keygen reads the public half back from the private one without asking
  assert.equal(spawnSync('ssh-keygen', ['-y', '-P', '', '-f', k.file]).status, 0);
  const again = await ensureKey({ home, keygen: async () => assert.fail('made twice') });
  assert.equal(again.pub, k.pub);
  fs.rmSync(`${k.file}.pub`);
  const remade = await ensureKey({ home, comment: 'x' });
  assert.notEqual(remade.pub, k.pub);
  // a public half that is not an ed25519 key is refused
  fs.writeFileSync(`${k.file}.pub`, 'ssh-rsa AAAA x\n');
  await assert.rejects(ensureKey({ home }), /is not an ed25519 public key/);
});

/** What execFile hands back, as the ssh-keygen that already ended (it can still be stopped, as the app does when it quits). */
class Done extends EventEmitter {
  kill = () => true;
}
test('a failed ssh-keygen says why', async (t) => {
  useFakeProc(t, {
    execFile: (_b: string, _a: string[], _o: any, cb: any) => (
      cb(new Error('exit 1'), '', 'Saving key failed: Permission denied\n'), new Done()
    ),
  });
  await assert.rejects(ensureKey({ home: tmp(t) }), /ssh-keygen failed: Saving key failed: Permission denied/);
  useFakeProc(t, { execFile: (_b: string, _a: string[], _o: any, cb: any) => (cb(new Error('spawn ENOENT'), '', ''), new Done()) });
  await assert.rejects(ensureKey({ home: tmp(t) }), /ssh-keygen failed: spawn ENOENT/);
});

test("the key goes into the machine's authorized_keys once, with the permissions sshd insists on", (t) => {
  const home = tmp(t);
  const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbc mopilot@Jane's-Mac";
  const run = () => spawnSync('/bin/sh', ['-c', authorizeCommand(pub)], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAother me@laptop\n', { mode: 0o644 });
  assert.equal(run().stdout.trim(), 'authorized');
  assert.equal(run().stdout.trim(), 'authorized');
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), `ssh-ed25519 AAAAother me@laptop\n${pub}\n`);
  assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);
  assert.throws(() => authorizeCommand('ssh-ed25519 AAAA\nrm -rf ~'), /not an ed25519 public key/);
  assert.deepEqual(identityArgs('/k'), ['-i', '/k', '-o', 'IdentitiesOnly=yes']);
  assert.deepEqual(identityArgs(''), []);
  assert.equal(validIdentity('/Users/me/.ssh/mopilot_ed25519'), true);
  for (const bad of ['rel/key', '/a\nb', 7, `/${'x'.repeat(1100)}`]) assert.equal(validIdentity(bad), false);
});

const yes = async () => true;

test('key sign-in: nothing when the own setup works; else the key is added and proved; each failure says what and keeps no identity', async () => {
  const ok = { code: 0, stdout: '', stderr: '' };
  const no = { code: 255, stdout: '', stderr: 'Permission denied (publickey,password).' };
  const key = { file: '/u/.ssh/mopilot_ed25519', pub: 'ssh-ed25519 AAAA mopilot@mac' };
  const ran: string[] = [];
  const run = async (c: string) => (ran.push(c), { code: 0, stdout: 'authorized\n', stderr: '' });
  assert.deepEqual(await keySignIn({ run, probe: async () => ok, ensure: async () => assert.fail('no key needed'), consent: yes }), {
    ok: true,
    identity: '',
    output: 'Signs in with your own ssh key; nothing to add.',
  });
  const probed: string[][] = [];
  const probe = async (args: string[]) => (probed.push(args), args.length ? ok : no);
  const out = await keySignIn({ run, probe, ensure: async () => key, consent: yes });
  assert.equal(out.ok, true);
  assert.equal(out.identity, key.file);
  assert.match(out.output, /reconnects in the background, so it added its own key \(~\/\.ssh\/mopilot_ed25519\); no password from now on/);
  assert.deepEqual(probed, [[], ['-i', key.file, '-o', 'IdentitiesOnly=yes']], 'proved with exactly that key');
  assert.match(ran[0], /authorized_keys/);
  assert.match(
    (await keySignIn({ run, probe: async () => no, ensure: async () => Promise.reject(new Error('disk full')), consent: yes })).output,
    /couldn't make its ssh key: Disk full/i,
  );
  const refused = await keySignIn({
    run: async () => ({ code: 1, stdout: '', stderr: 'Read-only file system' }),
    probe: async () => no,
    ensure: async () => key,
    consent: yes,
  });
  assert.deepEqual([refused.ok, refused.output], [false, "MoPilot couldn't add its key to the machine.\nRead-only file system"]);
  const silent = await keySignIn({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    probe: async () => no,
    ensure: async () => key,
    consent: yes,
  });
  assert.equal(silent.output, "MoPilot couldn't add its key to the machine.");
  const still = await keySignIn({ run, probe: async () => no, ensure: async () => key, consent: yes });
  assert.deepEqual([still.ok, still.identity], [false, '']);
  const declined = await keySignIn({
    run,
    probe: async () => no,
    ensure: async () => assert.fail('no key made without a yes'),
    consent: async () => false,
  });
  assert.deepEqual([declined.ok, declined.identity], [false, '']);
  assert.match(declined.output, /chose not to let MoPilot add its key/);
  const asked: string[] = [];
  await keySignIn({ run, probe, ensure: async () => key, consent: async (f: string) => (asked.push(f), true) });
  assert.deepEqual(asked, ['~/.ssh/mopilot_ed25519'], 'asked, with where the key lives, before anything is made');
  assert.match(still.output, /still won't sign in with it \(does its sshd allow keys\?\)\.\nPermission denied/);
});

test('the installer sets up key sign-in right after connecting, records the key on the machine, and a failure there changes nothing', async () => {
  added.length = 0;
  const m = machine();
  const keyAccess = {
    probe: async (_d: string, args: string[]) => ({ code: args.length ? 0 : 255, stdout: '', stderr: '' }),
    ensure: async () => ({ file: '/u/.ssh/mopilot_ed25519', pub: 'ssh-ed25519 AAAA mopilot@mac' }),
    consent: async () => true,
  };
  const machineWithKeys = {
    ...m,
    channel: async (d: string, c: string, i?: Buffer) =>
      c.includes('authorized_keys') ? { code: 0, stdout: 'authorized\n', stderr: '' } : m.channel(d, c, i),
  };
  const out = await createInstaller({ channel: machineWithKeys.channel, registry: fakeRegistry, bundle, keyAccess }).install('me@box');
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.slice(0, 2).map((s: any) => [s.id, s.label, s.state]),
    [
      ['connect', 'Connect', 'ok'],
      ['key', 'Set up key sign-in', 'ok'],
    ],
  );
  assert.equal(added.at(-1).identity, '/u/.ssh/mopilot_ed25519');
  const stuck = await createInstaller({
    channel: m.channel,
    bundle,
    keyAccess: { probe: async () => ({ code: 255, stdout: '', stderr: 'denied' }), ensure: keyAccess.ensure, consent: yes },
  }).install('me@box');
  assert.deepEqual([stuck.failedStep, stuck.rolledBack], ['key', false]);
  assert.match(stuck.error, /couldn't add its key/);
});

test("the machine's key is kept in the registry file and read back; a malformed one is dropped", (t) => {
  const file = path.join(tmp(t), 'host-registry.json');
  const r = createRegistry({ file, status: async () => ({}) });
  r.add({ id: 'ssh:a', address: 'me@a', identity: '/u/.ssh/mopilot_ed25519' });
  r.add({ id: 'ssh:b', address: 'me@b', identity: 'relative/key' });
  const again = createRegistry({ file, status: async () => ({}) });
  assert.deepEqual(
    again.list().map((x: any) => [x.id, x.identity]),
    [
      ['ssh:a', '/u/.ssh/mopilot_ed25519'],
      ['ssh:b', ''],
    ],
  );
  fs.writeFileSync(file, JSON.stringify({ hosts: [{ id: 'ssh:c', name: 'c', address: 'c', identity: '/a\nb' }] }));
  assert.equal(createRegistry({ file, status: async () => ({}) }).list()[0].identity, '');
  r.dispose();
  again.dispose();
});

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  pid = 1;
  kill = () => true;
}
test('every command to a machine carries its key; the probe never shares a connection and asks nothing', async (t) => {
  const calls: string[][] = [];
  useFakeProc(t, {
    spawn: (_b: string, args: string[]) => {
      calls.push(args);
      const c = new Child();
      setImmediate(() => c.emit('close', 0));
      return c;
    },
  });
  const ssh = createSshChannel({ argsFor: (d: string) => (d === 'me@box' ? identityArgs('/k') : []) });
  await ssh('me@box', 'x');
  await ssh('other', 'x');
  assert.deepEqual(calls[0].slice(-7), ['-i', '/k', '-o', 'IdentitiesOnly=yes', '--', 'me@box', 'x']);
  assert.deepEqual(calls[1].slice(-3), ['--', 'other', 'x']);
  await createSshProbe()('me@box', identityArgs('/k'));
  assert.ok(calls[2].includes('BatchMode=yes'));
  assert.deepEqual(calls[2].slice(-11), [
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-i',
    '/k',
    '-o',
    'IdentitiesOnly=yes',
    '--',
    'me@box',
    'true',
  ]);
});

test("the tunnel, port forwards and commands use the key on the machine's record", async (t) => {
  const dir = tmp(t);
  const record = {
    id: 'ssh:box',
    name: 'box',
    address: 'me@box',
    socketPath: '/h/host.sock',
    harnesses: [] as any[],
    capabilities: {},
    identity: '/u/.ssh/mopilot_ed25519',
  };
  const targets: any[] = [];
  const forwarded: any[] = [];
  const registry: any = {
    list: () => [record],
    resolved: () => true,
    onChange: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    check: async () => undefined,
    remove: () => undefined,
  };
  const m = createMachines({
    dir,
    registry,
    installer: {} as any,
    allowed: () => true,
    watch: () => () => undefined,
    pool: {
      get: (target: any) => (
        targets.push(target),
        {
          acquire: () => ({ socketPath: '/l', ready: Promise.resolve(false), release: () => undefined }),
          state: () => 'offline',
          onState: () => () => undefined,
        }
      ),
    } as any,
    forwards: { forward: async (f: any) => (forwarded.push(f), { localPort: 1 }), closeMachine: () => undefined, dispose: () => undefined },
  });
  t.after(() => m.dispose());
  await m.forwardPort('ssh:box', 5173);
  assert.deepEqual(forwarded[0].sshArgs, ['-i', record.identity, '-o', 'IdentitiesOnly=yes']);
  await m.call?.(record, 'status').catch(() => undefined);
  m.hostFor?.('ssh:box');
  assert.ok(
    targets.length > 0 && targets.every((x) => x.sshArgs.join(' ') === `-i ${record.identity} -o IdentitiesOnly=yes`),
    JSON.stringify(targets),
  );
  assert.deepEqual(m.sshArgsFor('me@box'), ['-i', record.identity, '-o', 'IdentitiesOnly=yes']);
  assert.deepEqual(m.sshArgsFor('stranger'), []);
});

test('a machines service built without key access never runs the key step, so no test reaches the real ~/.ssh', async (t) => {
  const m = machine();
  const ran: string[] = [];
  const svc = createMachines({
    dir: tmp(t),
    channel: async (d: string, c: string, i?: Buffer) => (ran.push(c), m.channel(d, c, i)),
    allowed: () => true,
    watch: () => () => undefined,
    pool: { get: () => ({}) } as any,
    call: async () => ({}),
  });
  t.after(() => svc.dispose());
  await svc.add('me@box').catch(() => undefined);
  assert.ok(!ran.some((c) => c.includes('authorized_keys')));
});
