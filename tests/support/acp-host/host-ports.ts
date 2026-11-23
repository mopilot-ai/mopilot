// ACP host host-ports unit cases with shared fake-agent and transcript fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acp, dir, fakePty } from './fixture';

export function registerHostPortsCases() {
  test('isSageToolCall: only the random server name, in a title or _meta, for a kind that may be a tool', () => {
    const n = 'sage_0123456789ab';
    assert.equal(acp.isSageToolCall(null, n), false);
    assert.equal(acp.isSageToolCall({ title: `mcp__${n}__x` }, undefined), false);
    assert.equal(acp.isSageToolCall({ title: `mcp__${n}__x` }, 'sage_nothex'), false);
    assert.equal(acp.isSageToolCall({ kind: 'execute', title: `mcp__${n}__x` }, n), false);
    for (const t of [`mcp__${n}__x`, `${n}__x`, `${n}/x`, `${n}.x`, `${n}:x`, `x (${n} MCP Server)`])
      assert.equal(acp.isSageToolCall({ title: t }, n), true, t);
    assert.equal(acp.isSageToolCall({ title: 'run', _meta: { tool: `${n}/x` } }, n), true);
    assert.equal(acp.isSageToolCall({ title: 'run', _meta: { claude: { toolName: `mcp__${n}__y`, n: 1 }, other: null, num: 3 } }, n), true);
    assert.equal(acp.isSageToolCall({ title: 'run', _meta: 'x' }, n), false);
    assert.equal(acp.isSageToolCall({ title: 5 }, n), false);
  });

  test('allowOnce prefers allow_once, else any allow, else nothing', () => {
    assert.equal(acp.allowOnce(null), undefined);
    assert.equal(acp.allowOnce([{ kind: 'reject_once' }, { kind: 'allow_always', optionId: 'a' }]).optionId, 'a');
    assert.equal(
      acp.allowOnce([
        { kind: 'allow_always', optionId: 'a' },
        { kind: 'allow_once', optionId: 'b' },
      ]).optionId,
      'b',
    );
  });

  /* ------------------------------------------------------------------ */
  /* fs and terminals                                                    */
  /* ------------------------------------------------------------------ */
  test('readTextFile and writeTextFile: absolute paths only, line windows, unreadable files, empty content', () => {
    const f = path.join(dir, 'sub', 'f.txt');
    assert.equal(acp.writeTextFile({ path: f }), null);
    assert.equal(fs.readFileSync(f, 'utf8'), '');
    acp.writeTextFile({ path: f, content: 'a\nb\nc\nd' });
    assert.throws(() => acp.writeTextFile({ path: 'rel.txt', content: 'x' }), /must be absolute/);
    assert.throws(
      () => acp.readTextFile({ path: 'rel.txt' }),
      (e: any) => e instanceof acp.RpcError && e.code === -32602,
    );
    assert.throws(() => acp.readTextFile({ path: 42 }), /must be absolute/);
    assert.throws(
      () => acp.readTextFile({ path: path.join(dir, 'nope') }),
      (e: any) => e instanceof acp.RpcError && e.code === -32002 && /ENOENT/.test(e.message),
    );
    assert.deepEqual(acp.readTextFile({ path: f, line: 2 }), { content: 'b\nc\nd' });
    assert.deepEqual(acp.readTextFile({ path: f, line: 'x', limit: 2 }), { content: 'a\nb' });
    assert.deepEqual(acp.readTextFile({ path: f, limit: 'x' }), { content: '' });
    assert.deepEqual(acp.readTextFile({ path: f, line: 0, limit: -1 }), { content: '' });
  });

  test('Terminals: a command is required; env from name/value pairs; output kept to its limit; exit and release wake waiters', async () => {
    const pty = fakePty();
    const t = new acp.Terminals(pty);
    assert.throws(() => t.create('s', {}), /command is required/);
    const { terminalId } = t.create('s', {
      command: 'ls',
      args: [1],
      env: [{ name: 'A', value: 2 }, { name: 'B' }, null, { value: 'x' }],
      cwd: '/w',
      outputByteLimit: 8,
    });
    // no terminal view answers an agent's terminal: its pty answers ConPTY's question itself (electron/platform/pty.cjs)
    assert.deepEqual(pty.spawned[0].opts, {
      command: ['ls', '1'],
      cwd: '/w',
      env: { A: '2', B: '' },
      cols: 120,
      rows: 30,
      selfAnswer: true,
    });
    const cb = pty.spawned[0].cb;
    cb.onData('0123456789abcdef');
    const out = t.output({ terminalId }, 's');
    assert.equal(out.truncated, true);
    assert.ok(Buffer.byteLength(out.output) <= 8);
    assert.equal(out.exitStatus, null);
    const waited = t.waitForExit({ terminalId }, 's');
    cb.onExit({ signal: 15 });
    assert.deepEqual(await waited, { exitCode: null, signal: '15' });
    assert.deepEqual(t.waitForExit({ terminalId }, 's'), { exitCode: null, signal: '15' });
    assert.equal(t.kill({ terminalId }, 's'), null);
    assert.deepEqual(pty.killed, [`acp:${terminalId}`]);
    assert.throws(() => t.kill({ terminalId: 'nope' }, 's'), /Unknown terminal: nope/);
    // defaults: no args, no env (or not a list), the default limit
    const b = t.create('s2', { command: 'sh', env: 'x' });
    assert.equal(t.byId.get(b.terminalId).limit, 1_000_000);
    pty.spawned[1].cb.onExit({ exitCode: 0 });
    assert.deepEqual(t.output(b, 's2').exitStatus, { exitCode: 0, signal: null });
    // release: unknown is fine; a waiting one hears SIGTERM; the session's terminals all go
    assert.equal(t.release({ terminalId: 'nope' }, 's'), null);
    const c = t.create('s3', { command: 'sleep' });
    const d = t.create('s3', { command: 'sleep' });
    const w = t.waitForExit(c, 's3');
    t.releaseSession('s3');
    assert.deepEqual(await w, { exitCode: null, signal: 'SIGTERM' });
    assert.equal(t.byId.has(d.terminalId), false);
    assert.ok(t.byId.has(b.terminalId));
    t.release(b, 's2');
    assert.equal(t.byId.has(b.terminalId), false);
  });
}
