// The dev host with a real Host in a machine (scripts/mobile-dev-host/realHost.mjs, --real-host) and a phone runtime over the real relay: the Mac's switch, the enrollment the phone asks the Mac for, and the phone's own enrollment through the Host lane (`?as=hostlink`).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { fakeKit, key } from './support/fakeRealHostKit.ts';
import { startRealHost } from '../scripts/mobile-dev-host/realHost.mjs';
import { createPhoneEnroll } from '../scripts/mobile-dev-host/realHostKit.mjs';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-real-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const lines: string[] = [];
const open = async (dir: string, o: object = {}) => {
  const host = await startHost({
    dir,
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: (l: string) => lines.push(l),
    sleep: async () => undefined,
    ...o,
  });
  after(() => host.stop());
  return host;
};
/** The phone harness signs in with tokens of the host's own account key. */
const relayOf = (host: any) =>
  ({
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  }) as any;

test('--real-host: a phone enrolls with the real Host through the Mac’s courier, the Host sees the relay on its own loopback, the log keeps the credential out, and "direct on" is the Mac’s switch', async () => {
  const f = fakeKit();
  const dir = path.join(scratch, 'real-host');
  const real = await startRealHost({
    vm: 'mopilot-bench',
    dir,
    log: () => undefined,
    kit: f.k,
    createPhoneEnroll,
    relayPort: 8787,
    now: () => 1000,
  });
  const host = await open(dir, { realHost: real });
  assert.equal(host.service.host().rows()[0].id, 'ssh:mopilot-bench');
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  assert.match(await host.scenarios.run('direct', ['on']), /direct access is on for Test iPhone/);
  assert.equal((await phone.ask('machines.list')).direct['ssh:mopilot-bench'], 'offered');
  const secret = 's'.repeat(43);
  const lan = { hostId: 'h_phone0000000000000001', secret, pairId: 'p_phone00001', relayUrl: 'ws://192.168.86.204:8787/v1/ws' };
  const answer = await phone.ask('machines.enroll', {
    hostId: 'ssh:mopilot-bench',
    relay: lan,
    appPub: key('A'),
    appEphPub: key('B'),
    edPub: key('C'),
    name: 'Pocket iPhone',
  });
  assert.equal(answer.hostKey, 'hostkey1');
  assert.equal(f.hostCalls.find((c) => c[0] === 'host.relayEnroll')![1].relayUrl, 'ws://127.0.0.1:8787/v1/ws');
  assert.ok(
    lines.some((l) => l.includes('machines.enroll')),
    'the request is logged',
  );
  assert.ok(!lines.some((l) => l.includes(secret)), 'the relay credential never reaches the log');
  assert.equal((await phone.ask('machines.list')).direct['ssh:mopilot-bench'], 'on');
  assert.match(await host.scenarios.run('direct', ['off']), /direct access is off/);
  // the Host in the machine is the command line's to take away, not the dev host's
  await real.stop();
  assert.deepEqual(f.calls.at(-1), ['cleanup']);
});

test('the phone’s own enrollment (the runtime’s direct paths) goes through the Host lane and the Mac’s courier to the real Host, and reads it', async () => {
  const f = fakeKit();
  const dir = path.join(scratch, 'direct-setup');
  const real = await startRealHost({
    vm: 'mopilot-bench',
    dir,
    log: () => undefined,
    kit: f.k,
    createPhoneEnroll,
    relayPort: 8787,
    now: () => 1000,
  });
  const host = await open(dir, { realHost: real });
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('direct', ['on']);
  assert.match(await host.scenarios.run('host-card'), /the Host raised a card in acp:fake:card/);
  assert.equal(await host.scenarios.run('host-answer', ['allow']), 'the Host has no card waiting');
  // the fake relay has no Host connection: the run refuses to ask anybody
  assert.match(await host.scenarios.run('s3', ['allow']), /^s3 allow: NOT STARTED, nobody was asked\. The Host is not linked to the relay/);
  assert.match(await host.scenarios.run('host-chat', ['fake', 'PERMIT hi']), /^the Host started fake chat acp:fake:chat/);
  assert.match(await host.scenarios.run('host-status'), /^the Host's agents: fake:installed\/in/);
  const { phones } = phone.runtime.direct!;
  await phones.setUp('ssh:mopilot-bench');
  assert.equal(phones.setupState('ssh:mopilot-bench'), 'idle', 'the set-up finished');
  assert.equal(phones.enrolled('ssh:mopilot-bench'), true);
  const relayCall = f.hostCalls.find((c) => c[0] === 'host.relayEnroll')![1];
  assert.equal(relayCall.relayUrl, 'ws://127.0.0.1:8787/v1/ws', 'the Host is given its own address for the relay');
  assert.equal((await phones.forget('ssh:mopilot-bench')).complete, true);
  assert.equal(phones.enrolled('ssh:mopilot-bench'), false);
});
