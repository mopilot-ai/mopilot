// Transport failures retire their real owner and permit replacement instead of caching a closed peer.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setup, NO_REPLY, fakeSpawn, acp } from './support/acp-host/fixture';

const require = createRequire(import.meta.url);
const { RpcPeer } = require('../electron/harness/acp/rpc.cjs');
const { AppServer } = require('../electron/harness/codexProcess.cjs');
const { attachHelperSocket } = require('../electron/capabilities/computerContract.cjs');
const { JsonReader } = require('../electron/transport/jsonReader.cjs');

/** The next bytes a reader frames fail, as a core that can't frame them would. */
function failingFrame(message: string) {
  const failing = mock.method(JsonReader.prototype, 'frame', () => {
    failing.mock.restore();
    throw new Error(message);
  });
  return failing;
}

test('an ACP reader failure closes pending work, evicts the agent and allows a fresh initialized agent', async () => {
  const t = setup({ handlers: { pending: () => NO_REPLY } });
  const agent = await t.host.agent('fake');
  await t.host.ensure('acp:fake:c1', { cwd: '/work' });
  const proc = t.sp.procs[0];
  const pending = agent.request('pending', {});
  const rejected = assert.rejects(pending, /synthetic worker failure/);
  const lateError = agent.peer.reader.o.onError;
  failingFrame('synthetic worker failure');
  proc.line('x'.repeat(5000));
  await rejected;
  assert.equal(agent.exited.error, 'synthetic worker failure');
  assert.equal(t.host.agents.size, 0);
  assert.equal(t.host.chats.size, 0);
  assert.equal(
    t.events.some((e: any) => e.kind === 'closed' && e.error === 'synthetic worker failure'),
    true,
  );
  assert.deepEqual(proc.kills, ['SIGTERM']);
  const replacement = await t.host.agent('fake');
  assert.notEqual(replacement, agent);
  assert.equal(t.sp.procs.length, 2);
  // A late exit/error on the old reader cannot evict or fail its replacement.
  lateError(new Error('retired worker'));
  proc.exit(1);
  assert.equal(await t.host.agent('fake'), replacement);
  assert.deepEqual(await replacement.request('healthy', {}), {});
  t.sp.procs[1].exit(0);
});

test('a standalone RPC peer still closes its requests when no owner failure callback is supplied', async () => {
  const input = new EventEmitter();
  const peer = new RpcPeer({ input, output: { write() {} }, onRequest: () => null });
  const rejected = assert.rejects(peer.request('pending', {}), /synthetic failure/);
  failingFrame('synthetic failure');
  input.emit('data', 'x'.repeat(5000));
  await rejected;
  assert.equal(peer.closed.message, 'synthetic failure');
});

test('explicit ACP kill discards queued requests before they can start an effect', async () => {
  const sp = fakeSpawn();
  const effects: string[] = [];
  const agent = new acp.AcpAgent({
    harness: 'fake',
    command: 'synthetic',
    spawnFn: sp.spawnFn,
    onRequest: (method: string) => effects.push(method),
  });
  agent.start();
  // the request waits behind a slice that has spent its budget
  const reader = agent.peer.reader;
  reader.queue.push(Buffer.from('null'));
  reader.dispatch = setImmediate(() => reader.slice());
  sp.procs[0].line(JSON.stringify({ id: 1, method: 'effect-after-stop', params: { text: 'x'.repeat(10000) } }) + '\n');
  agent.kill();
  assert.equal(reader.closed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(effects, []);
  assert.equal(agent.peer.closed.message, 'fake stopped');
  sp.procs[0].exit(0);
});

test('Codex input failure reaches its owner and a retired failure cannot kill a replacement', () => {
  const procs: any[] = [];
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, write() {} });
  const server = new AppServer({
    findBin: () => 'synthetic',
    env: () => ({}),
    spawn: () => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: stream(),
        stdout: stream(),
        stderr: stream(),
        kills: 0,
        kill() {
          this.kills++;
        },
      });
      procs.push(proc);
      return proc;
    },
  });
  const errors: any[] = [];
  server.listeners.add((e: any) => e.kind === 'error' && errors.push(e.error));
  server.start();
  const retiredFailure = server.reader.o.onError;
  server.stop();
  server.start();
  retiredFailure(new Error('retired failure'));
  assert.equal(procs[1].kills, 0);
  server.reader.fail(new Error('current failure'));
  assert.deepEqual(errors, ['current failure']);
  assert.equal(procs[1].kills, 1);
  procs[1].emit('exit', 1);
  server.start();
  assert.equal(server.status, 'running');
  server.stop();
});

test('helper socket replacement retires old callbacks and a reader failure destroys only its socket', () => {
  const owner: any = Object.assign(new EventEmitter(), { socket: null, jsonReader: null, pending: new Map() });
  const socket = () =>
    Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        this.emit('close');
      },
    });
  const first = socket();
  const second = socket();
  const values: any[] = [];
  let closed = 0;
  const attach = (sock: any) =>
    attachHelperSocket(
      owner,
      sock,
      (m: any) => values.push(m),
      () => closed++,
    );
  attach(first);
  first.emit('data', '{"id":1}\n');
  const old = owner.jsonReader;
  attach(second);
  assert.equal(old.closed, true);
  old.o.onValue({ id: 'stale' });
  first.emit('close');
  assert.equal(owner.socket, second);
  assert.equal(closed, 0);
  let rejected: any;
  owner.pending.set('one', {
    reject: (e: any) => {
      rejected = e;
    },
  });
  owner.jsonReader.fail(new Error('worker failure'));
  assert.equal(second.destroyed, true);
  assert.equal(first.destroyed, false);
  assert.equal(owner.socket, null);
  assert.equal(rejected.reason, 'helper_exited');
  assert.equal(owner.pending.size, 0);
  assert.deepEqual(values, [{ id: 1 }]);
  assert.equal(closed, 1);
});
