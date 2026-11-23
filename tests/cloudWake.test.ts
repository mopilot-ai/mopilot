// Wake (C2): a stopped cloud machine is resumed once however many clients ask, the Host's dial-out is waited for, a stop still finishing is retried, a gone machine is said gone, a failure leaves the message queued with the reason and is not retried at once; the outbox sends the waiting message once after the wake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CloudError, createFakeProvider } from '../shared/cloud/adapter.mjs';

const require = createRequire(import.meta.url);
const { createCloudWake } = require('../electron/host/cloudWake.cjs');
const { createOutbox } = require('../electron/host/outbox.cjs');
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { useFakeClock } from './support/ports/clock.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setup(over: { cloud?: boolean; status?: string } = {}) {
  const provider = createFakeProvider();
  const row: any = {
    status: over.status ?? 'offline',
    cloud: over.cloud === false ? null : { provider: 'fake', id: 'fake-1', region: 'r1' },
  };
  const states: any[] = [];
  const checks: string[] = [];
  const wake = createCloudWake({
    rowOf: () => row,
    adapterOf: () => provider,
    check: (id: string) => void checks.push(id),
    onState: (id: string, s: any) => states.push(s),
    sleep: async () => {
      // each wait lets the machine come up and its Host dial out
      if (provider.machines.get('fake-1')?.state === 'starting') provider.set('fake-1', 'running');
      else if (provider.machines.get('fake-1')?.state === 'running') row.status = 'online';
    },
  });
  return { provider, row, states, checks, wake };
}
const sleeping = async (s: ReturnType<typeof setup>) => {
  await s.provider.create({ name: 'n', size: 's', region: 'r1', command: 'c' });
  s.provider.set('fake-1', 'stopped');
};

test('a stopped machine is resumed, its Host waited for, and the line goes Waking… then online', async () => {
  const s = setup();
  await sleeping(s);
  assert.deepEqual(await s.wake.wake('relay:h1'), { state: 'online' });
  assert.equal(s.provider.calls.filter((c) => c.call === 'resume').length, 1);
  assert.deepEqual(
    s.states.map((x) => x.state),
    ['waking', 'online'],
  );
  assert.deepEqual(s.checks, ['relay:h1']);
});

test('two clients waking at once call resume once and share the answer', async () => {
  const s = setup();
  await sleeping(s);
  const [a, b] = await Promise.all([s.wake.wake('relay:h1'), s.wake.wake('relay:h1')]);
  assert.deepEqual([a, b], [{ state: 'online' }, { state: 'online' }]);
  assert.equal(s.provider.calls.filter((c) => c.call === 'resume').length, 1);
});

test('a machine that is not a cloud machine, or is online already, is left alone', async () => {
  const plain = setup({ cloud: false });
  assert.deepEqual(await plain.wake.wake('x'), { state: 'not-cloud' });
  const up = setup({ status: 'online' });
  assert.deepEqual(await up.wake.wake('x'), { state: 'online' });
  assert.equal(up.provider.calls.length, 0);
});

test('a wake that races a stop is retried until the provider takes it', async () => {
  const s = setup();
  await sleeping(s);
  s.provider.failNext('resume', new CloudError('busy', 'still stopping', { retryable: true }));
  assert.deepEqual(await s.wake.wake('relay:h1'), { state: 'online' });
  assert.equal(s.provider.calls.filter((c) => c.call === 'resume').length, 2);
});

test('gone comes from the provider: a status of gone, or a resume that fails as gone', async () => {
  const a = setup();
  assert.deepEqual(await a.wake.wake('relay:h1'), { state: 'gone' });
  assert.equal(a.states.at(-1).state, 'gone');
  const b = setup();
  await sleeping(b);
  b.provider.failNext('resume', new CloudError('gone', 'gone'));
  assert.deepEqual(await b.wake.wake('relay:h1'), { state: 'gone' });
});

test('a wake that fails says why, is not tried again at once, and never rejects', async () => {
  const s = setup();
  await sleeping(s);
  s.provider.failNext('resume', new CloudError('refused', 'That key was refused.'));
  const out: any = await s.wake.wake('relay:h1');
  assert.deepEqual(out, { state: 'failed', reason: 'That key was refused.' });
  assert.deepEqual(s.states.at(-1), { state: 'failed', reason: 'That key was refused.' });
  assert.deepEqual(await s.wake.wake('relay:h1'), { state: 'failed' });
  assert.equal(s.provider.calls.filter((c) => c.call === 'resume').length, 1);
  const t = setup();
  await sleeping(t);
  t.provider.failNext('resume', 'plain');
  assert.equal(((await t.wake.wake('relay:h1')) as any).reason, 'The provider could not wake the machine.');
});

test('a machine that starts but whose Host never answers ends with no_answer', async () => {
  const s = setup();
  await sleeping(s);
  s.provider.set('fake-1', 'running');
  let t = 1_000_000;
  const stuck = createCloudWake({ rowOf: () => s.row, adapterOf: () => s.provider, sleep: async () => void (t += 200_000), now: () => t });
  const out: any = await stuck.wake('relay:h1');
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /did not answer/);
});

test('a message typed while the machine sleeps waits in the outbox and is delivered once after the wake', async () => {
  const s = setup();
  await sleeping(s);
  const outbox = createOutbox({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-wake-')) });
  const delivered: string[] = [];
  outbox.add('chat1', { key: 'k1', epoch: 1, options: { text: 'hi' } });
  const online = () => s.row.status === 'online';
  const first = await outbox.drain('chat1', { online, send: async () => void delivered.push('too early') });
  assert.equal(first.stopped, 'offline');
  assert.equal(outbox.pending('chat1').length, 1);
  assert.deepEqual(await s.wake.wake('relay:h1'), { state: 'online' });
  const after = await outbox.drain('chat1', { online, send: async (e: any) => void delivered.push(e.key) });
  outbox.ack('chat1', ['k1']);
  const again = await outbox.drain('chat1', { online, send: async (e: any) => void delivered.push(e.key) });
  assert.equal(after.sent, 1);
  assert.equal(again.sent, 0);
  assert.deepEqual(delivered, ['k1']);
});

test('the send path asks for a wake when a drain finds the machine offline, and not when it is online', async (t) => {
  const w = world(t);
  const woke: string[] = [];
  w.config.wake = (id: string) => void woke.push(id);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.equal(woke.length >= 1, true);
  const before = woke.length;
  await w.comeBack();
  await w.service.send('c1', msg('again', UUID(2)), 1);
  assert.equal(woke.length, before);
});

test('with the real timers behind the clock port, the wake waits between looks at the machine', async (t) => {
  const clock = useFakeClock(t, 1_000_000);
  const s = setup();
  await sleeping(s);
  const wake = createCloudWake({ rowOf: () => s.row, adapterOf: () => s.provider });
  const run = wake.wake('relay:h1');
  const settle = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < 4; i++) {
    await settle();
    clock.advance(3000);
    if (s.provider.machines.get('fake-1')?.state === 'starting') s.provider.set('fake-1', 'running');
    if (i === 2) s.row.status = 'online';
  }
  assert.deepEqual(await run, { state: 'online' });
});

test('an adapter that cannot be made (the key was removed) ends the wake as a failure with the reason, never a rejection', async () => {
  const s = setup();
  const wake = createCloudWake({
    rowOf: () => s.row,
    adapterOf: () => {
      throw new Error('Add this provider’s key first.');
    },
    onState: (id: string, st: any) => s.states.push(st),
  });
  assert.deepEqual(await wake.wake('relay:h1'), { state: 'failed', reason: 'Add this provider’s key first.' });
  assert.equal(s.states.at(-1).state, 'failed');
});
