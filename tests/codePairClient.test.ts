// Pairing a Mac by a code, the controlling side (R2b of #5576, electron/host/codePairClient.cjs): against the relay's own server in this process, with the controlled Mac's responder driven over the same HTTP. A run that works adds the machine and keeps the relay credential it sealed in m3; every other ending revokes that credential, closes the offer and says its cause with the fix in place; a code that has had its runs is refused before the relay is asked anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { formatCode } from '../shared/host/codePair.mjs';
import { waitFor } from './support/waitFor.ts';
import { controlled, fakeStore, hostIdOf, keys, rig, serve } from './support/codePairRig.ts';

test('a run that works: the machine is added and its relay credential, sealed in m3, is the one kept; it was on the revoke list before the relay had it', async () => {
  const r = await serve();
  const host = await controlled(r);
  const t = rig(r);
  const res = await t.client.addByCode(host.code.toLowerCase().replace('-', ' '));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.name, 'Studio');
  assert.ok(res.safety);
  const hostId = hostIdOf(t.log);
  assert.match(hostId, /^h_/);
  assert.deepEqual(
    t.log,
    ['open', `intend:${hostId}`, `register:${hostId}`, `settle:${hostId}`],
    'on the revoke list first, kept at the end, never revoked',
  );
  assert.equal(t.adopted.length, 1);
  assert.deepEqual(t.adopted[0].o, { rotate: false });
  assert.equal(t.adopted[0].d, `relay:${hostId}`);
  assert.equal(t.adopted[0].e.hostId, hostId);
  assert.equal(t.adopted[0].e.relayUrl, r.wsUrl);
  // what the controlled Mac read in m3 is the credential this app registered, and the root both ends derived is the one adopted
  assert.deepEqual(
    { ...host.seen.relay, secret: '', appPub: '', appEphPub: '' },
    { relayUrl: r.wsUrl, hostId, pairId: t.adopted[0].e.pairId, secret: '', appPub: '', appEphPub: '' },
  );
  assert.match(host.seen.relay.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.adopted[0].e.root, Buffer.from(host.seen.root!).toString('base64'));
  assert.equal(host.seen.safety, res.safety);
  assert.equal(t.machines.length, 1);
  assert.equal(t.machines[0].id, `relay:${hostId}`);
  assert.equal(t.machines[0].name, 'Studio');
  host.stop();
});

test('progress: the words to compare are shown once the code has proved itself, then that the other Mac is asked', async () => {
  const r = await serve();
  const host = await controlled(r);
  const events: any[] = [];
  const t = rig(r, { onProgress: (e: any) => events.push(e) });
  assert.equal((await t.client.addByCode(host.code)).ok, true);
  assert.deepEqual(
    events.map((e) => e.state),
    ['safety', 'waiting'],
  );
  assert.equal(events[0].safety, host.seen.safety);
  host.stop();
});

test('a code that is no code, the service being off, and the relay being absent each end at once, with nothing counted or made', async () => {
  const r = await serve();
  const t = rig(r);
  for (const typed of ['', 'ABC', 'ABCD-EFG1', 'ABCD-EFGH-J', 42]) {
    const res = await t.client.addByCode(typed as any);
    assert.equal(res.code, 'bad_code');
    assert.equal(res.cause, "That code didn't work. Check it on the other Mac, or get a new one.");
  }
  assert.deepEqual(t.log, []);
  assert.equal(t.store.value, undefined, 'a typo burns nothing');
  const flagOff = rig(r, { enabled: () => false });
  assert.deepEqual(await flagOff.client.addByCode('ABCD-EFGH'), {
    ok: false,
    code: 'off',
    cause: "Pairing by code isn't available yet.",
    fix: null,
  });
  const noRelay = rig(r, { relayUrl: () => null });
  assert.equal((await noRelay.client.addByCode('ABCD-EFGH')).code, 'off');
  // a relay that does not serve the rendezvous: its claim route is unknown (404 on a GET), which is "isn't available yet"
  const off = await serve({});
  const offRig = rig(off);
  assert.equal((await offRig.client.addByCode('ABCD-EFGH')).code, 'off');
  assert.equal(offRig.store.value, undefined, 'the service being off burns nothing');
  assert.equal(offRig.log.length, 0);
});

test('an unknown, used or wrong code all read the same; a wrong secret burns a run of that code until it is spent, and a spent code is refused before the relay is asked', async () => {
  const r = await serve();
  assert.equal((await rig(r).client.addByCode('ZZZZ-ZZZZ')).code, 'bad_code');
  const host = await controlled(r);
  const wrong = formatCode(host.hint, host.secret === 'AAAAA' ? 'BBBBB' : 'AAAAA');
  const key = crypto.createHash('sha256').update(wrong.replace('-', '')).digest('hex');
  // two runs of this typed code already happened (before a restart, say): the third is the last
  const store = fakeStore({ v: 1, floor: 0, codes: { [key]: { started: 2, spent: false, at: Date.now() } } });
  const t = rig(r, { store });
  const third = await t.client.addByCode(wrong);
  assert.equal(third.code, 'bad_code');
  assert.equal(third.cause, "That code didn't work. Check it on the other Mac, or get a new one.");
  assert.equal(t.log.length, 0, 'nothing was minted before the code proved itself');
  // the same offer cannot be claimed again, and the code has had its runs either way
  const calls: string[] = [];
  const watching = rig(r, { store, fetch: ((u: any, i: any) => (calls.push(String(u)), fetch(u, i))) as typeof fetch });
  const spent = await watching.client.addByCode(wrong);
  host.stop();
  assert.equal(spent.code, 'spent');
  assert.equal(spent.cause, 'This code can’t be used again. Get a new one from the other Mac.');
  assert.deepEqual(spent.fix, { id: 'enter_code', label: 'Enter another code' });
  assert.deepEqual(calls, [], 'the relay was not asked');
});

test('the other Mac says no: the credential is revoked, the offer is closed, and the cause names it', async () => {
  const r = await serve();
  const host = await controlled(r, 'deny');
  const t = rig(r);
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'denied');
  assert.equal(res.cause, "The other Mac didn't allow it.");
  const hostId = hostIdOf(t.log);
  assert.deepEqual(t.log, ['open', `intend:${hostId}`, `register:${hostId}`, `revoke:${hostId}`]);
  assert.equal(t.machines.length + t.adopted.length, 0);
  // the code was spent by the run, so typing it again is refused without asking the relay
  assert.equal((await t.client.addByCode(host.code)).code, 'spent');
});

test('the other Mac does not answer in two minutes (here, a moment): it is a timeout, the credential is revoked, and the code cannot be run again', async () => {
  const r = await serve();
  const host = await controlled(r, 'silent');
  const t = rig(r);
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'timeout');
  assert.equal(res.cause, "The other Mac didn't answer in time. Ask it to try again.");
  assert.ok(t.log.includes(`revoke:${hostIdOf(t.log)}`));
  assert.equal((await t.client.addByCode(host.code)).code, 'spent');
});

test('no reply to the first message ends the run before anything is made, and the offer going away mid-run is read as no answer', async () => {
  const r = await serve();
  const token = await keys.sign('u1', 'dev1');
  const offer = (await r.post('offer', {}, token)).json;
  const t = rig(r);
  const res = await t.client.addByCode(formatCode(offer.hint, 'AAAAA'));
  // a claim nobody answers reads as a wrong code: "didn't answer" would tell that an offer with this hint is live
  assert.equal(res.code, 'bad_code');
  assert.deepEqual(t.log, [], 'the code had not proved itself, so nothing was minted');
  // the offer is closed under the client while it waits for the answer
  const host = await controlled(r, 'silent');
  const t2 = rig(r, { timing: { answerMs: 3000, replyMs: 1000, pollMs: 5 } });
  const pending = t2.client.addByCode(host.code);
  await waitFor(() => t2.log.some((l) => l.startsWith('register')), 'the credential is registered');
  const claimed = (await r.post('claim', { hint: host.hint })).json; // a second claim makes the offer's claim count 2: the client's sends are stale
  assert.ok(claimed);
  const done = await pending;
  host.stop();
  assert.ok(['timeout', 'bad_code', 'failed'].includes(done.code), done.code);
  assert.ok(t2.log.includes(`revoke:${hostIdOf(t2.log)}`));
});

test('the relay cannot be reached: before the run began the same try may be repeated, after it a new code is needed', async () => {
  const dead = rig({ wsUrl: 'ws://127.0.0.1:1/v1/ws' });
  const early = await dead.client.addByCode('ABCD-EFGH');
  assert.equal(early.code, 'unreachable');
  assert.deepEqual(early.fix, { id: 'retry', label: 'Try again' });
  assert.equal(early.cause, "Couldn't reach MoPilot's relay. Check your connection.");
  assert.equal(dead.store.value, undefined);
  const r = await serve();
  const host = await controlled(r);
  const real = fetch;
  let calls = 0;
  // the probe, the claim and the first message get through; the next request does not
  const flaky = (async (url: any, init: any) => {
    calls++;
    if (calls > 3) throw new Error('offline');
    return real(url, init);
  }) as typeof fetch;
  const late = rig(r, { fetch: flaky });
  const res = await late.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'unreachable_late');
  assert.deepEqual(res.fix, { id: 'enter_code', label: 'Use a new code' });
  // a status the relay never gives for a probe is the relay's trouble
  const odd = rig(r, { fetch: (async () => new Response('x', { status: 500 })) as typeof fetch });
  assert.equal((await odd.client.addByCode('ABCD-EFGH')).code, 'unreachable');
  // a claim the relay limits, a claim it answers oddly, and one it cannot be reached for
  let n = 0;
  const claimWith = (status: number, body: any) =>
    (async (_url: any, init: any) => {
      n++;
      return init.method === 'GET' ? new Response('', { status: 405 }) : new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  assert.equal((await rig(r, { fetch: claimWith(429, { error: 'limited' }) }).client.addByCode('ABCD-EFGH')).code, 'limited');
  assert.equal((await rig(r, { fetch: claimWith(200, { id: 5 }) }).client.addByCode('ABCD-EFGH')).code, 'bad_code');
  const claimDown = (async (_url: any, init: any) => {
    if (init.method === 'GET') return new Response('', { status: 405 });
    throw new Error('offline');
  }) as typeof fetch;
  assert.equal((await rig(r, { fetch: claimDown }).client.addByCode('ABCD-EFGH')).code, 'unreachable');
  assert.ok(n >= 2);
});

test('the first message is refused, or the third is, by the relay: the run ends and the credential made for it is revoked', async () => {
  const r = await serve();
  const real = fetch;
  const scenario = async (which: number, status: number | 'throw') => {
    const host = await controlled(r);
    let sends = 0;
    const flaky = (async (url: any, init: any) => {
      if (String(url).endsWith('/send') && ++sends === which) {
        if (status === 'throw') throw new Error('offline');
        return new Response('{}', { status });
      }
      return real(url, init);
    }) as typeof fetch;
    const t = rig(r, { fetch: flaky });
    const res = await t.client.addByCode(host.code);
    host.stop();
    return { res, t };
  };
  assert.equal((await scenario(1, 409)).res.code, 'bad_code');
  assert.equal((await scenario(1, 'throw')).res.code, 'unreachable_late');
  const third = await scenario(2, 409);
  assert.equal(third.res.code, 'failed');
  assert.ok(third.t.log.includes(`revoke:${hostIdOf(third.t.log)}`));
  const down = await scenario(2, 'throw');
  assert.equal(down.res.code, 'unreachable_late');
  assert.ok(down.t.log.includes(`revoke:${hostIdOf(down.t.log)}`));
});

test('one run at a time, and closing the dialog ends the run now: the credential is revoked and the run says it was cancelled', async () => {
  const r = await serve();
  const host = await controlled(r, 'silent');
  const t = rig(r, { timing: { answerMs: 5000, replyMs: 1000, pollMs: 5 } });
  const first = t.client.addByCode(host.code);
  assert.equal((await t.client.addByCode('ABCD-EFGH')).code, 'busy');
  await waitFor(() => t.log.some((l) => l.startsWith('register')), 'the credential is registered');
  t.client.cancel();
  const res = await first;
  host.stop();
  assert.equal(res.code, 'cancelled');
  assert.ok(t.log.includes(`revoke:${hostIdOf(t.log)}`));
  assert.doesNotThrow(() => t.client.cancel(), 'nothing to cancel is fine');
  // cancelled while waiting for the first reply: nothing was minted
  const quiet = (await r.post('offer', {}, await keys.sign('u1', 'dev1'))).json;
  const t2 = rig(r, { timing: { answerMs: 5000, replyMs: 5000, pollMs: 5 } });
  const wrongHint = t2.client.addByCode(formatCode(quiet.hint, 'AAAAA'));
  await new Promise((x) => setTimeout(x, 60));
  t2.client.cancel();
  assert.equal((await wrongHint).code, 'cancelled');
  assert.equal(t2.log.length, 0);
});

test('a machine that cannot be listed is not paired: its path and credential are forgotten, and the run fails', async () => {
  const r = await serve();
  const host = await controlled(r);
  const t = rig(r, {
    addMachine: () => {
      throw new Error('registry full');
    },
  });
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'failed');
  assert.ok(t.log.some((l) => l.startsWith('forget:relay:h_')));
  assert.ok(t.log.some((l) => l.startsWith('revoke:h_')));
});

test('a run whose credential cannot be made or an answer that is not one of the protocol ends as a failure, with the credential revoked', async () => {
  const r = await serve();
  const host = await controlled(r);
  const t = rig(r, {
    lane: {
      whenOpen: async () => undefined,
      intend: () => undefined,
      register: async () => {
        throw new Error('relay said no');
      },
      settle: () => undefined,
      revoke: async () => {
        throw new Error('revoke failed');
      },
    },
  });
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'failed');
});

test('an accept that does not carry the Host’s half of the pair is no machine: the run fails and the credential is revoked', async () => {
  const r = await serve();
  const host = await controlled(r, 'nohalf');
  const t = rig(r);
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'failed');
  assert.ok(t.log.includes(`revoke:${hostIdOf(t.log)}`));
  assert.equal(t.machines.length + t.adopted.length, 0);
});

test('what the relay answers is bounded: a body too big, too many messages, or a box too long ends the run and revokes the credential', async () => {
  const r = await serve();
  const real = fetch;
  const hostile = (make: () => Response) =>
    (async (url: any, init: any) =>
      String(url).endsWith('/read') && init.body.includes('"after":2') ? make() : real(url, init)) as typeof fetch;
  const box = 'A'.repeat(100);
  const cases: Array<[string, () => Response, string]> = [
    [
      'a body of a megabyte',
      () => new Response(JSON.stringify({ claims: 1, messages: [], pad: 'x'.repeat(1_000_000) })),
      'unreachable_late',
    ],
    [
      'seven messages',
      () => new Response(JSON.stringify({ claims: 1, messages: Array.from({ length: 7 }, (_, n) => ({ n: n + 3, box })) })),
      'failed',
    ],
    ['a box of 5000 characters', () => new Response(JSON.stringify({ claims: 1, messages: [{ n: 3, box: 'A'.repeat(5000) }] })), 'failed'],
  ];
  for (const [what, make, code] of cases) {
    const host = await controlled(r, 'silent');
    const t = rig(r, { fetch: hostile(make) });
    const res = await t.client.addByCode(host.code);
    host.stop();
    assert.equal(res.code, code, what);
    assert.ok(t.log.includes(`revoke:${hostIdOf(t.log)}`), what);
  }
});

test('answers the relay gets wrong: not JSON, no body, a read that fails or has no messages, an https origin for a wss relay', async () => {
  const r = await serve();
  const claimWith = (make: () => Response) =>
    (async (_url: any, init: any) => (init.method === 'GET' ? new Response('', { status: 405 }) : make())) as typeof fetch;
  // a claim that is not JSON, and one with no body at all, are no offer: the code did not work
  assert.equal(
    (await rig(r, { fetch: claimWith(() => new Response('not json', { status: 200 })) }).client.addByCode('ABCD-EFGH')).code,
    'bad_code',
  );
  assert.equal(
    (await rig(r, { fetch: claimWith(() => new Response(null, { status: 200 })) }).client.addByCode('ABCD-EFGH')).code,
    'bad_code',
  );
  // a relay at an https origin: the service is asked there, and its 404 on the claim route is "isn't available"
  const asked: string[] = [];
  const off = rig(
    { wsUrl: 'wss://relay.example/v1/ws' },
    { fetch: (async (url: any) => (asked.push(String(url)), new Response('', { status: 404 }))) as typeof fetch },
  );
  assert.equal((await off.client.addByCode('ABCD-EFGH')).code, 'off');
  assert.deepEqual(asked, ['https://relay.example/v1/rendezvous/claim']);
  // reads that fail (429) or answer with no messages go on waiting until the time is up
  const real = fetch;
  for (const make of [() => new Response('{}', { status: 429 }), () => new Response(JSON.stringify({ claims: 1 }))]) {
    const host = await controlled(r, 'silent');
    const t = rig(r, {
      fetch: (async (url: any, init: any) =>
        String(url).endsWith('/read') && init.body.includes('"after":2') ? make() : real(url, init)) as typeof fetch,
    });
    assert.equal((await t.client.addByCode(host.code)).code, 'timeout');
    host.stop();
  }
});

test('a revoke that throws at once ends the run as any other: the next run is not busy, and the credential is still on the list kept before it was registered', async () => {
  const r = await serve();
  const host = await controlled(r, 'deny');
  const log: string[] = [];
  const lane = {
    whenOpen: async () => undefined,
    intend: (h: string) => void log.push(`intend:${h}`),
    register: async (x: any) => void log.push(`register:${x.host}`),
    settle: (h: string) => void log.push(`settle:${h}`),
    revoke: (h: string) => {
      log.push(`revoke:${h}`);
      throw new Error('disk error writing the revoke list');
    },
  };
  const t = rig(r, { lane });
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'denied');
  const hostId = log[0].slice(7);
  assert.deepEqual(
    log,
    [`intend:${hostId}`, `register:${hostId}`, `revoke:${hostId}`],
    'on the list from before it was registered, never settled',
  );
  // the run ended: the next one answers for its code, not "another pairing is running"
  assert.equal((await t.client.addByCode('ZZZZ-ZZZZ')).code, 'bad_code');
});
