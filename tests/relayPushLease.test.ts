// The relay forwards the MoMo home's lease unread (relay/src/control.mjs, push.mjs, pushPayload.mjs): the stamp is sealed for the phone, so the relay keeps no state about it, suppresses nothing, logs nothing, ignores it on other kinds and refuses a malformed one only on a MoMo push.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClock, paired as pairedOn, P } from './support/relayKit.ts';
import { PushService } from '../relay/src/push.mjs';
import { Store } from '../relay/src/store.mjs';
import { apnsBody, fcmMessage, MAX_SEALED_STAMP } from '../relay/src/pushPayload.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);

test('a sealed stamp reaches the provider as it came, on a push and on its clearing', async () => {
  const r = await pairedOn(db);
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'chat-1', sealedStamp: 'STAMP-9', rid: 'a' });
  assert.equal(r.mac.socket.last().status, 'sent');
  assert.equal(r.pushed[0].sealedStamp, 'STAMP-9');
  // a clearing carries it too; a push with none (an older Host) is as before
  await r.mac.say({ t: 'push', pair: P, kind: 'cleared', ref: 'chat-1', sealedStamp: 'STAMP-9', rid: 'c' });
  await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'chat-3', rid: 'd' });
  assert.equal('sealedStamp' in r.pushed.at(-1), false);
});

test('a malformed sealed stamp on a MoMo push is refused; on any other kind it is ignored and the push goes', async () => {
  const r = await pairedOn(db);
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  for (const bad of [
    { sealedStamp: '' },
    { sealedStamp: 3 },
    { sealedStamp: 'x'.repeat(MAX_SEALED_STAMP + 1) },
    { sealedStamp: 'ab!' },
    { sealedStamp: 'a.b' },
    { sealedStamp: 'a b' },
    { sealedStamp: 'a+/=' },
  ]) {
    await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'c', ...bad });
    assert.equal(r.mac.socket.last().code, 'bad_message', JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(r.pushed.length, 0);
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'c2', sealedStamp: 3, rid: 'e' });
  assert.equal(r.mac.socket.last().status, 'sent');
  assert.equal('sealedStamp' in r.pushed[0], false, 'another kind never carries it');
});

test('only an unmerged MoMo push carries the sealed stamp, and the push log never holds it', async () => {
  const store = new Store(db as any);
  const clock = makeClock();
  const sent: any[] = [];
  const logs: any[] = [];
  const push = new PushService({
    store,
    send: async (m: any) => (sent.push(m), { ok: true }),
    now: clock.now,
    log: (...a: any[]) => logs.push(a),
  });
  const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  await push.request(pair, 'needsYou', 'a', '', '', false, '', 'S0');
  assert.equal('sealedStamp' in sent[0], false);
  clock.advance(120_000);
  await push.request(pair, 'momoNeedsYou', 'm', '', '', false, '', 'S1');
  assert.equal(sent[1].sealedStamp, 'S1');
  clock.advance(120_000);
  // whatever order stamps arrive in, each is forwarded: the phone, not the relay, decides which is old
  await push.request(pair, 'momoNeedsYou', 'm1b', '', '', false, '', 'S1-older');
  assert.equal(sent[2].sealedStamp, 'S1-older');
  clock.advance(1000);
  // a second MoMo chat within the merge window: "(2)" stands for both, so no one stamp
  await push.request(pair, 'momoNeedsYou', 'm2', '', '', false, '', 'S2');
  assert.equal(sent[3].count, 2);
  assert.equal('sealedStamp' in sent[3], false);
  assert.doesNotMatch(JSON.stringify(logs), /S0|S1|S2|older/);
});

test('the APNs body and the FCM message carry the sealed stamp as `ss`, and the proxy body hands it on', async () => {
  const m = {
    platform: 'apns',
    token: 't',
    kind: 'momoNeedsYou',
    title: 'MoMo needs you',
    count: 1,
    collapseId: 'c',
    ref: 'r',
    sealedStamp: 'SS',
  } as any;
  assert.equal((apnsBody(m) as any).ss, 'SS');
  assert.equal((fcmMessage({ ...m, platform: 'fcm' }) as any).data.ss, 'SS');
  assert.equal('ss' in (apnsBody({ ...m, sealedStamp: undefined }) as any), false);
  assert.equal('ss' in (fcmMessage({ ...m, platform: 'fcm', sealedStamp: undefined }) as any).data, false);
  const { proxySender } = await import('../relay/src/push.mjs');
  const bodies: any[] = [];
  const send = proxySender({
    url: 'http://proxy',
    fetch: (async (_u: string, o: any) => (
      bodies.push(JSON.parse(o.body)), { ok: true, status: 200, headers: { get: () => null } }
    )) as any,
  });
  await send(m);
  assert.equal(bodies[0].sealedStamp, 'SS');
});

// What this proves and what it does not: the canary below is pushed through every path the relay has for a stamp (sent, refused, ignored, merged, provider failure, provider crash, dead token) and must appear in no captured log, console line or metric. That is a behavioural check of what those paths emit today. The text scan in momoPushBody.invariant.test.ts only sees lines that name `sealedStamp`, so a whole-message log (console.log(m), JSON.stringify(m), {...m}) would slip past it; this test catches such a log on these paths only, not on one no test reaches.
test('a canary stamp pushed through every relay path appears in no log, console line or metric', async () => {
  const CANARY = 'CANARYstamp-9f3a_QQ';
  const out: string[] = [];
  const spied = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = spied.map((k) => console[k]);
  for (const k of spied) console[k] = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  try {
    let mode: 'ok' | 'fail' | 'crash' | 'dead' = 'ok';
    const r = await pairedOn(db, {
      send: async (m: any) => {
        r.pushed.push(m);
        if (mode === 'crash') throw new Error('provider down');
        if (mode === 'dead') return { ok: false, invalidToken: true, status: 410 };
        return mode === 'fail' ? { ok: false, status: 500, reason: 'Boom' } : { ok: true };
      },
    });
    (r.push as any).log = (...a: unknown[]) => void out.push(JSON.stringify(a));
    await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
    const go = async (extra: object, rid: string) =>
      r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: `c-${rid}`, rid, ...extra });
    await go({ sealedStamp: CANARY }, '1'); // sent
    await go({ sealedStamp: CANARY }, '2'); // merged with the one before
    await r.mac.say({ t: 'push', pair: P, kind: 'cleared', ref: 'c-1', sealedStamp: CANARY, rid: '3' });
    await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'c-4', sealedStamp: CANARY, rid: '4' }); // ignored on another kind
    await go({ sealedStamp: CANARY + '!' }, '5'); // refused: charset
    await go({ sealedStamp: CANARY + 'x'.repeat(MAX_SEALED_STAMP) }, '6'); // refused: size
    await r.mac.say({ t: 'push', pair: 'p_nobody0001', kind: 'momoNeedsYou', ref: 'c-7', sealedStamp: CANARY, rid: '7' }); // unknown pair
    mode = 'fail';
    r.clock.advance(300_000);
    await go({ sealedStamp: CANARY }, '8'); // the provider refused it
    mode = 'crash';
    r.clock.advance(300_000);
    await go({ sealedStamp: CANARY }, '9'); // the provider broke
    mode = 'dead';
    r.clock.advance(300_000);
    await go({ sealedStamp: CANARY }, '10'); // the token is dead
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(
      r.pushed.some((m: any) => m.sealedStamp === CANARY),
      'the canary did travel the path under test',
    );
    const seen = [out.join('\n'), JSON.stringify(r.logs), (r.push as any).metrics.render(), (r.hub as any).metrics?.render?.() ?? ''].join(
      '\n',
    );
    assert.ok(!seen.includes('CANARY') && !seen.includes('stamp-9f3a'), 'no log, console line or metric holds the stamp');
  } finally {
    spied.forEach((k, i) => (console[k] = saved[i] as never));
  }
});
