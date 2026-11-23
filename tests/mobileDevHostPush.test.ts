// The dev host's real push path: the relay's push settings come from the environment only, and `run push` sends the same request a Mac makes when a chat needs the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { generateKeyPairSync } from 'node:crypto';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { describePush, pushEnv } from '../scripts/mobile-dev-host/pushEnv.mjs';
import { chatRef } from '../shared/remote/ref.mjs';
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { startPhone, until } from './support/mobileStack.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-push-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('only the relay’s push settings are taken from the environment, and nothing secret is described', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    DATABASE_URL: 'postgres://elsewhere',
    AUTH_PUBLIC_KEY: 'not ours',
    PUSH_MODE: 'direct',
    APNS_KEY_FILE: '/Users/me/mopilot-secrets/AuthKey.p8',
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_TOPIC: 'ai.mopilot.remote',
    APNS_SANDBOX: '1',
    APNS2_KEY_ID: 'KEY456',
    FCM_SERVICE_ACCOUNT_FILE: '',
    PUSH_PROXY_TOKEN: 'secret-token',
  };
  assert.deepEqual(Object.keys(pushEnv(env)).sort(), [
    'APNS2_KEY_ID',
    'APNS_KEY_FILE',
    'APNS_KEY_ID',
    'APNS_SANDBOX',
    'APNS_TEAM_ID',
    'APNS_TOPIC',
    'PUSH_MODE',
    'PUSH_PROXY_TOKEN',
  ]);
  assert.deepEqual(pushEnv({}), {});
  const apns = {
    keyPem: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
    keyId: 'KEY123',
    teamId: 'TEAM123456',
    topic: 'ai.mopilot.remote',
  };
  assert.equal(describePush({ mode: 'none' }), 'push is off (PUSH_MODE=none)');
  assert.equal(describePush({ mode: 'dryrun' }), 'push: dry run (what would be sent is logged, nothing is sent)');
  assert.equal(
    describePush({ mode: 'direct', apns: { ...apns, sandbox: true }, fcm: null }),
    'push: direct, APNs development (sandbox) for ai.mopilot.remote, team TEAM123456, key KEY123',
  );
  assert.equal(
    describePush({ mode: 'direct', apns: { ...apns, sandbox: false }, fcm: { project_id: 'p' } }),
    'push: direct, APNs production for ai.mopilot.remote, team TEAM123456, key KEY123, FCM project p',
  );
  // two iOS apps: one entry per credential set, in the order they are tried
  assert.equal(
    describePush({
      mode: 'direct',
      apns: { ...apns, sandbox: false },
      apnsSets: [
        { ...apns, sandbox: false },
        { ...apns, topic: 'ai.mopilot.phone', teamId: 'TEAM777777', keyId: 'KEY456', sandbox: true },
      ],
      fcm: null,
    }),
    'push: direct, APNs production for ai.mopilot.remote, team TEAM123456, key KEY123, APNs development (sandbox) for ai.mopilot.phone, team TEAM777777, key KEY456',
  );
  assert.equal(
    describePush({ mode: 'proxy', proxyUrl: 'https://push.example', proxyToken: 'secret-token' }),
    'push: via the proxy at https://push.example',
  );
  for (const text of [
    describePush({ mode: 'direct', apns: { ...apns, sandbox: false }, fcm: null }),
    describePush({ mode: 'proxy', proxyUrl: 'u', proxyToken: 'secret-token' }),
  ])
    assert.doesNotMatch(text, /SECRET|secret-token|BEGIN/);
});

function pushRig(
  o: {
    phones?: { id: string; name: string; pairId: string }[];
    titles?: boolean;
    body?: boolean;
    noSealer?: boolean;
    statuses?: Record<string, string>;
    noRelay?: boolean;
  } = {},
) {
  const sent: any[] = [];
  const log: string[] = [];
  const phones = o.phones ?? [{ id: 'd1', name: 'Du’s iPhone', pairId: 'p1' }];
  const bench = { momo: false, brain: false, tasks: true, pushBody: false };
  const controls = createControls({
    bench,
    relayClient: () => (o.noRelay ? null : { state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => phones,
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: (l: string) => void log.push(l),
    pushRequest: async (req: any) => {
      sent.push(req);
      const status = o.statuses?.[req.pair] ?? 'sent';
      if (status === 'throws') throw new Error('The relay is not connected');
      if (status === 'throws-text') throw 'socket closed';
      return status;
    },
    seal: (pair: string, ref: string, title: string) => (o.titles ? `sealed(${pair},${ref},${title})` : null),
    ...(!o.noSealer && { sealBody: (pair: string, ref: string, text: string) => (o.body ? `body(${pair},${ref},${text})` : null) }),
    chatTitle: (id: string) => (id === 'dev-seed-waiting' ? 'Clean up the generated files' : null),
  } as any);
  return { controls, sent, log, bench };
}

test('push sends the Mac’s needs-you request for the waiting chat to each paired phone, with its sealed title when titles are on', async () => {
  const r = pushRig({
    phones: [
      { id: 'd1', name: 'Du’s iPhone', pairId: 'p1' },
      { id: 'd2', name: 'iPad', pairId: 'p2' },
    ],
    statuses: { p2: 'no_token' },
  });
  const text = await r.controls.push('needsYou', 'dev-seed-waiting');
  assert.deepEqual(r.sent, [
    { pair: 'p1', kind: 'needsYou', ref: chatRef('p1', 'dev-seed-waiting') },
    { pair: 'p2', kind: 'needsYou', ref: chatRef('p2', 'dev-seed-waiting') },
  ]);
  assert.equal(text, 'needsYou for “Clean up the generated files”: Du’s iPhone sent, iPad no_token');
  assert.ok(r.log.includes('bench: push needsYou for dev-seed-waiting: Du’s iPhone sent, iPad no_token'));
  const sealed = pushRig({ titles: true });
  await sealed.controls.push('done', 'dev-seed-waiting');
  assert.equal(sealed.sent[0].sealed, `sealed(p1,${chatRef('p1', 'dev-seed-waiting')},Clean up the generated files)`);
  assert.equal(sealed.sent[0].kind, 'done');
  assert.equal('sealed' in r.sent[0], false, 'no sealed title unless the phone turned titles on');
});

test('a MoMo needs-you push for a channel’s card carries the channel’s handle as ref and the card’s as card, and never a sealed title', async () => {
  const r = pushRig({ titles: true });
  await r.controls.push('momoNeedsYou', 'dev-seed-waiting', undefined, 'ch_0000000000000001', 'k1');
  assert.deepEqual(r.sent, [{ pair: 'p1', kind: 'momoNeedsYou', ref: chatRef('p1', 'ch_0000000000000001'), card: chatRef('p1', 'k1') }]);
  // without a channel or a card it is the chat's handle, as before
  const plain = pushRig();
  await plain.controls.push('momoNeedsYou', 'dev-seed-waiting');
  assert.deepEqual(plain.sent, [{ pair: 'p1', kind: 'momoNeedsYou', ref: chatRef('p1', 'dev-seed-waiting') }]);
});

test('push says why it cannot: an unknown kind or chat, no phone, a relay that is down or refuses', async () => {
  const r = pushRig();
  await assert.rejects(r.controls.push('urgent', 'dev-seed-waiting'), /kind must be one of needsYou, done, momoNeedsYou, machineOffline/);
  await assert.rejects(r.controls.push('needsYou', 'nope'), /No chat nope/);
  await assert.rejects(pushRig({ phones: [] }).controls.push('needsYou', 'dev-seed-waiting'), /No phone is paired\./);
  await assert.rejects(pushRig({ noRelay: true }).controls.push('needsYou', 'dev-seed-waiting'), /Mobile Remote is not running/);
  // one phone failing does not hide how the others fared
  const mixed = pushRig({
    phones: [
      { id: 'd1', name: 'One', pairId: 'p1' },
      { id: 'd2', name: 'Two', pairId: 'p2' },
    ],
    statuses: { p1: 'throws' },
  });
  const text = pushRig({ statuses: { p1: 'throws-text' } });
  assert.match(await text.controls.push('needsYou', 'dev-seed-waiting'), /Du’s iPhone failed \(socket closed\)/);
  assert.equal(
    await mixed.controls.push('needsYou', 'dev-seed-waiting'),
    'needsYou for “Clean up the generated files”: One failed (The relay is not connected), Two sent',
  );
});

test('run push [kind] [chat] goes to the control, with the waiting chat and needsYou by default', async () => {
  const calls: any[] = [];
  const app = createFakeApp({ repo: '/repo', now: () => 9_000_000, sleep: async () => undefined, status: async () => '' });
  const scenarios = createScenarios({
    app,
    now: () => 9_000_000,
    controls: { push: async (...a: any[]) => (calls.push(a), 'sent') } as any,
  });
  assert.equal(await scenarios.run('push', []), 'sent');
  assert.equal(await scenarios.run('push', ['done', 'dev-seed-readme']), 'sent');
  assert.equal(await scenarios.run('push', ['momoNeedsYou', 'dev-seed-waiting', 'Morning', 'brief']), 'sent');
  assert.equal(await scenarios.run('push', ['momoNeedsYou', 'dev-seed-waiting', 'channel=ch_1', 'card=k1', 'Morning', 'brief']), 'sent');
  assert.deepEqual(calls, [
    ['needsYou', 'dev-seed-waiting', undefined, undefined, undefined],
    ['done', 'dev-seed-readme', undefined, undefined, undefined],
    ['momoNeedsYou', 'dev-seed-waiting', 'Morning brief', undefined, undefined],
    ['momoNeedsYou', 'dev-seed-waiting', 'Morning brief', 'ch_1', 'k1'],
  ]);
});

// a throwaway P-256 key: the host builds the real sender, which parses it
const PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
  .replace(/\n$/, '');
const PEM_BODY = PEM.split('\n')[1];
async function hostWith(env: Record<string, string>, name: string, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const host = await startHost({
    dir: path.join(scratch, name),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: (l: string) => lines.push(l),
    sleep: async () => undefined,
    env,
    ...extra,
  });
  after(() => host.stop());
  return { host, lines };
}

test('the host’s relay takes its push settings from the environment and says how it will push, without printing a key', async () => {
  const quiet = await hostWith({}, 'none');
  assert.ok(quiet.lines.some((l) => l.includes('relay: push is off (PUSH_MODE=none)')));
  const direct = await hostWith(
    {
      PUSH_MODE: 'direct',
      APNS_KEY: PEM,
      APNS_KEY_ID: 'KEY123',
      APNS_TEAM_ID: 'TEAM123456',
      APNS_TOPIC: 'ai.mopilot.remote',
      APNS_SANDBOX: '1',
    },
    'direct',
  );
  assert.ok(
    direct.lines.some((l) =>
      l.includes('relay: push: direct, APNs development (sandbox) for ai.mopilot.remote, team TEAM123456, key KEY123'),
    ),
  );
  assert.equal(
    direct.lines.some((l) => l.includes(PEM_BODY)),
    false,
  );
});

test('with push on, the relay really sends: a phone that registered a token is pushed to when `run push` asks (a dry run sends nothing but logs the payload)', async () => {
  const { host, lines } = await hostWith({ PUSH_MODE: 'dryrun' }, 'dryrun');
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Push phone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await phone.runtime.pushRegister('apns', 'device-token-1');
  const text = await host.scenarios.run('push');
  assert.match(text, /^needsYou for “Clean up the generated files”: Push phone sent$/);
  assert.ok(
    lines.some((l) => l.includes('relay: push_dry_run') && l.includes('"kind":"needsYou"')),
    'the relay built a needs-you push',
  );
  assert.equal(
    lines.some((l) => l.includes('device-token-1')),
    false,
    'and no token is logged',
  );
});

test('stopping the host closes the connection its APNs sender opened, so the process can exit', async () => {
  const server = http2.createServer((_req, res) => {
    res.writeHead(200, { 'apns-id': 'test' });
    res.end();
  });
  const closed = new Promise<void>((resolve) => server.on('session', (s) => s.on('close', resolve)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  const { host } = await hostWith(
    { PUSH_MODE: 'direct', APNS_KEY: PEM, APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123456', APNS_TOPIC: 'ai.mopilot.remote' },
    'h2',
    { pushConnect: () => http2.connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`) },
  );
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'H2 phone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await phone.runtime.pushRegister('apns', 'device-token-2');
  assert.match(await host.scenarios.run('push'), /: H2 phone sent$/);
  await host.stop();
  await closed;
});

test('`run titles on` makes the Mac seal each push’s title for the phone, and `off` goes back to the fixed text', async () => {
  const { host, lines } = await hostWith({ PUSH_MODE: 'dryrun' }, 'titles');
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Titles phone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await phone.runtime.pushRegister('apns', 'device-token-3');
  // each push is for a chat of its own: the same kind for the same chat goes out once per window
  const bytes = async (chat: string, kind = 'needsYou') => {
    const before = lines.length;
    await host.scenarios.run('push', [kind, chat]);
    const sent = lines.slice(before).find((l) => l.includes('relay: push_dry_run')) ?? '';
    return Number(/"bytes":(\d+)/.exec(sent)?.[1]);
  };
  const plain = await bytes('dev-seed-waiting');
  assert.match(await host.scenarios.run('titles', ['on']), /^chat titles in push are on/);
  // a different kind, so it neither merges with the first nor is held back by it
  const sealed = await bytes('dev-seed-login', 'done');
  assert.ok(sealed > plain, 'a sealed title makes the payload bigger');
  assert.equal(await host.scenarios.run('titles', ['off']), 'chat titles in push are off');
  // the second "needs you" within a minute merges to "(2)" with nothing of the chat in it: far smaller than a sealed one, and only a few bytes over the first
  const merged = await bytes('dev-seed-readme');
  assert.ok(merged < sealed && merged - plain < 40, 'with titles off nothing is sealed');
  // MoMo's push body (A6): off, nothing to print; on, the phone is handed its key and the printed body carries the sealed blob only
  const printed = () => host.scenarios.run('push-payload', ['momoNeedsYou', 'dev-seed-waiting', 'a7', 'Morning', 'brief']);
  await assert.rejects(async () => printed(), /No body/);
  assert.match(await host.scenarios.run('push-body', ['on']), /^MoMo's push body is on/);
  const body = JSON.parse(await printed());
  assert.equal(body.aps.alert.body, '');
  assert.ok(typeof body.sb === 'string' && body.sb.length > 100 && !JSON.stringify(body).includes('Morning'));
  assert.match(await host.scenarios.run('push-body', ['off']), /^MoMo's push body is off/);
  await assert.rejects(async () => printed(), /No body/);
});

test('push-payload prints the APNs body the relay would send the first paired phone, with MoMo’s card when one is named', () => {
  const r = pushRig({
    phones: [
      { id: 'd1', name: 'Du’s iPhone', pairId: 'p1' },
      { id: 'd2', name: 'iPad', pairId: 'p2' },
    ],
  });
  const plain = JSON.parse(r.controls.pushPayload('needsYou', 'dev-seed-waiting', undefined));
  assert.deepEqual(plain, {
    aps: {
      category: 'mopilot.needsYou',
      alert: { title: 'A chat needs you', body: '' },
      sound: 'default',
      'interruption-level': 'time-sensitive',
      'thread-id': chatRef('p1', 'dev-seed-waiting'),
    },
    kind: 'needsYou',
    ref: chatRef('p1', 'dev-seed-waiting'),
  });
  const momo = JSON.parse(r.controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', 'a7'));
  assert.equal(momo.card, chatRef('p1', 'a7'));
  assert.equal(momo.aps.alert.title, 'MoMo needs you');
  assert.throws(() => r.controls.pushPayload('urgent', 'dev-seed-waiting', undefined), /kind must be one of/);
  assert.equal('sb' in momo, false);
  assert.throws(() => r.controls.pushPayload('needsYou', 'nope', undefined), /No chat nope/);
  assert.throws(() => pushRig({ phones: [] }).controls.pushPayload('needsYou', 'dev-seed-waiting', undefined), /No phone is paired\./);
});

test('push-body switches the opt-in, and push-payload with a routine name prints the sealed body only for MoMo once it is on', () => {
  const r = pushRig({ body: true });
  assert.equal(r.bench.pushBody, false);
  // off: no body, and the print says why
  assert.throws(() => r.controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', 'a7', 'Morning brief'), /No body/);
  assert.match(r.controls.pushBody(true), /on: once the phone has its key/);
  assert.equal(r.bench.pushBody, true);
  const ref = chatRef('p1', 'dev-seed-waiting');
  const withBody = JSON.parse(r.controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', 'a7', '  Morning\u0007brief '));
  assert.equal(withBody.sb, `body(p1,${ref},Morning brief)`);
  assert.equal(withBody.aps['mutable-content'], 1);
  assert.equal(withBody.aps.alert.body, '', 'the visible body stays empty');
  // only MoMo's "needs you" has one, and a name that shapes to nothing has none
  assert.throws(() => r.controls.pushPayload('needsYou', 'dev-seed-waiting', undefined, 'Morning brief'), /No body/);
  assert.throws(() => r.controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', undefined, '\u0007'), /No body/);
  assert.match(r.controls.pushBody(false), /off$/);
  assert.equal(r.bench.pushBody, false);
  // a phone without its key yet gets none
  assert.throws(() => pushRig().controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', undefined, 'Morning brief'), /No body/);
});

test('without a sealer the host has none to give: turning the opt-in on is told and a body is refused', () => {
  const r = pushRig({ noSealer: true });
  assert.match(r.controls.pushBody(true), /on/);
  assert.throws(() => r.controls.pushPayload('momoNeedsYou', 'dev-seed-waiting', undefined, 'Morning brief'), /No body/);
});

test('push momoNeedsYou with a routine name sends MoMo’s sealed body to every phone, once the opt-in is on; nothing goes out half sent', async () => {
  const r = pushRig({
    body: true,
    phones: [
      { id: 'd1', name: 'Du’s iPhone', pairId: 'p1' },
      { id: 'd2', name: 'iPad', pairId: 'p2' },
    ],
  });
  // off: refused before anything is sent
  await assert.rejects(r.controls.push('momoNeedsYou', 'dev-seed-waiting', 'Morning brief'), /No body/);
  assert.equal(r.sent.length, 0);
  r.controls.pushBody(true);
  const said = await r.controls.push('momoNeedsYou', 'dev-seed-waiting', ' Morning\u0007brief ');
  assert.match(said, /Du’s iPhone sent, iPad sent/);
  assert.deepEqual(
    r.sent.map((q: any) => [q.pair, q.kind, q.sealedBody]),
    [
      ['p1', 'momoNeedsYou', `body(p1,${chatRef('p1', 'dev-seed-waiting')},Morning brief)`],
      ['p2', 'momoNeedsYou', `body(p2,${chatRef('p2', 'dev-seed-waiting')},Morning brief)`],
    ],
  );
  // only a MoMo "needs you" has one, and without a name the request is as it always was
  r.sent.length = 0;
  await assert.rejects(r.controls.push('needsYou', 'dev-seed-waiting', 'Morning brief'), /No body/);
  await r.controls.push('momoNeedsYou', 'dev-seed-waiting');
  assert.equal(r.sent.length, 2);
  assert.ok(r.sent.every((q: any) => !('sealedBody' in q)));
});
