// A machine being added reports where it is (electron/host/installSteps.cjs): each step's phase (n of 6), the bytes of an upload, a stalled flag after 30 s of nothing, and a cancel that stops the ssh commands and undoes what the run made (B/W/I: nothing left running, nothing half-installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { useFakeProc } from './support/ports/proc.ts';
import { waitFor } from './support/waitFor.ts';
import { explainFailure } from '../shared/host/installFailure.mjs';
import { bundle, machine, registry, BYTES } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { createInstaller, createSshChannel } = require('../electron/host/install.cjs');

type Control = { signal?: AbortSignal; onBytes?: (done: number, total: number) => void };
/** A channel over the fake machine that lets a test hold the command whose text contains `at`. */
function gated(at: string, m = machine()) {
  const seen: { command: string; control: Control }[] = [];
  let release: (v: any) => void = () => undefined;
  let held: { control: Control } | null = null;
  const channel = (d: string, command: string, input?: Buffer, control: Control = {}) => {
    seen.push({ command, control });
    if (!command.includes(at) || held) return m.channel(d, command, input);
    held = { control };
    return new Promise((resolve) => {
      release = resolve;
      control.signal?.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: 'Cancelled.' }), { once: true });
    });
  };
  return { channel, m, seen, held: () => held, release: (v: any) => release(v) };
}

test('every step of the first six phases names its phase, and the undo has none (A)', async () => {
  const m = machine();
  const events: any[] = [];
  const out = await createInstaller({ channel: m.channel, registry, bundle }).install('me@box', (s: any) => events.push(s));
  const phase = (id: string) => out.steps.find((s: any) => s.id === id);
  assert.deepEqual(
    ['connect', 'detect', 'node', 'upload', 'start', 'status', 'pair'].map((id) => [phase(id).index, phase(id).total]),
    [
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [5, 6],
      [6, 6],
    ],
  );
  assert.ok(events.length >= out.steps.length * 2);
});

test('an upload reports its bytes on its own step, and a step that moves is not stalled (A)', async (t) => {
  useFakeClock(t);
  const m = machine();
  const events: any[] = [];
  const channel = async (d: string, command: string, input?: Buffer, control: Control = {}) => {
    if (input && command.includes('cat >')) control.onBytes?.(input.length / 2, input.length);
    return m.channel(d, command, input);
  };
  await createInstaller({ channel, registry, bundle }).install('me@box', (s: any) => events.push(s));
  const upload = events.filter((e) => e.id === 'upload' && e.progress);
  assert.deepEqual(upload[0].progress, { done: BYTES.length / 2, total: BYTES.length });
  assert.ok(events.every((e) => !e.stalled));
});

test('a step with nothing moving for 30 s says so once, and says no more when it moves (A)', async (t) => {
  const clock = useFakeClock(t);
  const g = gated('cat >');
  const events: any[] = [];
  const done = createInstaller({ channel: g.channel, registry, bundle }).install('me@box', (s: any) => events.push({ ...s }));
  await waitFor(() => g.held(), 'the command is held');
  assert.ok(g.held());
  clock.advance(25_000);
  assert.ok(!events.some((e) => e.stalled));
  clock.advance(10_000);
  assert.equal(events.filter((e) => e.stalled).length, 1);
  assert.equal(events.find((e) => e.stalled).id, 'upload');
  clock.advance(60_000);
  assert.equal(events.filter((e) => e.stalled).length, 1, 'said once');
  g.held()!.control.onBytes?.(1, 10);
  assert.equal(events.at(-1).stalled, undefined);
  g.release({ code: 0, stdout: '', stderr: '' });
  const out = await done;
  assert.equal(out.ok, true);
  assert.equal(clock.pending, 0, 'the watch ends with the run');
});

test('cancel stops the command under way and undoes the install the run made (B, W)', async () => {
  const g = gated('cat >');
  const installer = createInstaller({ channel: g.channel, registry, bundle });
  assert.equal(installer.cancel('me@box'), false, 'nothing to cancel');
  const done = installer.install('me@box:22');
  await waitFor(() => g.held(), 'the command is held');
  assert.equal(installer.cancel('ssh://me@box'), true);
  assert.equal(installer.cancel('me@box'), false, 'once');
  const out = await done;
  // nothing was installed yet: the half-sent file is removed, and no service or unit is touched
  assert.deepEqual([out.ok, out.cancelled, out.rolledBack, out.failedStep], [false, true, false, 'upload']);
  // the undo runs without the signal that was aborted, or it would never run
  const undo = g.seen.at(-1)!;
  assert.match(undo.command, /rm -f .*incoming\/.*\.tgz/);
  assert.equal(undo.control.signal, undefined);
});

test('a cancel while the service starts lets that command finish, then undoes the install: service stopped, unit and files removed (W)', async () => {
  const g = gated('systemctl --user enable');
  const installer = createInstaller({ channel: g.channel, registry, bundle });
  const done = installer.install('me@box');
  await waitFor(() => g.held(), 'the command is held');
  assert.deepEqual(g.held()!.control, {}, 'the start cannot be aborted');
  installer.cancel('me@box');
  g.release({ code: 0, stdout: '', stderr: '' });
  const out = await done;
  assert.deepEqual([out.ok, out.cancelled, out.rolledBack, out.failedStep], [false, true, true, 'status']);
  const undo = g.seen.at(-1)!;
  assert.match(undo.command, /systemctl --user disable --now[\s\S]*uninstall/);
  assert.equal(undo.control.signal, undefined);
});

test('a cancel between commands starts no further command (B)', async () => {
  const m = machine();
  const installer = createInstaller({ channel: undefined as any, registry, bundle });
  let calls = 0;
  const g = gated('uname');
  const second = createInstaller({
    channel: (d: string, c: string, i?: Buffer, control?: Control) => {
      calls++;
      return g.channel(d, c, i, control);
    },
    registry,
    bundle,
  });
  const done = second.install('me@box');
  await waitFor(() => g.held(), 'the command is held');
  second.cancel('me@box');
  const out = await done;
  assert.deepEqual([out.ok, out.cancelled, out.failedStep], [false, true, 'connect']);
  assert.equal(calls, 1, 'only the command that was cancelled');
  assert.ok(installer && m);
  // a command asked for after the cancel is not sent, even when none is running (the next step of a run cancelled between commands)
  const late = gated('cat >');
  const third = createInstaller({ channel: late.channel, registry, bundle });
  const run = third.install('me@late');
  await waitFor(() => late.held(), 'the command is held');
  third.cancel('me@late');
  await run;
  assert.ok(!late.seen.some((s) => s.command.includes('verify') || s.command.includes('sha256sum')));
});

class Child extends EventEmitter {
  chunks: Buffer[] = [];
  killed = false;
  stdin: any = Object.assign(new EventEmitter(), {
    write: (b: Buffer, cb: (e?: Error) => void) => {
      this.chunks.push(b);
      setImmediate(cb);
    },
    end: () => undefined,
  });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {
    this.killed = true;
  }
}
test('the real channel feeds its input in chunks and reports each, ends on an abort, and refuses an aborted run (B2)', async (t) => {
  const kids: Child[] = [];
  let breakWrites = false;
  let failedWrites = 0;
  useFakeProc(t, {
    spawn: () => {
      const c = new Child();
      if (breakWrites)
        c.stdin.write = (_b: Buffer, cb: (e?: Error) => void) => setImmediate(() => (failedWrites++, cb(new Error('EPIPE'))));
      kids.push(c);
      return c;
    },
  });
  const ssh = createSshChannel({ env: () => ({}) });
  const heard: number[][] = [];
  const big = Buffer.alloc(600 * 1024, 1);
  const sent = ssh('me@box', 'cat', big, { onBytes: (d: number, t: number) => heard.push([d, t]) });
  await waitFor(() => heard.length === 3, 'the three chunks');
  kids[0].emit('close', 0);
  await sent;
  assert.deepEqual(heard, [
    [256 * 1024, big.length],
    [512 * 1024, big.length],
    [big.length, big.length],
  ]);
  assert.equal(Buffer.concat(kids[0].chunks).length, big.length);
  // an abort ends the command with a result and kills ssh
  const ac = new AbortController();
  const p = ssh('me@box', 'sleep 9', undefined, { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { code: -1, stdout: '', stderr: 'Cancelled.' });
  assert.equal(kids[1].killed, true);
  // aborted before it began: nothing is spawned
  assert.deepEqual(await ssh('me@box', 'x', undefined, { signal: ac.signal }), { code: -1, stdout: '', stderr: 'Cancelled.' });
  assert.equal(kids.length, 2);
  // a write that fails stops the feed
  breakWrites = true;
  const failing = ssh('me@box', 'cat', big, { onBytes: () => heard.push([0, 0]) });
  await waitFor(() => failedWrites > 0, 'the failing write');
  kids[2].emit('close', 1);
  assert.equal((await failing).code, 1);
  assert.equal(heard.length, 3);
});

test("a machine that needs MoPilot's own key asks first, naming the machine and where the key lives, and adds nothing on a no (A)", async () => {
  const m = machine();
  const events: any[] = [];
  const asked: string[][] = [];
  let yes = true;
  const keyAccess = {
    probe: async (_d: string, args: string[]) => ({ code: args.length ? 0 : 255, stdout: '', stderr: '' }),
    ensure: async () => ({ file: '/k/mopilot_ed25519', pub: 'ssh-ed25519 AAAA mopilot@x' }),
    consent: async (d: string, f: string) => (asked.push([d, f]), yes),
  };
  const channel = (d: string, c: string, i?: Buffer) =>
    c.includes('authorized_keys') ? Promise.resolve({ code: 0, stdout: 'authorized\n', stderr: '' }) : m.channel(d, c, i);
  const out = await createInstaller({ channel, registry, bundle, keyAccess }).install('me@box', (s: any) => events.push({ ...s }));
  assert.deepEqual(asked, [['me@box', '~/.ssh/mopilot_ed25519']]);
  assert.ok(out.ok);
  yes = false;
  const no = await createInstaller({ channel, registry, bundle, keyAccess }).install('me@box');
  assert.equal(no.ok, false);
  assert.equal(no.failedStep, 'key');
  assert.equal(explainFailure({ step: no.failedStep, output: no.error, target: 'box', destination: 'me@box' }).cause, 'declined');
  assert.match(no.error, /chose not to let MoPilot add its key/);
});

test('the add IPC passes the address on, cancelAdd reaches the machines service, and ssh asks about a machine under its one address (B)', async (t) => {
  const { registerHostAdd } = require('../electron/app/ipc/hostAdd.cjs');
  const { createConnectPrompts } = require('../electron/host/connectPrompts.cjs');
  const { createMachines } = require('../electron/host/machines.cjs');
  const handlers = new Map<string, (...a: any[]) => any>();
  const added: any[] = [];
  const cancelled: string[] = [];
  const asked: any[] = [];
  const prompts = createConnectPrompts({ broadcast: (e: any) => asked.push(e) });
  registerHostAdd({
    handle: (c: string, fn: any) => handlers.set(c, fn),
    service: () => ({
      add: async (d: string, o: object) => (
        added.push([d, o]), prompts.ask({ destination: 'me@box', kind: 'confirm', text: '(yes/no)' }).then(() => ({ ok: true }))
      ),
      cancelAdd: (d: string) => (cancelled.push(d), true),
    }),
    prompts,
  });
  const adding = handlers.get('host:add')!('ssh://me@box:22', { daemonPassword: 'pw' });
  await waitFor(() => asked.length === 1, 'the question');
  assert.equal(asked.length, 1, 'ssh asks, under me@box, about a machine typed as ssh://me@box:22');
  prompts.answer(asked[0].id, 'yes');
  await adding;
  await handlers.get('host:add')!(undefined, undefined);
  assert.deepEqual(added, [
    ['ssh://me@box:22', { daemonPassword: 'pw' }],
    ['', {}],
  ]);
  assert.equal(handlers.get('host:cancelAdd')!('me@box'), true);
  assert.equal(handlers.get('host:cancelAdd')!(undefined), true);
  assert.deepEqual(cancelled, ['me@box', '']);
  // the machines service hands a cancel to its installer
  const stops: string[] = [];
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'cancel-add-'));
  t.after(() => (require('node:fs') as typeof import('node:fs')).rmSync(dir, { recursive: true, force: true }));
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => null,
    installer: { install: async () => ({ ok: false, error: '', id: '', steps: [] }), cancel: (d: string) => (stops.push(d), true) },
  });
  assert.equal(m.cancelAdd('me@box'), true);
  assert.deepEqual(stops, ['me@box']);
  m.dispose();
});

test('a cancel during the unpack waits for it, then undoes the install, so the machine is never left half-changed (W)', async () => {
  const g = gated('tar -xzf');
  const installer = createInstaller({ channel: g.channel, registry, bundle });
  const done = installer.install('me@box');
  await waitFor(() => g.held(), 'the command is held');
  assert.deepEqual(g.held()!.control, {}, 'the unpack cannot be aborted');
  installer.cancel('me@box');
  g.release({ code: 0, stdout: 'made=yes prev=\n', stderr: '' });
  const out = await done;
  assert.deepEqual([out.ok, out.cancelled, out.rolledBack], [false, true, true]);
  assert.match(g.seen.at(-1)!.command, /uninstall/);
});

test('the real channel does not start ssh for a cancel that came while its askpass was being made (B2)', async (t) => {
  const spawned: string[][] = [];
  useFakeProc(t, {
    spawn: (_b: string, args: string[]) => {
      spawned.push(args);
      return new Child();
    },
  });
  const ac = new AbortController();
  let released = 0;
  const askpass = {
    env: async () => {
      ac.abort();
      return { env: {}, release: () => released++ };
    },
  };
  const ssh = createSshChannel({ env: () => ({}), askpass, controlDir: '/tmp/x' });
  assert.deepEqual(await ssh('me@box', 'x', undefined, { signal: ac.signal }), { code: -1, stdout: '', stderr: 'Cancelled.' });
  assert.deepEqual([spawned.length, released], [0, 1]);
});
