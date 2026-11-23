// In-app browser backend rpc unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { require, Peer, FrameDecoder, encodeFrame, tick } from './fixture';

export function registerRpcCases() {
  function pair() {
    const sock: any = new EventEmitter();
    sock.destroyed = false;
    sock.written = [] as any[];
    sock.write = (buf: Buffer) => {
      if (sock.throwOnWrite) throw new Error('x');
      sock.written.push(...new FrameDecoder().push(buf));
    };
    sock.destroy = () => {
      sock.destroyed = true;
    };
    return sock;
  }

  test('peer: requests wait for the gate; results, errors and notifications; a closed gate or bad frame drops the socket', async () => {
    const sock = pair();
    let open: (v: boolean) => void = () => {};
    const seen: any[] = [];
    const peer = new Peer(
      sock,
      async (m: string, p: any) => {
        seen.push([m, p]);
        if (m === 'boom') throw new Error('bad');
        if (m === 'str') throw 'plain';
        return m === 'nothing' ? undefined : { m };
      },
      new Promise((r) => (open = r)),
    );
    sock.emit('data', encodeFrame({ jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } }));
    await tick();
    assert.deepEqual(seen, []);
    open(true);
    await tick();
    await tick();
    sock.emit(
      'data',
      Buffer.concat([
        encodeFrame({ jsonrpc: '2.0', id: 2, method: 'boom' }),
        encodeFrame({ jsonrpc: '2.0', id: 3, method: 'str' }),
        encodeFrame({ jsonrpc: '2.0', id: 4, method: 'nothing' }),
        encodeFrame({ jsonrpc: '2.0', method: 'moveMouse', params: { x: 1 } }),
        encodeFrame({ jsonrpc: '2.0', method: 'boom' }),
        encodeFrame({ jsonrpc: '2.0', id: 5, result: 1 }),
        encodeFrame(null),
      ]),
    );
    for (let i = 0; i < 6; i++) await tick();
    assert.deepEqual(sock.written, [
      { jsonrpc: '2.0', id: 1, result: { m: 'a' } },
      { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'bad' } },
      { jsonrpc: '2.0', id: 3, error: { code: 1, message: 'plain' } },
      { jsonrpc: '2.0', id: 4, result: null },
    ]);
    assert.deepEqual(
      seen.map((s) => s[0]),
      ['a', 'boom', 'str', 'nothing', 'moveMouse', 'boom'],
    );
    peer.notify('onCDPEvent', { a: 1 });
    assert.deepEqual(sock.written.at(-1), { jsonrpc: '2.0', method: 'onCDPEvent', params: { a: 1 } });
    sock.throwOnWrite = true;
    peer.notify('x', {});
    sock.throwOnWrite = false;
    sock.emit('error', new Error('x'));
    sock.emit('close');
    peer.notify('after', {});
    assert.equal(sock.written.at(-1).method, 'onCDPEvent');
    // a bad frame
    const bad = pair();
    new Peer(bad, async () => null, Promise.resolve(true));
    bad.emit('data', Buffer.from([255, 255, 255, 255]));
    assert.equal(bad.destroyed, true);
    // the gate says no, or fails
    for (const gateOf of [() => Promise.resolve(false), () => Promise.reject(new Error('x'))]) {
      const gate = gateOf();
      const s = pair();
      const calls: any[] = [];
      new Peer(s, async (m: string) => calls.push(m), gate);
      s.emit('data', encodeFrame({ jsonrpc: '2.0', id: 1, method: 'a' }));
      await tick();
      await tick();
      assert.equal(s.destroyed, true);
      assert.deepEqual(calls, []);
    }
    // a destroyed socket gets nothing
    const gone = pair();
    const p2 = new Peer(gone, async () => null, Promise.resolve(true));
    gone.destroyed = true;
    p2.notify('x', {});
    assert.deepEqual(gone.written, []);
  });

  test('peer: a result the pipe cannot carry answers its request with the error instead of leaving it to time out', async () => {
    const { recentIgnored, clearIgnored } = require('../../../electron/ignored.cjs');
    clearIgnored();
    const sock = pair();
    const write = sock.write;
    const failures: unknown[] = [];
    sock.write = (buf: Buffer) => {
      if (failures.length) throw failures.shift();
      write(buf);
    };
    const peer = new Peer(sock, async (m: string) => ({ m }), Promise.resolve(true));
    failures.push(new Error('The message is too large for the browser pipe.'));
    sock.emit('data', encodeFrame({ jsonrpc: '2.0', id: 7, method: 'big' }));
    for (let i = 0; i < 4; i++) await tick();
    failures.push('closed');
    sock.emit('data', encodeFrame({ jsonrpc: '2.0', id: 8, method: 'big' }));
    for (let i = 0; i < 4; i++) await tick();
    assert.deepEqual(sock.written, [
      { jsonrpc: '2.0', id: 7, error: { code: 1, message: 'The message is too large for the browser pipe.' } },
      { jsonrpc: '2.0', id: 8, error: { code: 1, message: 'closed' } },
    ]);
    sock.written.length = 0;
    // an error answer too large for the pipe is replaced the same way, by a short one
    const other = pair();
    const otherWrite = other.write;
    let tooLarge = true;
    other.write = (buf: Buffer) => {
      if (tooLarge) {
        tooLarge = false;
        throw new Error(`The message is too large: ${'x'.repeat(5000)}`);
      }
      otherWrite(buf);
    };
    new Peer(
      other,
      async () => {
        throw new Error('y'.repeat(5000));
      },
      Promise.resolve(true),
    );
    other.emit('data', encodeFrame({ jsonrpc: '2.0', id: 10, method: 'big' }));
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(other.written.length, 1);
    assert.equal(other.written[0].id, 10);
    assert.equal(other.written[0].error.message.length, 1000);
    // an error answer or a notification that cannot be written is recorded
    failures.push(new Error('pipe gone'), new Error('pipe gone'));
    sock.emit('data', encodeFrame({ jsonrpc: '2.0', id: 9, method: 'big' }));
    for (let i = 0; i < 4; i++) await tick();
    failures.push(new Error('pipe gone'));
    peer.notify('onCDPEvent', {});
    assert.deepEqual(
      recentIgnored().map((e: any) => [e.context, e.message, e.count]),
      [['send a message to the Codex browser plugin', 'pipe gone', 2]],
    );
    clearIgnored();
  });
}
