// run s3 and its wait for a card (scripts/mobile-dev-host): the assisted Host-card run for the person holding the phone, and the real Host's wait until a card is answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeKit } from './support/fakeRealHostKit.ts';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeHosts } from '../scripts/mobile-dev-host/fakeHosts.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { startRealHost } from '../scripts/mobile-dev-host/realHost.mjs';
import { createPhoneEnroll } from '../scripts/mobile-dev-host/realHostKit.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'real-host-'));
const start = (k: any, log: string[] = [], more: object = {}) =>
  startRealHost({
    vm: 'mopilot-bench',
    dir: scratch(),
    log: (l: string) => void log.push(l),
    kit: k,
    createPhoneEnroll,
    relayPort: 8787,
    now: () => 77,
    wait: async () => undefined,
    ...more,
  });

test('waitCardGone reads the Host once a poll until the chat has no card left, or the limit passes', async () => {
  const card = { chatId: 'c1', epoch: 1, requestId: 'r1', options: [{ optionId: 'o', kind: 'allow' }] };
  const pending = [card, { ...card, chatId: 'c2' }];
  const f = fakeKit({ pending });
  let t = 0;
  // the answer lands while the run waits between two polls
  const real = await start(f.k, [], {
    now: () => (t += 100),
    wait: async () => {
      pending.splice(0, 1);
    },
  });
  const seen = await real.waitCardGone('c1', 120_000);
  assert.equal(seen.gone, true);
  assert.ok(seen.ms > 0, 'the time it took');
  assert.equal(f.hostCalls.filter((c) => c[0] === 'host.pending').length, 2, 'one poll before the answer, one after');
  assert.equal(f.hostCalls.at(-1)?.[0], 'close', 'one connection for the whole wait, closed at the end');
  // nobody answers c2 within the limit
  const stuck = await start(fakeKit({ pending: [{ ...card, chatId: 'c2' }] }).k, [], {
    now: () => (t += 100),
    wait: async () => undefined,
  });
  assert.deepEqual((await stuck.waitCardGone('c2', 150)).gone, false);
  assert.equal((await stuck.waitCardGone('c9')).gone, true, 'a chat with no card is already answered');
});

test('the assisted s3 run raises one card, gives the cue, and reports what the Host saw; elsewhere answers on this side after the pause', async () => {
  const lines: string[] = [];
  const waited: number[] = [];
  const answers: string[] = [];
  const base = {
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: (ms: number, fn: () => void) => (waited.push(ms), fn()),
    log: (l: string) => void lines.push(l),
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  };
  const results = [
    { gone: true, ms: 4200 },
    { gone: false, ms: 120_000 },
  ];
  const c = createControls({
    ...base,
    hosts: {
      toggle: () => true,
      changed: () => undefined,
      direct: async () => undefined,
      card: async (text: string) => (answers.push(text), 'acp:fake:cardS'),
      waitCard: async () => results.shift(),
      answer: async (kind: string) => (answers.push(kind), 1),
    },
  } as any);
  assert.match(await c.s3('allow'), /answered 4\.2 s after the wait began/);
  assert.match(lines[0], /s3 allow: card raised in acp:fake:cardS\. ASK THE OWNER: Lock the phone\..*Allow and unlock with Face ID/);
  assert.match(await c.s3('deny'), /nobody answered within 120 s; ask what the phone showed .* without deny/);
  assert.match(lines[1], /tap Deny/);
  assert.match(await c.s3('elsewhere'), /this side answered 1 card at \+20 s/);
  assert.deepEqual(waited, [20_000], 'only elsewhere pauses, for 20 s');
  assert.deepEqual(answers, ['PERMIT s3-allow', 'PERMIT s3-deny', 'PERMIT s3-elsewhere', 'allow']);
  assert.match(lines[2], /does it clear, or say it was answered elsewhere/);
  await assert.rejects(() => c.s3('maybe' as any), /Say allow, deny or elsewhere/);
  await assert.rejects(() => createControls(base as any).s3('allow'), /--real-host/);
});

test('the assisted s3 run asks nobody until a push can leave: the Host must be linked to the relay', async () => {
  const lines: string[] = [];
  let link = { hostLinked: false };
  const raised: string[] = [];
  const c = createControls({
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: (_ms: number, fn: () => void) => fn(),
    log: (l: string) => void lines.push(l),
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
    linkState: () => link,
    hosts: {
      toggle: () => true,
      changed: () => undefined,
      direct: async () => undefined,
      card: async (text: string) => (raised.push(text), 'acp:fake:cardP'),
      waitCard: async () => ({ gone: true, ms: 1000 }),
      answer: async () => 1,
    },
  } as any);
  assert.match(await c.s3('allow'), /NOT STARTED, nobody was asked\. The Host is not linked to the relay/);
  assert.deepEqual(raised, [], 'no card was raised while the rig could not push');
  assert.ok(!lines.some((l) => l.includes('ASK THE OWNER')), 'nobody was asked');
  link = { hostLinked: true };
  assert.match(await c.s3('allow'), /answered 1\.0 s/);
  assert.ok(lines.some((l) => l.includes('ASK THE OWNER')));
  assert.deepEqual(raised, ['PERMIT s3-allow']);
});

test('the made-up machines wait for one card only when a real Host is among them', async () => {
  const real = await start(fakeKit().k);
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const hosts = createFakeHosts({ app, log: () => undefined, now: () => 1, real });
  const chat = await hosts.hostCard('PERMIT w');
  assert.equal((await hosts.hostWaitCard(chat, 0)).gone, true, 'the Host holds no card for the chat, so it reads as answered');
  const plain = createFakeHosts({ app, log: () => undefined, now: () => 1 });
  assert.throws(() => plain.hostWaitCard('x', 1), /--real-host/);
});
