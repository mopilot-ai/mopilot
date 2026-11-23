// ssh's questions answered in the app while a machine is added: the prompt text classified (host key, password, passphrase, yes/no, other), the askpass script and its socket run for real (the answer reaches ssh, a cancel or an unknown token fails), the broker that lets only a machine being added ask, and the channel options that make a first-seen host key always asked and share one connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeProc } from './support/ports/proc.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { machine, bundle } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { classifyPrompt, changedHostKey } = require('../electron/host/sshPrompt.cjs');
const { createAskpass } = require('../electron/host/sshAskpass.cjs');
const { createConnectPrompts } = require('../electron/host/connectPrompts.cjs');
const { createSshChannel } = require('../electron/host/sshChannel.cjs');
const { createInstaller } = require('../electron/host/install.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

test('the prompt text says what ssh asks: a first-seen host key (OpenSSH 10 and older), a password, a passphrase, a yes/no, anything else', () => {
  // as OpenSSH 10.5 hands it to askpass (captured from a real first connect)
  const fresh =
    "The authenticity of host '192.168.86.151 (192.168.86.151)' can't be established.\nED25519 key fingerprint is: SHA256:HQwyxhpk6bfAvKWWuPDThdDTaYRFUi0yqek11PJ/bHI\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
  assert.deepEqual(classifyPrompt(fresh), {
    kind: 'hostKey',
    host: '192.168.86.151',
    keyType: 'ED25519',
    fingerprint: 'SHA256:HQwyxhpk6bfAvKWWuPDThdDTaYRFUi0yqek11PJ/bHI',
    text: fresh.trim(),
  });
  const older =
    "The authenticity of host 'box' can't be established.\nECDSA key fingerprint is SHA256:abc+/=.\nAre you sure you want to continue connecting (yes/no)? ";
  assert.equal(classifyPrompt(older).fingerprint, 'SHA256:abc+/=');
  assert.equal(classifyPrompt(older).host, 'box');
  assert.deepEqual(classifyPrompt("daxhill@192.168.86.151's password: "), {
    kind: 'password',
    account: 'daxhill@192.168.86.151',
    text: "daxhill@192.168.86.151's password:",
  });
  assert.equal(classifyPrompt('(me@box) Password: ').account, 'me@box');
  assert.deepEqual(classifyPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': "), {
    kind: 'passphrase',
    key: '/Users/me/.ssh/id_ed25519',
    text: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
  });
  assert.equal(classifyPrompt('Enter passphrase for /k: ').key, '/k');
  assert.equal(classifyPrompt('Allow use of key /k?\nKey fingerprint SHA256:x (yes/no)? ').kind, 'confirm');
  assert.deepEqual(classifyPrompt('(me@box) Verification code: '), { kind: 'secret', text: '(me@box) Verification code:' });
  // a fingerprint line without the question is not a host-key prompt
  assert.equal(classifyPrompt("The authenticity of host 'b' can't be established.\nED25519 key fingerprint is SHA256:x").kind, 'secret');
  assert.equal(changedHostKey('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'), true);
  assert.equal(changedHostKey('Permission denied'), false);
});

/** A netcat that speaks unix sockets, in Node, so the real askpass script runs the same on any CI machine. */
function fakeNc(dir: string) {
  const file = path.join(dir, 'nc');
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nconst s = require('net').connect(process.argv[3]);\nprocess.stdin.pipe(s);\ns.pipe(process.stdout);\ns.on('end', () => process.stdout.write('', () => process.exit(0)));\ns.on('error', () => process.exit(1));\n`,
    { mode: 0o755 },
  );
  return file;
}
const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
/** Runs the askpass program as ssh does: the question as its one argument, its answer on stdout. */
const runAskpass = (env: Record<string, string>, question: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(env.SSH_ASKPASS, [question], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('the askpass script hands the question to the app and prints the answer; a cancel, a failed answer and an unknown token fail it', async (t) => {
  const work = tmp(t);
  const dir = path.join(work, 's');
  const asked: any[] = [];
  let reply: any = 'pä55 word';
  const held: string[] = [];
  let peer: string | null = null;
  const roots: unknown[] = [];
  const ap = createAskpass({
    dir,
    nc: fakeNc(work),
    verifyPeer: async (_s: unknown, root: unknown) => (roots.push(root), peer),
    ask: async (q: any) => {
      asked.push(q);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  t.after(() => ap.close());
  const run = await ap.env({ destination: 'me@box', pid: 4242, pause: () => held.push('pause'), resume: () => held.push('resume') });
  assert.equal(run.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(fs.statSync(run.env.SSH_ASKPASS).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(run.env.MOPILOT_ASKPASS_SOCK).mode & 0o777, 0o600);

  const ok = await runAskpass(run.env, "me@box's password: ");
  assert.deepEqual(ok, { code: 0, stdout: 'pä55 word', stderr: '' });
  assert.equal(asked[0].kind, 'password');
  assert.equal(asked[0].destination, 'me@box');
  assert.deepEqual(held, ['pause', 'resume'], 'the run’s timeout is held while a person answers');
  assert.deepEqual(roots, [4242], 'the asker must run under that run’s ssh');
  // another process of this user that read the token from ssh's environment is never asked about
  peer = 'the peer is not under the harness';
  assert.equal((await runAskpass(run.env, "me@box's password: ")).code, 1);
  assert.equal(asked.length, 1);
  peer = null;

  reply = null;
  // a question nobody answered says so on ssh's stderr, which the add card reads as "You didn't connect"
  assert.deepEqual(await runAskpass(run.env, 'Verification code: '), {
    code: 1,
    stdout: '',
    stderr: 'MoPilot: no answer was given to ssh.\n',
  });
  reply = new Error('window gone');
  assert.equal((await runAskpass(run.env, 'x')).code, 1);
  // a run whose right to ask ended (or a stranger's token) gets nothing
  run.release();
  reply = 'secret';
  assert.equal((await runAskpass(run.env, 'x')).code, 1);
  assert.equal(asked.length, 3);

  // a client that sends far more than a question is cut off
  const flood = net.connect(run.env.MOPILOT_ASKPASS_SOCK);
  await new Promise<void>((resolve) => {
    flood.on('close', () => resolve());
    flood.on('error', () => undefined);
    flood.write('x'.repeat(70 * 1024));
  });
  // a request in pieces is read whole; after the answer, more bytes are ignored
  reply = new Promise((r) => setTimeout(() => r('secret'), 60));
  const again = await ap.env({ destination: 'me@box' });
  const pieces = net.connect(again.env.MOPILOT_ASKPASS_SOCK);
  const answer = await new Promise<string>((resolve) => {
    let got = '';
    pieces.on('data', (d) => (got += d));
    pieces.on('end', () => resolve(got));
    pieces.write(`${again.env.MOPILOT_ASKPASS_TOKEN}\n`);
    setTimeout(() => pieces.write(`${Buffer.from('q').toString('base64')}\n`), 10);
    setTimeout(() => pieces.write('more\n'), 20);
  });
  assert.equal(Buffer.from(answer.trim(), 'base64').toString(), 'secret');

  // closed: the socket goes; asking again starts it afresh
  ap.close();
  assert.equal(fs.existsSync(run.env.MOPILOT_ASKPASS_SOCK), false);
  const fresh = await ap.env({ destination: 'me@box' });
  assert.equal((await runAskpass(fresh.env, 'q')).stdout, 'secret');
});

test('the askpass socket that cannot listen fails the run that asked, and a later run tries again', async (t) => {
  const work = tmp(t);
  // a folder whose socket path is far over the limit cannot be listened on
  const ap = createAskpass({ dir: path.join(work, 'x'.repeat(120)), ask: async () => null, verifyPeer: async () => null });
  await assert.rejects(ap.env({ destination: 'd' }));
  await assert.rejects(ap.env({ destination: 'd' }));
  ap.close();
});

test('only a machine being added may ask; each question takes one answer; open questions are cancelled when the add ends', async () => {
  const events: any[] = [];
  const p = createConnectPrompts({ broadcast: (e: any) => events.push(e) });
  // a heartbeat or an update never prompts
  assert.equal(await p.ask({ destination: 'box', kind: 'password', account: 'me@box', text: 't' }), null);
  assert.equal(events.length, 0);

  let release = () => {};
  const adding = p.during('box', () => new Promise<string>((r) => (release = () => r('added'))));
  const pause = () => undefined;
  const first = p.ask({ destination: 'box', kind: 'password', account: 'me@box', text: 't', pause, resume: pause });
  assert.deepEqual(events[0], {
    id: 'prompt-1',
    destination: 'box',
    prompt: { destination: 'box', kind: 'password', account: 'me@box', text: 't' },
  });
  assert.equal(p.answer('prompt-1', 'pw'), true);
  assert.equal(await first, 'pw');
  assert.deepEqual(events[1], { id: 'prompt-1', destination: 'box', prompt: null });
  assert.equal(p.answer('prompt-1', 'again'), false, 'one answer per question');
  const second = p.ask({ destination: 'box', kind: 'confirm', text: 'ok?' });
  assert.equal(p.answer('prompt-2', { not: 'text' }), true);
  assert.equal(await second, null, 'anything but text cancels');

  // a second add of the same machine joins: the questions stay open until both end
  let releaseJoin = () => {};
  const joined = p.during('box', () => new Promise<void>((r) => (releaseJoin = r)));
  const open = p.ask({ destination: 'box', kind: 'secret', text: 'code' });
  release();
  assert.equal(await adding, 'added');
  assert.equal(events.at(-1).prompt?.kind, 'secret', 'still open while the joined add runs');
  releaseJoin();
  await joined;
  assert.equal(await open, null, 'cancelled when the last add ended');
  assert.deepEqual(events.at(-1), { id: 'prompt-3', destination: 'box', prompt: null });
  assert.equal(await p.ask({ destination: 'box', kind: 'secret', text: 'late' }), null);
});

test('a question nobody answers is cancelled after five minutes, so the add it holds can end', async (t) => {
  const clock = useFakeClock(t);
  const events: any[] = [];
  const p = createConnectPrompts({ broadcast: (e: any) => events.push(e) });
  let done = () => {};
  const adding = p.during('box', () => new Promise<void>((r) => (done = r)));
  const q = p.ask({ destination: 'box', kind: 'password', account: 'me@box', text: 't' });
  clock.advance(5 * 60_000 - 1);
  assert.equal(events.length, 1, 'still open');
  clock.advance(1);
  assert.equal(await q, null);
  assert.deepEqual(events.at(-1), { id: 'prompt-1', destination: 'box', prompt: null });
  done();
  await adding;
});

class Child extends EventEmitter {
  pid = 9000 + Math.floor(Math.random() * 1000);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  kill = () => true;
}

test('with an askpass, ssh may ask, a first-seen host key is always asked, one connection serves every command, and the run releases its token', async (t) => {
  const clock = useFakeClock(t);
  const calls: any[] = [];
  const children: Child[] = [];
  useFakeProc(t, {
    spawn: (bin: string, args: string[], opts: any) => {
      calls.push({ bin, args, opts });
      const c = new Child();
      children.push(c);
      return c;
    },
  });
  const released: string[] = [];
  let ctx: any;
  const askpass = {
    env: async (c: any) => (
      (ctx = c), { env: { SSH_ASKPASS: '/ap.sh', MOPILOT_ASKPASS_TOKEN: 'tok' }, release: () => released.push('tok') }
    ),
  };
  const ssh = createSshChannel({ env: () => ({ PATH: '/x' }), timeoutMs: 1000, askpass, controlDir: '/tmp/cm' });
  const p = ssh('me@box', 'uname -sm');
  await new Promise((r) => setImmediate(r));
  const args = calls[0].args.join(' ');
  assert.match(
    args,
    /^-o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o BatchMode=no -o StrictHostKeyChecking=ask -o ControlMaster=auto -o ControlPath=\/tmp\/cm\/cm-[0-9a-f]{10} -o ControlPersist=60 -o ConnectTimeout=15 -- me@box uname -sm$/,
  );
  assert.deepEqual(calls[0].opts.env, { PATH: '/x', SSH_ASKPASS: '/ap.sh', MOPILOT_ASKPASS_TOKEN: 'tok' });
  assert.equal(ctx.destination, 'me@box');
  assert.equal(ctx.pid, children[0].pid, 'only that ssh and what it starts may ask');
  // a person answering holds the timeout; the clock starts again after the answer
  ctx.pause();
  clock.advance(5000);
  ctx.resume();
  clock.advance(900);
  children[0].emit('close', 0);
  assert.deepEqual(await p, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(released, ['tok']);
  // the same machine shares the connection's path; another gets its own
  ssh('me@box', 'x');
  ssh('other', 'x');
  await new Promise((r) => setImmediate(r));
  const pathOf = (i: number) => calls[i].args.find((a: string) => a.startsWith('ControlPath='));
  assert.equal(pathOf(1), pathOf(0));
  assert.notEqual(pathOf(2), pathOf(0));
  // an answer that never comes is timed out once the person is done
  clock.advance(1000);
  // a folder too deep for ssh's socket: ssh still asks in the app, without a shared connection
  const deep = createSshChannel({ askpass, controlDir: `/${'d'.repeat(80)}` });
  deep('me@box', 'x');
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls[3].args.some((a: string) => a.startsWith('Control')));
  assert.ok(calls[3].args.includes('StrictHostKeyChecking=ask'));
  // an askpass that cannot start fails the command without running ssh
  const broken = createSshChannel({ askpass: { env: async () => Promise.reject(new Error('EADDRINUSE')) }, controlDir: '/c' });
  assert.deepEqual(await broken('me@box', 'x'), { code: -1, stdout: '', stderr: 'MoPilot could not set up its ssh prompt: EADDRINUSE' });
  assert.equal(calls.length, 4);
});

test('a machine whose host key changed is refused in words, never connected to', async () => {
  const m = machine({
    'uname -sm': {
      code: 255,
      stderr: '@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@\nHost key verification failed.',
    },
  });
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
  assert.equal(out.failedStep, 'connect');
  assert.match(out.error, /host key changed since you last connected.*MoPilot did not connect/);
});

test('the shipped askpass script is plain sh: it parses and calls the netcat it was given', (t) => {
  const work = tmp(t);
  const ap = createAskpass({ dir: path.join(work, 'd'), nc: "/opt/it's/nc", ask: async () => null, verifyPeer: async () => null });
  t.after(() => ap.close());
  return ap.env({ destination: 'x' }).then((r: any) => {
    const body = fs.readFileSync(r.env.SSH_ASKPASS, 'utf8');
    assert.equal(spawnSync('/bin/sh', ['-n', r.env.SSH_ASKPASS]).status, 0);
    assert.ok(body.includes(`'/opt/it'\\''s/nc' -U "$MOPILOT_ASKPASS_SOCK"`));
  });
});

test('IPC: ssh may ask in the windows only while that machine is being added; the answer goes back to ssh; quitting closes the askpass', async (t) => {
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  const broadcasts: any[] = [];
  let quit = () => {};
  let ask: any;
  let askDir = '';
  let verify: any;
  let closed = 0;
  let release = (_v: unknown) => {};
  let opts: any;
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    add: () => new Promise((r) => (release = r)),
    dispose: () => undefined,
    sshArgsFor: (d: string) => (d === 'me@box' ? ['-i', '/k', '-o', 'IdentitiesOnly=yes'] : []),
  };
  register(
    ipcMain,
    {
      app: { getPath: () => '/ud', once: (_e: string, fn: () => void) => (quit = fn) },
      shellEnv: { childEnv: () => ({ PATH: '/x' }) },
      broadcastAll: (...a: any[]) => broadcasts.push(a),
    },
    {
      create: (o: any) => ((opts = o), svc),
      allowed: () => true,
      makeAskpass: (o: any) => (
        (ask = o.ask),
        (askDir = o.dir),
        (verify = o.verifyPeer),
        { env: async () => ({ env: {}, release: () => undefined }), close: () => closed++ }
      ),
    },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  const added = call('host:add', 'me@box');
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof opts.channel, 'function', 'the machines service runs ssh through the prompting channel');
  // the app, and only the app, gives the installer real key access (a test that builds the machines service never touches ~/.ssh)
  assert.equal(typeof opts.keyAccess.probe, 'function');
  assert.equal(opts.keyAccess.ensure.name, 'ensureKey');
  assert.equal(typeof opts.keyAccess.consent, 'function', 'a key is added only after the window says yes');
  // every command to a machine carries the key on its record
  const spawned: string[][] = [];
  useFakeProc(t, {
    spawn: (_b: string, args: string[]) => {
      spawned.push(args);
      const c = new Child();
      setImmediate(() => c.emit('close', 0));
      return c;
    },
  });
  await opts.channel('me@box', 'true');
  assert.deepEqual(spawned[0].slice(-7), ['-i', '/k', '-o', 'IdentitiesOnly=yes', '--', 'me@box', 'true']);
  assert.match(askDir, /mopilot-ssh-\d+$/);
  // the asker is checked by the kernel's word (the core): with no ssh to descend from, it is refused
  assert.equal(await verify({}, undefined), 'no harness process');
  const answer = ask({ destination: 'me@box', kind: 'password', account: 'me@box', text: 't' });
  assert.deepEqual(broadcasts.at(-1), [
    'host:prompt',
    { id: 'prompt-1', destination: 'me@box', prompt: { destination: 'me@box', kind: 'password', account: 'me@box', text: 't' } },
  ]);
  assert.deepEqual(await call('host:answerPrompt', 'prompt-1', 'pw'), { value: true });
  assert.equal(await answer, 'pw');
  // the key consent goes through the same window: a yes is only the answer 'add'
  const consent = opts.keyAccess.consent('me@box', '~/.ssh/mopilot_ed25519');
  const [, asked] = broadcasts.at(-1);
  assert.equal(asked.prompt.kind, 'keyConsent');
  assert.deepEqual(await call('host:answerPrompt', asked.id, 'add'), { value: true });
  assert.equal(await consent, true);
  const declined = opts.keyAccess.consent('me@box', '~/.ssh/mopilot_ed25519');
  await call('host:answerPrompt', broadcasts.at(-1)[1].id, null);
  assert.equal(await declined, false);
  assert.equal(await ask({ destination: 'other', kind: 'secret', text: 'x' }), null, 'a machine not being added never asks');
  release({ ok: true });
  assert.deepEqual(await added, { value: { ok: true } });
  assert.deepEqual(await call('host:answerPrompt', 'prompt-1', 'pw'), { value: false });
  quit();
  assert.equal(closed, 1);
});
