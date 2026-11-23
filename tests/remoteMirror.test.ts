// Remote terminals (M5) on fakes: a shell in a followed chat's folder with approval, backpressure, resume, resize and revocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { ok, fail, text, mirrored, follow } from './support/remote-mirror-kit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const jsonReader = require('../electron/transport/jsonReader.cjs');
const { HIGH_BYTES, LOW_BYTES, RING_BYTES, SLICE_BYTES, MAX_PER_PAIR } = require('../electron/remote/mirrorPty.cjs');
const { parseParams } = require('../shared/remote/schema.mjs');

test('mirrors are off unless the Mac turns them on for the device, and need a followed chat', async () => {
  const r = mirrored({ on: ['p1'] });
  const p2 = r.phone('p2');
  const hello = (p: any) => p.ask('machine.hello').then((x: any) => x.result.capabilities.mirrors);
  assert.equal(await hello(r.p1), true);
  assert.equal(await hello(p2), false, 'a device the Mac did not enable is not offered mirrors');
  assert.equal(r.service.mirror.available({ kind: 'panel' }), false);
  fail(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'forbidden', /Follow this chat first/);
  fail(await p2.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'forbidden', /off for this device/);
  fail(await p2.ask('frames.subscribe', { chatId: 'c1' }), 'forbidden');
  assert.equal(r.log.length, 0, 'nothing ran: no folder lookup, no card, no shell');
  const bare = rig({ policy: { mirrors: () => true } });
  const bp = bare.phone('p1');
  await follow(bp);
  fail(await bp.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'failed', /can't mirror/);
  assert.equal(bare.service.mirror.available({ kind: 'phone', pairId: 'p1' }), false, 'no seams, no mirrors');
});

test('pty.open runs one shell in the chat’s folder after the Mac’s approval, once per device, chat and folder', async () => {
  const r = mirrored();
  await follow(r.p1);
  const a = ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1', cols: 100, rows: 30, cwd: '/etc' }));
  assert.deepEqual(a, { stream: 's1', resumed: false, at: 0, truncated: false });
  assert.deepEqual(r.log, [
    ['folder', 'c1'],
    ['approve', 'c1', '/work/one'],
    // the phone's text view answers no terminal queries (electron/platform/pty.cjs)
    ['spawn', 'remote:p1:s1', { cwd: '/work/one', cols: 100, rows: 30, selfAnswer: true }],
  ]);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's2' }));
  assert.equal(r.log.filter((l) => l[0] === 'approve').length, 1, 'the card is for the first open only');
  assert.deepEqual(r.log.at(-1), ['spawn', 'remote:p1:s2', { cwd: '/work/one', cols: 80, rows: 24, selfAnswer: true }]);
  // a retried request id is answered from the service's replay, not a second shell
  const again = await r.p1.ask('pty.open', { chatId: 'c1', stream: 's3' }, 'same-id');
  const retry = await r.p1.ask('pty.open', { chatId: 'c1', stream: 's3' }, 'same-id');
  assert.deepEqual(retry.result, again.result);
  assert.equal(r.log.filter((l) => l[0] === 'spawn' && l[1] === 'remote:p1:s3').length, 1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's4' }));
  fail(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's5' }), 'forbidden', /Close a terminal/);
  assert.equal(MAX_PER_PAIR, 4);
});

test('a declined card, a chat without a folder and a failed spawn open nothing', async () => {
  const denied = mirrored({ allow: false });
  await follow(denied.p1);
  fail(await denied.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'forbidden', /declined/);
  assert.ok(!denied.log.some((l) => l[0] === 'spawn'));
  const none = mirrored({ folder: null });
  await follow(none.p1);
  fail(await none.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'gone');
  const boom = mirrored();
  boom.mirror.pty.spawn = () => {
    throw new Error('no pty');
  };
  await follow(boom.p1);
  fail(await boom.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'failed', /no pty/);
  fail(await boom.p1.ask('pty.write', { stream: 's1', data: 'x' }), 'gone', /isn't open/);
});

test('the device may be revoked, switched off or stop following while the approval card is up', async () => {
  for (const how of ['unpair', 'off', 'unfollow']) {
    const r = mirrored();
    await follow(r.p1);
    let release: (v: boolean) => void = () => {};
    r.mirror.approveTerminal = () => new Promise((res) => (release = res));
    const pending = r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }, 'open-1');
    await settle();
    if (how === 'unpair') r.link.removePair('p1');
    if (how === 'off') r.on.delete('p1');
    if (how === 'unfollow') await r.p1.ask('chat.unfollow', { chatId: 'c1' });
    release(true);
    await pending;
    await settle();
    assert.ok(!r.log.some((l) => l[0] === 'spawn'), `${how}: no shell`);
    if (how !== 'unpair')
      fail(
        r.p1.inbox.find((m: any) => m.inReplyTo === 'open-1'),
        'forbidden',
      );
  }
  // the card is retired with the device or the service, not left up
  for (const how of ['unpair', 'detach']) {
    const r = mirrored();
    await follow(r.p1);
    let signal: AbortSignal | undefined;
    r.mirror.approveTerminal = (_id: string, p: any) => new Promise(() => (signal = p.signal));
    void r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' });
    await settle();
    assert.equal(signal?.aborted, false);
    if (how === 'unpair') r.link.removePair('p1');
    else r.service.detach();
    await settle();
    assert.equal(signal?.aborted, true, how);
  }
  // a second open of the same stream while the first waits for the card
  const r = mirrored();
  await follow(r.p1);
  let release: (v: boolean) => void = () => {};
  r.mirror.approveTerminal = () => new Promise((res) => (release = res));
  const first = r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }, 'first');
  await settle();
  fail(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }), 'stale', /already opening/);
  release(true);
  await first;
  await settle();
  ok(r.p1.inbox.find((m: any) => m.inReplyTo === 'first'));
});

test('output streams as sealed base64 events with byte offsets; write, resize and close act on the one stream', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  const h = r.ptys.get('remote:p1:s1');
  h.onData('hello ');
  h.onData('wörld');
  await settle();
  const data = r.p1.events('pty.data');
  assert.deepEqual(
    data.map((e: any) => [e.stream, e.at]),
    [
      ['s1', 0],
      ['s1', 6],
    ],
  );
  assert.equal(text(data), 'hello wörld');
  assert.deepEqual(ok(await r.p1.ask('pty.write', { stream: 's1', data: 'ls\r' })), { written: true });
  assert.deepEqual(ok(await r.p1.ask('pty.resize', { stream: 's1', cols: 120, rows: 40 })), { resized: true });
  ok(await r.p1.ask('pty.resize', { stream: 's1', cols: 99999, rows: 0 }));
  assert.deepEqual(
    r.log.filter((l) => l[0] === 'write' || l[0] === 'resize'),
    [
      ['write', 'remote:p1:s1', 'ls\r'],
      ['resize', 'remote:p1:s1', 120, 40],
      ['resize', 'remote:p1:s1', 1000, 1],
    ],
  );
  // another device cannot write to this device's stream
  fail(await r.phone('p2').ask('pty.write', { stream: 's1', data: 'x' }), 'gone');
  h.onExit({ exitCode: 0, signal: null, killed: false });
  await settle();
  assert.deepEqual(
    r.p1.events('pty.exit').map((e: any) => [e.stream, e.exitCode, e.at]),
    [['s1', 0, 12]],
  );
  fail(await r.p1.ask('pty.write', { stream: 's1', data: 'x' }), 'gone');
  h.onExit({ exitCode: 1, signal: null, killed: false });
  await settle();
  assert.equal(r.p1.events('pty.exit').length, 1, 'an exit is told once');
  // close is quiet when the stream is gone, and kills it when open
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's2' }));
  assert.deepEqual(ok(await r.p1.ask('pty.close', { stream: 's2' })), { closed: true });
  assert.ok(r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p1:s2'));
  ok(await r.p1.ask('pty.close', { stream: 's2' }));
  const killedExit = r.ptys.get('remote:p1:s2');
  assert.equal(killedExit, undefined);
});

test('a killed pty’s exit is not told, and a long burst goes out in slices', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  const h = r.ptys.get('remote:p1:s1');
  h.onData('x'.repeat(SLICE_BYTES * 2 + 5));
  await settle();
  assert.deepEqual(
    r.p1.events('pty.data').map((e: any) => e.at),
    [0, SLICE_BYTES, SLICE_BYTES * 2],
  );
  await r.p1.ask('pty.close', { stream: 's1' });
  h.onExit({ exitCode: 0, signal: null, killed: true });
  await settle();
  assert.equal(r.p1.events('pty.exit').length, 0);
});

test('reconnect resume: the same stream replays only what the phone missed, and says when it fell out of the window', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  const h = r.ptys.get('remote:p1:s1');
  h.onData('abcdef');
  await settle();
  const before = r.p1.events('pty.data').length;
  const resumed = ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1', from: 4 }));
  assert.deepEqual(resumed, { stream: 's1', resumed: true, at: 6, truncated: false });
  assert.equal(r.log.filter((l) => l[0] === 'spawn').length, 1, 'no second shell');
  assert.equal(text(r.p1.events('pty.data').slice(before)), 'ef');
  assert.equal(r.p1.events('pty.data').at(-1).at, 4);
  // no offset: the whole window; an offset past the end: nothing
  const all = r.p1.events('pty.data').length;
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  assert.equal(text(r.p1.events('pty.data').slice(all)), 'abcdef');
  const n = r.p1.events('pty.data').length;
  assert.equal(ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1', from: 99 })).at, 6);
  assert.equal(r.p1.events('pty.data').length, n);
  // a stream is one chat's
  fail(await r.p1.ask('pty.open', { chatId: 'c2', stream: 's1' }), 'forbidden');
  await follow(r.p1, 'c2');
  fail(await r.p1.ask('pty.open', { chatId: 'c2', stream: 's1' }), 'stale', /another chat/);
  // more output than the window keeps: the oldest is gone and the answer says so
  h.onData('y'.repeat(RING_BYTES + 10));
  await settle();
  const big = ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1', from: 0 }));
  assert.equal(big.truncated, true);
  assert.equal(big.at, 6 + RING_BYTES + 10);
});

test('backpressure: at 2 MB unacknowledged the shell stops being read, and it resumes below 512 KB', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  const held: (() => void)[] = [];
  r.service.emit = () => new Promise<void>((res) => held.push(res));
  const h = r.ptys.get('remote:p1:s1');
  const mb = 'z'.repeat(1024 * 1024);
  h.onData(mb);
  await settle();
  assert.ok(!r.log.some((l) => l[0] === 'pause'), 'under the high-water mark');
  h.onData(mb);
  await settle();
  // events are chained, so release them one at a time as the transport would
  assert.deepEqual(
    r.log.filter((l) => l[0] === 'pause'),
    [['pause', 'remote:p1:s1']],
  );
  h.onData('more');
  assert.equal(r.log.filter((l) => l[0] === 'pause').length, 1, 'paused once');
  await waitFor(() => r.log.some((l) => l[0] === 'resume'), 'the resume', {
    step: async () => {
      held.shift()?.();
      await settle();
    },
  });
  assert.deepEqual(
    r.log.filter((l) => l[0] === 'resume'),
    [['resume', 'remote:p1:s1']],
  );
  // a session closed while paused is not resumed
  const q = mirrored();
  await follow(q.p1);
  ok(await q.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  const held2: (() => void)[] = [];
  q.service.emit = () => new Promise<void>((res) => held2.push(res));
  q.ptys.get('remote:p1:s1').onData('z'.repeat(2 * 1024 * 1024));
  await settle();
  await q.p1.ask('pty.close', { stream: 's1' });
  for (let i = 0; i < 200; i++) {
    held2.shift()?.();
    await settle();
  }
  assert.ok(!q.log.some((l) => l[0] === 'resume'));
});

test('a revoked, switched-off or unfollowing device ends its shells and gets nothing more', async () => {
  const r = mirrored({ on: ['p1', 'p2'] });
  const p2 = r.phone('p2');
  await follow(r.p1);
  await follow(p2);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  ok(await p2.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  // switched off on the Mac: the next write is refused and the shell ends
  r.on.delete('p1');
  fail(await r.p1.ask('pty.write', { stream: 's1', data: 'x' }), 'forbidden');
  assert.ok(r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p1:s1'));
  // revoked: the pair is removed, its shell is killed, the other device's stays
  r.link.removePair('p2');
  await settle();
  assert.ok(r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p2:s1'));
  // output after the chat is unfollowed ends the shell instead of streaming on
  r.on.add('p1');
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's2' }));
  const h = r.ptys.get('remote:p1:s2');
  await r.p1.ask('chat.unfollow', { chatId: 'c1' });
  h.onData('secret');
  await settle();
  assert.equal(r.p1.events('pty.data').length, 0);
  assert.ok(r.log.filter((l) => l[0] === 'kill' && l[1] === 'remote:p1:s2').length === 1);
  // a device that comes back is asked again
  r.link.addPair('p2');
  await settle();
  const back = r.phone('p2');
  await follow(back);
  const before = r.log.filter((l) => l[0] === 'approve').length;
  ok(await back.ask('pty.open', { chatId: 'c1', stream: 's9' }));
  assert.equal(r.log.filter((l) => l[0] === 'approve').length, before + 1);
  r.service.detach();
  assert.ok(r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p2:s9'));
});

test('the shell’s water marks are the JSON input’s', () => {
  assert.equal(HIGH_BYTES, jsonReader.HIGH_BYTES);
  assert.equal(LOW_BYTES, jsonReader.LOW_BYTES);
});

test('the schema checks streams, sizes and chats', () => {
  assert.deepEqual(parseParams('pty.open', { chatId: 'c1', stream: 's-1', cols: 'x', from: -1 }), {
    chatId: 'c1',
    stream: 's-1',
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(parseParams('pty.open', { chatId: 'c1', stream: 's', cols: 5.9, rows: 2000, from: 7 }), {
    chatId: 'c1',
    stream: 's',
    cols: 5,
    rows: 1000,
    from: 7,
  });
  assert.throws(() => parseParams('pty.open', { chatId: 'c1', stream: 'bad stream' }), /isn't open/);
  assert.throws(() => parseParams('pty.close', {}), /isn't open/);
  assert.throws(() => parseParams('pty.write', { stream: 's', data: '' }), /Type something/);
  assert.throws(() => parseParams('pty.write', { stream: 's', data: 'x'.repeat(64 * 1024 + 1) }), /too long/);
  assert.throws(() => parseParams('frames.subscribe', { chatId: '' }), /isn't in MoPilot/);
  assert.deepEqual(parseParams('frames.unsubscribe', { chatId: 'c1' }), { chatId: 'c1' });
  assert.deepEqual(parseParams('pty.resize', { stream: 's' }), { stream: 's', cols: 80, rows: 24 });
});

test('switching off or unfollowing ends an idle shell and retires a pending card at once, and asks again when switched back on', async () => {
  for (const how of ['off', 'unfollow']) {
    const r = mirrored();
    await follow(r.p1);
    ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
    const spawned = r.log.filter((l) => l[0] === 'spawn').length;
    // a silent shell: nothing is printed or written, so only the change itself can end it
    if (how === 'off') {
      r.on.delete('p1');
      r.service.mirror.recheck();
    } else await r.p1.ask('chat.unfollow', { chatId: 'c1' });
    assert.ok(
      r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p1:s1'),
      `${how}: the idle shell ended`,
    );
    assert.equal(spawned, 1);
  }
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  r.on.delete('p1');
  r.service.mirror.recheck();
  r.on.add('p1');
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's2' }));
  assert.equal(r.log.filter((l) => l[0] === 'approve').length, 2, 'switched off and on again: the Mac is asked again');
  // a grant of a device that is still on is kept
  r.service.mirror.recheck();
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's3' }));
  assert.equal(r.log.filter((l) => l[0] === 'approve').length, 2);
  // a card still up when the switch goes off is retired
  const q = mirrored();
  await follow(q.p1);
  let signal: AbortSignal | undefined;
  q.mirror.approveTerminal = (_id: string, p: any) => new Promise(() => (signal = p.signal));
  void q.p1.ask('pty.open', { chatId: 'c1', stream: 's1' });
  await settle();
  q.service.mirror.recheck();
  assert.equal(signal?.aborted, false, 'still allowed: the card stays');
  q.on.delete('p1');
  q.service.mirror.recheck();
  assert.equal(signal?.aborted, true);
});

test('output after the switch went off with no recheck still ends the shell and is not sent', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('pty.open', { chatId: 'c1', stream: 's1' }));
  r.on.delete('p1');
  r.ptys.get('remote:p1:s1').onData('late');
  await settle();
  assert.equal(r.p1.events('pty.data').length, 0);
  assert.ok(r.log.some((l) => l[0] === 'kill' && l[1] === 'remote:p1:s1'));
});
