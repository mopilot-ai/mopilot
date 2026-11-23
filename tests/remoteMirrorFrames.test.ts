// Remote frames (M5) on fakes: none without a running tool, at most 2 a second, masked as the model's are, stopping with the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { settle } from './support/remote-kit.ts';
import { setup, tabOf, drive } from './support/browser-host-kit.ts';
import { ok, fail, mirrored, follow } from './support/remote-mirror-kit.ts';

const require = createRequire(import.meta.url);
const { FRAME_MS, MAX_FRAME_CHARS } = require('../electron/remote/mirrorFrames.cjs');
const { browserFrame, FRAME_SCALE } = require('../electron/remote/mirrorFrame.cjs');

/** The newest timer the loop set. */
const last = (r: any) => r.timers.at(-1)!;

/** Takes the pending capture and answers it. */
const answerShot = async (r: any, data = 'AAAA', size = { width: 200, height: 100 }) => {
  const shot = r.shots.shift();
  shot.resolve({ data, ...size });
  await settle();
  return shot.surface;
};

test('frames: none without a tool, at most 2 a second while one runs, and they stop with the tool', async () => {
  const r = mirrored();
  await follow(r.p1);
  assert.deepEqual(ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' })), { subscribed: true, active: false });
  assert.equal(r.shots.length, 0, 'no idle capture: subscribing alone captures nothing');
  assert.equal(r.timers.length, 0);
  r.toolChanged('browser');
  await settle();
  assert.equal(r.p1.events('frames.state').at(-1).active, true);
  assert.equal(await answerShot(r), 'browser');
  const frames = () => r.p1.events('frames.frame');
  assert.deepEqual(
    frames().map((e: any) => [e.seq, e.surface, e.width, e.height, e.jpeg]),
    [[1, 'browser', 200, 100, 'AAAA']],
  );
  assert.equal(r.timers.length, 1);
  assert.equal(FRAME_MS, 500, 'the next frame waits out the 500 ms of a 2 fps cap');
  r.toolChanged('screen');
  last(r).fn();
  await settle();
  assert.equal(await answerShot(r, 'BBBB'), 'screen');
  assert.equal(frames().at(-1).surface, 'screen');
  // the tool ends while the next image is being taken: that frame is dropped, the loop and its timer are gone
  last(r).fn();
  await settle();
  assert.equal(r.shots.length, 1);
  r.toolChanged(null);
  await settle();
  const sent = frames().length;
  await answerShot(r, 'CCCC');
  assert.equal(frames().length, sent, 'no frame after the tool ended');
  assert.equal(r.p1.events('frames.state').at(-1).active, false);
  assert.equal(r.shots.length, 0, 'no capture afterwards');
  // a new tool run starts a new loop; unsubscribing ends it
  r.toolChanged('browser');
  await settle();
  assert.equal(r.shots.length, 1);
  assert.deepEqual(ok(await r.p1.ask('frames.unsubscribe', { chatId: 'c1' })), { unsubscribed: true });
  await answerShot(r);
  assert.equal(r.p1.events('frames.frame').length, sent, 'an unsubscribed device gets none');
  assert.ok(last(r).cleared);
});

test('frames: a device that does not follow the chat, is off or was revoked gets none; others on the chat share the loop', async () => {
  const r = mirrored({ on: ['p1', 'p2'] });
  const p2 = r.phone('p2');
  fail(await p2.ask('frames.subscribe', { chatId: 'c1' }), 'forbidden', /Follow this chat first/);
  await follow(r.p1);
  await follow(p2);
  ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' }));
  ok(await p2.ask('frames.subscribe', { chatId: 'c1' }));
  r.toolChanged('browser');
  await settle();
  await answerShot(r);
  assert.equal(r.p1.events('frames.frame').length, 1);
  assert.equal(p2.events('frames.frame').length, 1, 'one capture serves every subscriber');
  // p2 stops following: it is pruned on the next frame; p1 goes off: the loop has nobody and stops
  await p2.ask('chat.unfollow', { chatId: 'c1' });
  last(r).fn();
  await settle();
  await answerShot(r);
  assert.equal(p2.events('frames.frame').length, 1);
  assert.equal(r.p1.events('frames.frame').length, 2);
  r.on.delete('p1');
  last(r).fn();
  await settle();
  assert.equal(r.shots.length, 0, 'nobody allowed: no capture');
  assert.equal(r.service.mirror.frames.loops.size, 0);
  // revoked while a frame is being taken: dropped
  r.on.add('p1');
  ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' }));
  await settle();
  assert.equal(r.shots.length, 1);
  r.link.removePair('p1');
  await settle();
  const sent = r.p1.events('frames.frame').length;
  await answerShot(r);
  assert.equal(r.p1.events('frames.frame').length, sent);
  r.service.detach();
  r.toolChanged(null);
});

test('frames: a failed or oversized capture skips that frame and the loop goes on; closing stops it', async () => {
  const r = mirrored();
  await follow(r.p1);
  ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' }));
  r.toolChanged('browser');
  await settle();
  r.shots.shift()?.resolve(null);
  await settle();
  assert.equal(r.p1.events('frames.frame').length, 0, 'no page, no frame');
  last(r).fn();
  await settle();
  await answerShot(r, 'x'.repeat(MAX_FRAME_CHARS + 1));
  assert.equal(r.p1.events('frames.frame').length, 0, 'too big for one sealed message');
  last(r).fn();
  await settle();
  r.mirror.frame = async () => {
    throw new Error('capture failed');
  };
  last(r).fn();
  await settle();
  assert.equal(last(r).cleared, false, 'the loop waits for the next frame');
  // a send that fails is only noted
  r.service.emit = () => Promise.reject(new Error('relay down'));
  r.mirror.frame = async () => ({ data: 'AAAA', width: 1, height: 1 });
  last(r).fn();
  await settle();
  r.service.detach();
  assert.ok(last(r).cleared);
  const nobody = mirrored();
  nobody.service.mirror.frames.closeAll();
});

test('frames use real timers when the host gives none', async () => {
  const r = mirrored();
  delete (r.mirror as any).timers;
  await follow(r.p1);
  ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' }));
  r.toolChanged('browser');
  await settle();
  r.shots.shift()?.resolve({ data: 'AAAA', width: 1, height: 1 });
  await settle();
  r.toolChanged(null);
  await settle();
  assert.equal(r.service.mirror.frames.loops.size, 0);
});

test('frames come from the model’s own capture: password fields are masked first and put back after, at a phone-sized scale', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const order: any[] = [];
  tab.wc.ops.mask = (args: any, sid?: string) => (order.push(['mask', args.on, sid ?? '']), { count: 0 });
  const source = browserFrame({
    capture: (...a: any[]) => h.tabs.capture(...a),
    current: (chatId: string) => (chatId === 'c' ? tab : null),
  });
  const frame = await drive(t, source('c'));
  assert.deepEqual(order.slice(0, 1), [['mask', true, '']]);
  assert.deepEqual(order.at(-1), ['mask', false, '']);
  assert.deepEqual([frame.width, frame.height], [800 * FRAME_SCALE, 600 * FRAME_SCALE]);
  assert.equal(typeof frame.data, 'string');
  assert.equal(await source('other'), null, 'a chat with no page has no frame');
});

test('frames: a device switched off or unfollowed while its frame is being taken does not get it', async () => {
  for (const how of ['off', 'unfollow']) {
    const r = mirrored();
    await follow(r.p1);
    ok(await r.p1.ask('frames.subscribe', { chatId: 'c1' }));
    r.toolChanged('screen');
    await settle();
    assert.equal(r.shots.length, 1);
    if (how === 'off') {
      r.on.delete('p1');
      r.service.mirror.recheck();
    } else await r.p1.ask('chat.unfollow', { chatId: 'c1' });
    await answerShot(r);
    assert.equal(r.p1.events('frames.frame').length, 0, how);
  }
});
