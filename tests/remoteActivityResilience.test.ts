// The Live Activity bridge when things go wrong or move: nothing busy to report, a repeat that is not starved, failed and rejected sends tried again, sealed titles that appear later, answers that arrive late or from before a restart, and pairs that come and go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
import { rig } from './support/remoteActivityRig.ts';

const require = createRequire(import.meta.url);
const { createActivityBridge, DELAY_MS, HEARTBEAT_MS, RETRY_MS } = require('../electron/remote/activityBridge.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

test('with no session store the bridge has nothing busy to report: a new connection ends what the relay may still hold, once', async () => {
  const calls: any[] = [];
  const live: any = { devices: { list: () => [{ pairId: 'p_one' }] }, activityUpdate: async (req: any) => (calls.push(req), 'sent') };
  const bridge = createActivityBridge({ state: null, owns: () => true, titleOf: () => null, remote: () => live });
  bridge.resend();
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0].state, at: 0 }, { needs: 0, running: 0, kind: 'done', since: 0, at: 0, rows: [] });
  bridge.resend();
  await tick();
  assert.equal(calls.length, 2);
  bridge.reset();
});

test('flushes that send nothing do not hold back the repeat, so a quiet busy Mac is still heard from', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  const beat = [...r.timers.entries()].find(([, v]) => v.ms === HEARTBEAT_MS)![0];
  // other chats’ turns keep changing; the snapshot does not
  for (let i = 0; i < 3; i++) {
    r.bridge.changed();
    await r.fire(DELAY_MS);
  }
  assert.equal(r.sent.length, 1);
  assert.ok(r.timers.has(beat), 'the same repeat is still waiting');
  await r.fire(HEARTBEAT_MS);
  assert.equal(r.sent.length, 2);
});

test('a send that failed, even the closing one, is tried again after a while', async () => {
  let status = 'sent';
  const r = rig({ pairs: ['p_one'] });
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }] },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve(status)),
  });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  status = 'failed';
  r.end('c1');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].state.running, 0);
  status = 'sent';
  await r.fire(RETRY_MS);
  assert.equal(r.sent.length, 3);
  assert.equal(r.sent[2].state.running, 0);
  // done: no further retry is waiting
  assert.ok(![...r.timers.values()].some((t) => t.ms === RETRY_MS));
});

test('a rejected send is tried again after a while too', async () => {
  const r = rig({ pairs: ['p_one'], reject: true });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  await tick();
  await r.fire(RETRY_MS);
  assert.equal(r.sent.length, 2);
});

test('the sealed bytes differ every time and do not make a snapshot look changed; a title that was missing and is sealed later does', async () => {
  let n = 0;
  const r = rig({ pairs: ['p_one'], titles: { c1: 'T' } });
  const live: any = {
    devices: { list: () => [{ pairId: 'p_one' }] },
    pushTitles: { enabled: true, seal: () => (n++ < 2 ? null : Buffer.from(`nonce${n}`).toString('base64url')) },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  };
  r.setRemote(live);
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal('st' in r.sent[0].state.rows[0], false);
  // the key was not there: another try is waiting, and the title goes with it
  await r.fire(RETRY_MS);
  assert.equal('st' in r.sent[0].state.rows[0], false);
  await r.fire(RETRY_MS);
  assert.equal(r.sent.length, 2);
  assert.equal(typeof r.sent[1].state.rows[0].st, 'string');
  // the same snapshot with fresh random bytes is not a change
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  assert.ok(![...r.timers.values()].some((t) => t.ms === RETRY_MS));
});

test('with chat titles off no retry waits for a key that will never come', async () => {
  const r = rig({ pairs: ['p_one'], titles: { c1: 'T' } });
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }] },
    pushTitles: { enabled: false, seal: () => null },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.ok(![...r.timers.values()].some((t) => t.ms === RETRY_MS));
});

test('a failure while preparing an update is noted and tried again, not thrown from the timer', async () => {
  const r = rig({ pairs: ['p_one'] });
  r.setRemote({
    devices: {
      list: () => {
        throw new Error('device list unreadable');
      },
    },
  });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.ok(recentIgnored().some((e: any) => /prepare a Live Activity update/.test(e.context)));
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }] },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  });
  await r.fire(RETRY_MS);
  assert.equal(r.sent.length, 1);
});

test('only the newest send of a pair is recorded, and an answer from before a restart is not', async () => {
  const answers: Array<(s: string) => void> = [];
  const r = rig({ pairs: ['p_one'] });
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }] },
    activityUpdate: (req: any) => (r.sent.push(req), new Promise((resolve) => answers.push(resolve))),
  });
  r.chat('a', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.chat('b', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  // the newer send answers first, the older one after it: the older must not overwrite what the relay holds
  answers[1]('sent');
  await tick();
  answers[0]('sent');
  await tick();
  // nothing changed since the newer send, so nothing is sent (an overwritten record would look like a change)
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  // an answer that arrives after a restart belongs to the old connection: it is not recorded, so the next flush sends again
  r.chat('c', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 3);
  r.bridge.reset();
  answers[2]('sent');
  await tick();
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 4);
});

test('a late answer from before a restart is not taken for the answer to the first send after it', async () => {
  const answers: Array<(s: string) => void> = [];
  const r = rig({ pairs: ['p_one'] });
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }] },
    activityUpdate: (req: any) => (r.sent.push(req), new Promise((resolve) => answers.push(resolve))),
  });
  r.chat('a', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.bridge.reset();
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  // the first connection's send answers now; the new connection's send is still out, so nothing is recorded yet
  answers[0]('sent');
  await tick();
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 3, 'the snapshot the new connection has not confirmed is sent again');
});

test('a pair that is no longer paired is forgotten', async () => {
  const r = rig({ pairs: ['p_one', 'p_two'] });
  r.chat('c1', 'running');
  r.bridge.changed();
  await r.fire(DELAY_MS);
  assert.equal(r.sent.length, 2);
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_two' }] },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  });
  r.bridge.changed();
  await r.fire(DELAY_MS);
  r.setRemote({
    devices: { list: () => [{ pairId: 'p_one' }, { pairId: 'p_two' }] },
    activityUpdate: (req: any) => (r.sent.push(req), Promise.resolve('sent')),
  });
  r.bridge.changed();
  await r.fire(DELAY_MS);
  // p_one comes back as a pair nothing was told about
  assert.equal(r.sent.length, 3);
  assert.equal(r.sent[2].pair, 'p_one');
});
