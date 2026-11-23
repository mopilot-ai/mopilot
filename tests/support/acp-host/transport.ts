// ACP host transport unit cases with shared fake-agent and transcript fixtures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acp, settle, recentIgnored, clearIgnored, fakeSpawn } from './fixture';

export function registerTransportCases() {
  function peer(o: any = {}) {
    const input = Object.assign(new EventEmitter(), { setEncoding() {} });
    const written: any[] = [];
    const output = { write: o.write ?? ((s: string) => written.push(JSON.parse(s))) };
    const p = new acp.RpcPeer({ input, output, onRequest: o.onRequest ?? (async () => undefined), onNotification: o.onNotification });
    const send = (m: any) => input.emit('data', JSON.stringify(m) + '\n');
    return { p, input, written, send };
  }

  test('RpcPeer skips blank and non-JSON lines and non-objects, and ignores answers nobody waits for', async () => {
    const notes: any[] = [];
    const { p, input, send } = peer({ onNotification: (m: string, params: any) => notes.push([m, params]) });
    input.emit('data', '\n   \nhello from the harness\n');
    send(42);
    send(null);
    send({ id: 999, result: 1 });
    send({ method: 'n' });
    // past the reader's time budget (a busy machine) the later lines come in later turns
    await settle(32);
    assert.deepEqual(notes, [['n', {}]]);
    // a throwing handler doesn't stop the peer
    const r = peer({
      onNotification: () => {
        throw new Error('x');
      },
    });
    r.send({ method: 'n' });
    // no handler at all
    const q = peer();
    q.send({ method: 'n', params: { a: 1 } });
    assert.equal(p.pending.size, 0);
  });

  test('RpcPeer answers requests: null for nothing, numeric error codes kept, others -32603, non-Errors as text', async () => {
    const answers: any = {
      a: undefined,
      b: Object.assign(new Error('bad'), { code: -32602 }),
      c: 'plain',
      d: { code: 'E', message: 'coded' },
    };
    const { written, send } = peer({
      onRequest: async (m: string, params: any) => {
        assert.deepEqual(params, {});
        if (m === 'a') return answers.a;
        throw answers[m];
      },
    });
    for (const [i, m] of ['a', 'b', 'c', 'd'].entries()) send({ id: i, method: m });
    await settle();
    assert.deepEqual(
      written.map((w) => ('result' in w ? w.result : w.error)),
      [null, { code: -32602, message: 'bad' }, { code: -32603, message: 'plain' }, { code: -32603, message: 'coded' }],
    );
  });

  test('RpcPeer requests: an error without a message, a timeout, a failing pipe, and everything after close', async () => {
    const { p, written, send } = peer();
    const r = p.request('m', {});
    send({ id: written[0].id, error: { code: 1 } });
    await assert.rejects(r, (e: any) => e.message === 'error' && e.code === 1);
    await assert.rejects(p.request('slow', {}, { timeoutMs: 5 }), /slow timed out/);
    assert.equal(p.pending.size, 0);
    const pending = p.request('never', {});
    p.close();
    await assert.rejects(pending, /closed/);
    await assert.rejects(p.request('after', {}), /closed/);
    const n = written.length;
    p.notify('x', {});
    assert.equal(written.length, n);
    const broken = peer({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    assert.doesNotThrow(() => broken.p.notify('x', {}));
  });

  test('RpcPeer: a request that cannot go out fails at once instead of waiting forever', async () => {
    const broken = peer({
      write: () => {
        throw new Error('write after end');
      },
    });
    await assert.rejects(broken.p.request('session/prompt', {}, { timeoutMs: 60_000 }), /write after end/);
    assert.equal(broken.p.pending.size, 0);
    // params that cannot be encoded fail the same way, and the connection stays usable
    const { p, written } = peer();
    await assert.rejects(p.request('m', { n: 1n }), TypeError);
    assert.equal(p.pending.size, 0);
    const ok = p.request('m', {});
    assert.equal(written.at(-1).method, 'm');
    p.close();
    await assert.rejects(ok, /closed/);
  });

  test('RpcPeer: an answer that cannot be encoded goes back as an error; what cannot be sent at all is recorded', async () => {
    clearIgnored();
    const { written, send } = peer({ onRequest: async () => ({ n: 1n }) });
    send({ id: 7, method: 'fs/read_text_file' });
    await settle();
    assert.equal(written.length, 1);
    assert.equal(written[0].id, 7);
    assert.equal(written[0].error.code, -32603);
    assert.match(written[0].error.message, /BigInt/);
    const broken = peer({
      write: () => {
        throw new Error('EPIPE');
      },
      onNotification: () => {
        throw new Error('handler broke');
      },
    });
    broken.send({ id: 8, method: 'fs/read_text_file' });
    broken.send({ method: 'session/update' });
    broken.p.notify('session/cancel', {});
    await settle();
    assert.deepEqual(
      recentIgnored().map((e: any) => [e.context, e.message]),
      [
        ["handle the ACP agent's session/update", 'handler broke'],
        ['send session/cancel to the ACP agent', 'EPIPE'],
        ['send an answer to the ACP agent', 'EPIPE'],
      ],
    );
  });

  /* ------------------------------------------------------------------ */
  /* the agent process                                                   */
  /* ------------------------------------------------------------------ */
  test('AcpAgent: no pid before start; a stderr tail of 2,000 UTF-16 units; exit messages by code, signal or neither; only the first exit counts', async () => {
    const sp = fakeSpawn();
    const a = new acp.AcpAgent({ harness: 'fake', command: '/bin/fake', env: {}, cwd: '/', spawnFn: sp.spawnFn });
    assert.equal(a.pid, null);
    assert.deepEqual(a.args, []);
    a.start();
    assert.equal(a.pid, 4242);
    const chunks = Array.from({ length: 52 }, (_, i) => `line${i}: ${'x'.repeat(40)}\n`);
    for (const chunk of chunks) sp.procs[0].stderr.emit('data', chunk);
    assert.equal(a.stderr.text.length, 2000);
    const exits: any[] = [];
    a.on('exit', (e: any) => exits.push(e));
    const r = a.request('x', {});
    sp.procs[0].exit(null, 'SIGKILL');
    sp.procs[0].exit(3);
    await assert.rejects(r, /fake exited \(SIGKILL\)/);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].stderr, chunks.join('').slice(-2000));
    for (const [code, signal, want] of [
      [2, null, /fake exited \(2\)/],
      [null, null, /^Error: fake exited$/],
    ] as const) {
      const s = fakeSpawn();
      const b = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: s.spawnFn });
      b.start();
      const q = b.request('x', {});
      s.procs[0].exit(code, signal);
      await assert.rejects(q, want);
    }
    // a spawn error, as text, even without a message
    const s2 = fakeSpawn({}, { noStderr: true });
    const c = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: s2.spawnFn });
    c.start();
    s2.procs[0].emit('error', 'ENOENT');
    assert.equal(c.exited.error, 'ENOENT');
    s2.procs[0].stdin.emit('error', new Error('EPIPE'));
  });

  test('AcpAgent initialize refuses another protocol version, or none', async () => {
    for (const [res, want] of [
      [{ protocolVersion: 2 }, /speaks ACP v2/],
      [null, /speaks ACP v\?/],
    ] as const) {
      const sp = fakeSpawn({ initialize: () => res });
      const a = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: sp.spawnFn });
      a.start();
      await assert.rejects(a.initialize(), want);
    }
  });

  test('AcpAgent kill: ends stdin, then SIGTERM after a while unless it exited; tree kill on Windows; never started is fine', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const sp = fakeSpawn({}, { pid: undefined });
      const a = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: sp.spawnFn });
      a.start();
      a.kill();
      assert.equal(sp.procs[0].stdin.ended, true);
      assert.deepEqual(sp.procs[0].kills, [], 'stdin closes before the process is signalled');
      mock.timers.tick(1999);
      assert.deepEqual(sp.procs[0].kills, [], 'a retiring process gets its full exit grace');
      mock.timers.tick(1);
      assert.deepEqual(sp.procs[0].kills, ['SIGTERM']);
      // exited meanwhile: not killed again
      a.kill();
      sp.procs[0].exit(0);
      mock.timers.tick(2000);
      assert.equal(sp.procs[0].kills.length, 1);
      // Windows: through killTree (a process with no pid is killed directly)
      const b = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: sp.spawnFn });
      b.start();
      b.kill();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        mock.timers.tick(2000);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      assert.equal(sp.procs[1].kills.length, 1);
      assert.equal((sp.procs[1] as any).stopped, true);
      // never started, and a kill that throws
      const c = new acp.AcpAgent({ harness: 'fake', command: 'x', spawnFn: sp.spawnFn });
      c.kill();
      c.proc = {
        stdin: {
          end() {
            throw new Error('closed');
          },
        },
        kill() {
          throw new Error('gone');
        },
      };
      c.kill();
      mock.timers.tick(2000);
    } finally {
      mock.timers.reset();
    }
  });

  test('negotiate reads nothing as nothing', () => {
    const n = acp.negotiate(null);
    assert.deepEqual(
      [n.protocolVersion, n.agent, n.loadSession, n.mcp, n.authMethods],
      [null, null, false, { http: false, sse: false }, []],
    );
    const m = acp.negotiate({
      agentCapabilities: {
        sessionCapabilities: { resume: 1, close: 1, list: 1, fork: 1 },
        promptCapabilities: { image: 1, embeddedContext: 1 },
        mcpCapabilities: { http: 1, sse: 1 },
      },
      authMethods: [{ id: 'x' }],
    });
    assert.deepEqual(
      [m.resume, m.close, m.list, m.fork, m.image, m.embeddedContext, m.mcp, m.authMethods.length],
      [true, true, true, true, true, true, { http: true, sse: true }, 1],
    );
  });

  test('parseKey and keyOf', () => {
    assert.equal(acp.parseKey(undefined), null);
    assert.equal(acp.parseKey('claude:x'), null);
    assert.deepEqual(acp.parseKey('acp:kimi:a:b'), { harness: 'kimi', id: 'a:b' });
    assert.equal(acp.keyOf('kimi', 'u1'), 'acp:kimi:u1');
  });
}
