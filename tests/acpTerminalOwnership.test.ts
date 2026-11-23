// ACP terminal lifecycle ownership at the host and manager boundaries, with an in-memory PTY only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { AcpHost, Terminals } = createRequire(import.meta.url)('../electron/harness/acp.cjs');

type Callbacks = { onData: (data: string) => void; onExit: (exit: { exitCode?: number; signal?: number }) => void };
function fixture(sameAgent = false, sameSession = false) {
  const spawned: { id: string; cb: Callbacks }[] = [];
  const killed: string[] = [];
  const host = new AcpHost({
    items: {},
    quirks: () => ({ label: 'test' }),
    resolveBin: () => null,
    pty: {
      spawn: (id: string, _opts: unknown, cb: Callbacks) => spawned.push({ id, cb }),
      kill: (id: string) => killed.push(id),
    },
  });
  const agent = {};
  const a = { key: 'acp:one:a', sessionId: 'session:a,"\\', agent };
  const b = { key: 'acp:two:b', sessionId: sameSession ? a.sessionId : 'session:b', agent: sameAgent ? agent : {} };
  for (const chat of [a, b]) {
    host.chats.set(chat.key, chat);
    host.bindSession(chat, chat.sessionId);
  }
  const call = (chat: typeof a, method: string, params = {}) =>
    host.onAgentRequest(chat.agent, `terminal/${method}`, { sessionId: chat.sessionId, ...params });
  const create = (chat: typeof a) => call(chat, 'create', { command: 'mock-only' });
  return { host, a, b, spawned, killed, call, create };
}

for (const scope of ['same-harness', 'different-harness', 'same-session-id']) {
  for (const method of ['output', 'wait_for_exit', 'kill', 'release']) {
    test(`${method} rejects a foreign terminal: ${scope}`, async () => {
      const { host, a, b, spawned, killed, call, create } = fixture(scope === 'same-harness', scope === 'same-session-id');
      const terminal = await create(a);
      spawned[0].cb.onData('owner-a output');
      // A settled wait is still private; this avoids leaving a Promise pending on the buggy baseline.
      if (method === 'wait_for_exit') spawned[0].cb.onExit({ exitCode: 0 });
      await assert.rejects(call(b, method, terminal), { code: -32602 });
      assert.deepEqual(killed, []);
      assert.ok(host.terminals.byId.has(terminal.terminalId));
      assert.equal((await call(a, 'output', terminal)).output, 'owner-a output');
    });
  }
}

for (const method of ['output', 'waitForExit', 'kill', 'release']) {
  test(`the manager itself enforces owner identity for ${method}`, () => {
    const { host, a, b, killed } = fixture();
    const terminal = host.terminals.create(a, { command: 'mock-only' });
    for (const foreign of [b, { ...a }, undefined, null]) {
      assert.throws(() => host.terminals[method](terminal, foreign), { code: -32602 });
    }
    assert.deepEqual(killed, []);
    assert.ok(host.terminals.byId.has(terminal.terminalId));
  });
}

test('unknown terminal operations retain errors, while unknown release remains idempotent', async () => {
  const { a, call } = fixture();
  for (const method of ['output', 'wait_for_exit', 'kill']) {
    await assert.rejects(call(a, method, { terminalId: 'missing' }), { code: -32602 });
  }
  assert.equal(await call(a, 'release', { terminalId: 'missing' }), null);
});

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`independent terminal exits settle only their own waits: ${order.join('/')}`, async () => {
    const { a, b, spawned, call, create } = fixture();
    const terminals = await Promise.all([create(a), create(b)]);
    const waits = [call(a, 'wait_for_exit', terminals[0]), call(b, 'wait_for_exit', terminals[1])];
    for (const i of order) spawned[i].cb.onExit({ exitCode: i ? 7 : 0, signal: i ? 15 : 0 });
    assert.deepEqual(await Promise.all(waits), [
      { exitCode: 0, signal: null },
      { exitCode: 7, signal: '15' },
    ]);
    assert.deepEqual(await call(b, 'wait_for_exit', terminals[1]), { exitCode: 7, signal: '15' });
    assert.deepEqual((await call(b, 'output', terminals[1])).exitStatus, { exitCode: 7, signal: '15' });
  });
}

test('owner kill waits for its asynchronous exit; release wakes waiters without harming another session', async () => {
  const { host, a, b, spawned, killed, call, create } = fixture();
  const ta = await create(a);
  const tb = await create(b);
  const wait = call(a, 'wait_for_exit', ta);
  assert.equal(await call(a, 'kill', ta), null);
  spawned[0].cb.onExit({ signal: 15 });
  assert.deepEqual(await wait, { exitCode: null, signal: '15' });
  const waiting = call(b, 'wait_for_exit', tb);
  host.unbindSession(b, b.sessionId);
  assert.deepEqual(await waiting, { exitCode: null, signal: 'SIGTERM' });
  assert.ok(host.terminals.byId.has(ta.terminalId));
  assert.deepEqual(killed, [`acp:${ta.terminalId}`, `acp:${tb.terminalId}`]);
  assert.equal(await call(a, 'release', ta), null);
  assert.equal(await call(a, 'release', ta), null);
});

test('late data and exit from a released session cannot settle a replacement session with the same native ID', async () => {
  const { host, a, spawned, call, create } = fixture();
  const old = await create(a);
  const oldWait = call(a, 'wait_for_exit', old);
  host.unbindSession(a, a.sessionId);
  assert.deepEqual(await oldWait, { exitCode: null, signal: 'SIGTERM' });
  const replacement = { ...a };
  host.chats.set(a.key, replacement);
  host.bindSession(replacement, replacement.sessionId);
  const fresh = await create(replacement);
  let settled = false;
  const waiting = call(replacement, 'wait_for_exit', fresh).then((exit: unknown) => {
    settled = true;
    return exit;
  });
  spawned[0].cb.onData('late output');
  spawned[0].cb.onExit({ exitCode: 9 });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(await call(replacement, 'output', fresh), { output: '', truncated: false, exitStatus: null });
  await assert.rejects(call(replacement, 'kill', old), { code: -32602 });
  spawned[1].cb.onData('fresh output');
  spawned[1].cb.onExit({ exitCode: 0 });
  assert.deepEqual(await waiting, { exitCode: 0, signal: null });
  assert.equal((await call(replacement, 'output', fresh)).output, 'fresh output');
});

test('failed starts roll back their records and late callbacks cannot affect a successful retry', async () => {
  const callbacks: Callbacks[] = [];
  let fail = true;
  const terminals = new Terminals({
    spawn(_id: string, _opts: unknown, cb: Callbacks) {
      callbacks.push(cb);
      if (fail) throw new Error('spawn failed');
    },
    kill() {},
  });
  const owner = {};
  for (let i = 0; i < 2; i++) {
    assert.throws(() => terminals.create(owner, { command: 'mock-only' }), /spawn failed/);
    assert.equal(terminals.byId.size, 0);
  }
  fail = false;
  const terminal = terminals.create(owner, { command: 'mock-only', outputByteLimit: 4 });
  const wait = terminals.waitForExit(terminal, owner);
  for (const cb of callbacks.slice(0, 2)) {
    cb.onData('obsolete');
    cb.onExit({ exitCode: 1 });
  }
  assert.equal(terminals.byId.size, 1);
  assert.deepEqual(terminals.output(terminal, owner), { output: '', truncated: false, exitStatus: null });
  callbacks[2].onData('12345678');
  assert.equal(terminals.output(terminal, owner).truncated, true);
  callbacks[2].onExit({ exitCode: 3 });
  assert.deepEqual(await wait, { exitCode: 3, signal: null });
  terminals.release(terminal, owner);
  assert.equal(terminals.byId.size, 0);
});

test('malformed env or args cannot leave a failed terminal registered before spawn', () => {
  let spawned = 0;
  const terminals = new Terminals({ spawn: () => spawned++, kill() {} });
  for (const params of [{ env: [{ name: 'X', value: { toString: 0 } }] }, { args: null }, { args: [{ toString: 0 }] }]) {
    assert.throws(() => terminals.create({}, { command: 'mock-only', ...params }), TypeError);
    assert.equal(terminals.byId.size, 0);
    assert.equal(spawned, 0);
  }
});
