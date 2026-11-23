// A port on a remote machine forwarded to this Mac's loopback (electron/host/portForward.cjs, package 2.6): one ssh -L per (machine, port), shared while it lives, never reaching anything but loopback, and gone with the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { useFakeProc as installFakeProc } from './support/ports/proc.ts';

const require = createRequire(import.meta.url);
const { createPortForwards, ForwardError } = require('../electron/host/portForward.cjs');

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
  }
}

function setup(t: any, o: { up?: (port: number) => boolean; pick?: () => Promise<number>; refused?: boolean } = {}) {
  const clock = installFakeClock(t);
  const children: FakeChild[] = [];
  const spawns: { bin: string; args: string[]; opts: any }[] = [];
  let spawnThrows: Error | null = null;
  installFakeProc(t, {
    spawn: (bin: string, args: string[], opts: any) => {
      if (spawnThrows) throw spawnThrows;
      spawns.push({ bin, args, opts });
      const c = new FakeChild();
      children.push(c);
      return c;
    },
  });
  let next = 41000;
  const tries: number[] = [];
  const forwards = createPortForwards({
    env: () => ({ PATH: '/x' }),
    pickPort: o.pick ?? (async () => next++),
    // a local port answers when the test says ssh made the forward
    connect: (port: number) => {
      tries.push(port);
      const s: any = new EventEmitter();
      s.destroy = () => undefined;
      queueMicrotask(() => {
        if (!(o.up?.(port) ?? true)) return void s.emit('error', new Error('refused'));
        s.emit('connect');
        // ssh listens before it knows the machine's port answers: a refused port closes the connection at once, an open one stays
        if (o.refused)
          queueMicrotask(() => {
            s.emit('error', new Error('ECONNRESET'));
            s.emit('close');
          });
        else queueMicrotask(() => clock.advance(500));
      });
      return s;
    },
    probeMs: 100,
    timeoutMs: 1000,
    settleMs: 300,
    idleMs: 60_000,
  });
  t.after(() => forwards.dispose());
  return { clock, children, spawns, forwards, tries, throwOnSpawn: (e: Error | null) => (spawnThrows = e) };
}
const target = { machine: 'ssh:box', destination: 'me@box', remotePort: 5173 };

test("I2: a machine's port is forwarded loopback to loopback, ssh told never to prompt and to fail loudly, and a destination can never be an option", async (t) => {
  const w = setup(t);
  const { localPort } = await w.forwards.forward({ ...target, sshArgs: ['-p', '2222'] });
  assert.equal(localPort, 41000);
  const { bin, args, opts } = w.spawns[0];
  assert.equal(bin, 'ssh');
  assert.deepEqual(args.slice(0, 2), ['-N', '-o']);
  assert.ok(args.includes('BatchMode=yes') && args.includes('ExitOnForwardFailure=yes'));
  // L3: the machine gets neither this Mac's ssh agent nor its display, ahead of the user's own options so theirs cannot turn them on
  assert.ok(args.includes('ForwardAgent=no') && args.includes('ForwardX11=no'));
  assert.ok(args.indexOf('ForwardAgent=no') < args.indexOf('-p'));
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:41000:127.0.0.1:5173');
  assert.deepEqual(args.slice(-4), ['-p', '2222', '--', 'me@box'].slice(-4));
  assert.deepEqual(opts.env, { PATH: '/x' });
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe']);
});

test('A1: a second ask for the same port shares the forward; another port or machine gets its own', async (t) => {
  const w = setup(t);
  const [a, b] = await Promise.all([w.forwards.forward(target), w.forwards.forward(target)]);
  assert.deepEqual([a.localPort, b.localPort], [41000, 41000]);
  assert.equal(w.spawns.length, 1);
  assert.equal((await w.forwards.forward({ ...target, remotePort: 3000 })).localPort, 41001);
  assert.equal((await w.forwards.forward({ ...target, machine: 'ssh:other' })).localPort, 41002);
  assert.equal(w.spawns.length, 3);
  // a machine that answers to another address now is not the one the forward reaches
  assert.equal((await w.forwards.forward({ ...target, destination: 'me@moved' })).localPort, 41003);
  assert.equal(w.spawns[3].args.at(-1), 'me@moved');
});

test('A5: a forward whose ssh ended is not kept: the next ask makes a new one', async (t) => {
  const w = setup(t);
  await w.forwards.forward(target);
  w.children[0].emit('exit', 255, null);
  await settle();
  assert.equal((await w.forwards.forward(target)).localPort, 41001);
  assert.equal(w.spawns.length, 2);
});

test("B2: ssh ending before the port answers fails the ask with ssh's own words; a spawn that throws, an error event, and a port that never answers each fail it too, and none is kept", async (t) => {
  const w = setup(t, { up: () => false });
  const ended = w.forwards.forward(target).catch((e: any) => e);
  await settle();
  w.children[0].stderr.emit('data', Buffer.from('x'.repeat(3000)));
  w.children[0].stderr.emit('data', Buffer.from('Permission denied (publickey).'));
  w.children[0].emit('exit', 255, null);
  const e1 = await ended;
  assert.ok(e1 instanceof ForwardError && e1.code === 'forward_failed');
  assert.match(e1.message, /Permission denied/);
  assert.ok(e1.message.length <= 2000);
  // ssh already ended: nothing left to kill
  assert.deepEqual(w.children[0].killed, []);
  // no words from ssh: its exit
  const silent = w.forwards.forward(target).catch((e: any) => e);
  await settle();
  w.children[1].emit('exit', null, 'SIGKILL');
  assert.match((await silent).message, /ssh ended \(SIGKILL\)/);
  // ssh could not start
  const err = w.forwards.forward(target).catch((e: any) => e);
  await settle();
  w.children[2].emit('error', new Error('spawn ssh ENOENT'));
  assert.match((await err).message, /ENOENT/);
  // a port that never answers
  const slow = w.forwards.forward(target).catch((e: any) => e);
  await settle();
  w.clock.advance(1100);
  await settle();
  assert.match((await slow).message, /did not answer in time/);
  // ssh was still up, so the failed ask takes it down
  assert.deepEqual(w.children[3].killed, ['SIGTERM']);
  // a spawn that throws
  w.throwOnSpawn(new Error('no ssh here'));
  await assert.rejects(w.forwards.forward(target), /no ssh here/);
});

test('a machine leaving takes its forwards with it, and only its; closing the app takes the rest', async (t) => {
  const w = setup(t);
  await w.forwards.forward(target);
  await w.forwards.forward({ ...target, remotePort: 3000 });
  await w.forwards.forward({ ...target, machine: 'ssh:other' });
  w.forwards.closeMachine('ssh:box');
  assert.deepEqual(
    w.children.map((c) => c.killed),
    [['SIGTERM'], ['SIGTERM'], []],
  );
  w.forwards.closeMachine('ssh:nobody');
  // a closed machine's next ask makes a new forward
  assert.equal((await w.forwards.forward(target)).localPort, 41003);
  w.forwards.dispose();
  assert.deepEqual(
    w.children.map((c) => c.killed.length),
    [1, 1, 1, 1],
  );
  // a forward whose ssh already ended is not killed again
  w.children[3].emit('exit', 0, null);
});

const TAKEN = 'bind [127.0.0.1]:41000: Address already in use';

test('W: a machine removed while its ask is still choosing a port starts no ssh and fails the ask; a closed app does the same', async (t) => {
  let release: (port: number) => void = () => undefined;
  const w = setup(t, { pick: () => new Promise<number>((r) => (release = r)) });
  const ask = w.forwards.forward(target);
  const assertion = assert.rejects(ask, /machine is gone/);
  w.forwards.closeMachine(target.machine);
  release(41000);
  await assertion;
  assert.equal(w.spawns.length, 0);
  // the next ask makes a new forward
  release = () => undefined;
  const again = assert.rejects(w.forwards.forward(target), /machine is gone/);
  w.forwards.dispose();
  release(41001);
  await again;
  assert.equal(w.spawns.length, 0);
});

test('A/B: a local port taken between choosing it and listening is tried again with another; the retry is shared, and a third taken port is the answer', async (t) => {
  // a port ssh could not listen on answers nothing
  const w = setup(t, { up: (port) => port === 41001 || port >= 41005 });
  const first = w.forwards.forward(target);
  await settle();
  // an ask during the retry shares it instead of starting a second forward
  const second = w.forwards.forward(target);
  w.children[0].stderr.emit('data', Buffer.from(TAKEN));
  w.children[0].emit('exit', 255, null);
  assert.deepEqual(await Promise.all([first, second]), [{ localPort: 41001 }, { localPort: 41001 }]);
  assert.equal(w.spawns.length, 2);
  assert.ok(w.spawns[1].args.includes('127.0.0.1:41001:127.0.0.1:5173'));
  // the failed attempt's probe stops with it
  const tried = w.tries.length;
  w.clock.advance(5000);
  assert.equal(w.tries.length, tried);

  // three taken ports in a row fail the ask with ssh's words and keep nothing
  const other = { ...target, remotePort: 3000 };
  const third = assert.rejects(w.forwards.forward(other), /Address already in use/);
  for (let i = 0; i < 3; i++) {
    await settle();
    const child = w.children[w.children.length - 1];
    child.stderr.emit('data', Buffer.from(TAKEN));
    child.emit('exit', 255, null);
  }
  await third;
  assert.equal(w.spawns.length, 5);
  await w.forwards.forward(other);
  assert.equal(w.spawns.length, 6);
});

test('a machine removed while its first port was being taken is not retried', async (t) => {
  const w = setup(t, { up: () => false });
  const ask = assert.rejects(w.forwards.forward(target), /Address already in use/);
  await settle();
  w.forwards.closeMachine(target.machine);
  w.children[0].stderr.emit('data', Buffer.from(TAKEN));
  w.children[0].emit('exit', 255, null);
  await ask;
  assert.equal(w.spawns.length, 1);
});

/** An ssh that listens on its -L port as the real one does; `keep` says whether a connection to it stays open (the machine's port answered) or is closed at once (it did not). */
function listeningSsh(t: any, keep: boolean) {
  installFakeProc(t, {
    spawn: (_bin: string, args: string[]) => {
      const port = Number(args[args.indexOf('-L') + 1].split(':')[1]);
      const server = net.createServer((s) => (keep ? undefined : s.destroy())).listen(port, '127.0.0.1');
      const c = new FakeChild();
      c.on('exit', () => server.close());
      t.after(() => server.close());
      return c;
    },
  });
}

test('with no options it picks a free loopback port and tries it over a real socket: a connection that stays open is a forward that works', async (t) => {
  listeningSsh(t, true);
  const f = createPortForwards({ settleMs: 50 });
  t.after(() => f.dispose());
  const { localPort } = await f.forward(target);
  assert.ok(localPort > 0);
  // the default environment is the app's own
  f.closeMachine(target.machine);
});

test('with a real socket, a connection ssh closes at once (the machine refused the port) is not a forward that works', async (t) => {
  listeningSsh(t, false);
  const f = createPortForwards({ settleMs: 2000 });
  t.after(() => f.dispose());
  await assert.rejects(f.forward(target), /Nothing is listening on port 5173 of the machine/);
});

test('B: a port nothing listens on fails with a reason, kills the ssh and is not kept; the next ask tries again', async (t) => {
  const refused = setup(t, { refused: true });
  const e = await refused.forwards.forward(target).catch((x: any) => x);
  assert.ok(e instanceof ForwardError && e.code === 'forward_failed');
  assert.match(e.message, /Nothing is listening on port 5173 of the machine/);
  assert.deepEqual(refused.children[0].killed, ['SIGTERM']);
  const again = refused.forwards.forward(target).catch((x: any) => x);
  await settle();
  assert.equal(refused.spawns.length, 2, 'a failed forward is not reused');
  assert.ok((await again) instanceof ForwardError);
});

test('B: a connection that stays open for the settle time is a forward that works, even if it closes afterwards', async (t) => {
  const w = setup(t);
  assert.equal((await w.forwards.forward(target)).localPort, 41000);
});

test('L: a forward nobody asks for again closes after its idle time; asking for it again keeps it, and a new ask after it closed makes a new one', async (t) => {
  const w = setup(t);
  const first = await w.forwards.forward(target);
  assert.equal(first.localPort, 41000);
  w.clock.advance(59_000);
  // asked again before it was idle: the same forward, kept another minute
  assert.deepEqual(await w.forwards.forward(target), first);
  w.clock.advance(59_000);
  assert.deepEqual(w.children[0].killed, []);
  w.clock.advance(2_000);
  assert.deepEqual(w.children[0].killed, ['SIGTERM'], 'idle: ssh is stopped');
  const again = await w.forwards.forward(target);
  assert.equal(again.localPort, 41001, 'a new forward on a new port');
  assert.equal(w.spawns.length, 2);
  // a forward that failed is not kept, and has no timer left to close a later one
  const failing = setup(t, { refused: true });
  await assert.rejects(failing.forwards.forward(target), { code: 'forward_failed' });
  failing.clock.advance(120_000);
  assert.deepEqual(failing.children[0].killed, ['SIGTERM'], 'killed once, when it failed');
});

test('a machine added with a port is forwarded through -p, not the host name "host:2222"', async (t) => {
  const w = setup(t);
  void w.forwards.forward({ machine: 'ssh:me@box:2222', destination: 'me@box:2222', remotePort: 5173 }).catch(() => undefined);
  await settle();
  const args = w.spawns[0].args;
  assert.deepEqual(args.slice(-4), ['-p', '2222', '--', 'me@box']);
});
