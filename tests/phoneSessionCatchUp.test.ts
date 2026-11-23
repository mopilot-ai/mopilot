// A phone whose saved receive counter is far behind the Mac's: it catches up once, bounded, and only by a frame that opens under the pair's own chain; past the bound it says the computer is lost, and nothing it saved changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKPOINT_STRIDE, CHUNK_STEPS, createPhoneSession } from '../shared/remote/phoneSession.mjs';
import { MAX_SKIP, RemoteCryptoError, createCrypto } from '../shared/remote/crypto.mjs';
import { toHex, toWire, utf8 } from '../shared/remote/envelope.mjs';
import { prim } from './support/phonePairingFixture.ts';

const PAIR = 'p_12345678';

/** A phone session with its saved state in `box`, a Mac sender that has sealed `ahead` frames the phone never saw, . */
const SMALL = MAX_SKIP + 1000; // a bound small enough to test beyond without sealing a quarter million frames

function rig(ahead: number, onPause?: (box: { pair: any }) => void) {
  const chain = prim.randomBytes(32);
  const crypto = createCrypto(prim);
  const box = { pair: { tx: { ctr: 0, chain: toHex(chain) }, rx: { ctr: 0, chain: toHex(chain) } } as any };
  const got: any[] = [];
  const phases: string[] = [];
  const pauses = { n: 0 };
  const open = (): ReturnType<typeof createPhoneSession> =>
    createPhoneSession({
      prim,
      pairId: PAIR,
      vault: {
        async updatePair(_id: string, fn: any) {
          const result = fn(structuredClone(box.pair));
          box.pair = result.pair;
          return result.value;
        },
      },
      send: async () => {},
      onMessage: (m: any) => got.push(m),
      catchUpSkip: SMALL,
      onCatchUp: (phase: string) => phases.push(phase),
      pause: async () => {
        pauses.n++;
        onPause?.(box);
      },
    });
  const mac = crypto.createSender({ pair: PAIR, dir: 'm2p', chain });
  for (let i = 0; i < ahead; i++) mac.seal(utf8('{}'));
  const frame = (id: string) => toWire(mac.seal(utf8(JSON.stringify({ id, t: 1, kind: 'event' }))));
  return { box, got, phases, pauses, open, frame, mac };
}

test('a Mac more than the usual walk ahead is caught up with: the frame opens, the counters move, the next frame is in order', async () => {
  const r = rig(MAX_SKIP + 500);
  const session = r.open();
  await session.receive(r.frame('a'));
  assert.deepEqual(
    r.got.map((m) => m.id),
    ['a'],
  );
  assert.equal(r.box.pair.rx.ctr, MAX_SKIP + 501);
  await session.receive(r.frame('b'));
  assert.deepEqual(
    r.got.map((m) => m.id),
    ['a', 'b'],
  );
});

test('a Mac beyond the catch-up bound is lost: nothing is saved, nothing is dispatched, and the error says so', async () => {
  const r = rig(SMALL + 10);
  const before = structuredClone(r.box.pair);
  await assert.rejects(r.open().receive(r.frame('x')), (e: any) => e instanceof RemoteCryptoError && e.code === 'lost');
  assert.deepEqual(r.box.pair, before);
  assert.deepEqual(r.got, []);
});

test('a far frame that does not open changes nothing, so a forged counter cannot move the ratchet', async () => {
  const r = rig(MAX_SKIP + 500);
  const forged = r.frame('x');
  forged.box = forged.box.slice(0, -1) + (forged.box.endsWith('A') ? 'B' : 'A');
  const before = structuredClone(r.box.pair);
  await assert.rejects(r.open().receive(forged), (e: any) => e instanceof RemoteCryptoError && e.code === 'auth');
  assert.deepEqual(r.box.pair, before);
  assert.deepEqual(r.got, []);
});

/** A rig whose chain advance is counted, so the work a walk does is measured, not guessed. */
function counted() {
  const steps = { n: 0 };
  const spy = { ...prim, hmacSha256: (k: Uint8Array, m: Uint8Array) => (m[0] === 2 && steps.n++, prim.hmacSha256(k, m)) };
  return { steps, spy };
}

test('forged far frames cannot lock real ones out: the work for one saved counter is bounded, and a real frame after any number of forged ones opens', async () => {
  const r = rig(MAX_SKIP + 900);
  const session = r.open();
  const real = r.frame('real');
  const forgedAt = (wire: any) => ({ ...wire, box: wire.box.slice(0, -1) + (wire.box.endsWith('A') ? 'B' : 'A') });
  const before = structuredClone(r.box.pair);
  for (let i = 0; i < 5; i++) await assert.rejects(session.receive(forgedAt(real)), (e: any) => e.code === 'auth');
  assert.deepEqual(r.box.pair, before, 'nothing saved moved');
  await session.receive(real);
  assert.deepEqual(
    r.got.map((m) => m.id),
    ['real'],
    'no lockout: the real frame is walked for at once',
  );
});

test('repeated walks to the same far counter hash the chain once; a nearer target resumes from a cached point', async () => {
  const r = rig(MAX_SKIP + 900);
  const { steps, spy } = counted();
  const session = createPhoneSession({
    prim: spy,
    pairId: PAIR,
    vault: { updatePair: async (_id: string, fn: any) => ((x) => ((r.box.pair = x.pair), x.value))(fn(structuredClone(r.box.pair))) },
    send: async () => {},
    onMessage: (m: any) => r.got.push(m),
    catchUpSkip: SMALL,
    pause: async () => {},
  });
  const first = r.frame('x');
  const forged = { ...first, box: first.box.slice(0, -1) + (first.box.endsWith('A') ? 'B' : 'A') };
  await assert.rejects(session.receive(forged));
  const afterFirst = steps.n;
  assert.ok(afterFirst >= MAX_SKIP + 800, 'the first walk pays for the distance');
  await assert.rejects(session.receive(forged));
  assert.ok(steps.n - afterFirst <= 2, "a repeat costs only the frame itself: the walk's last target is cached as the tail");
});

test('a frame at or behind the saved counter after the gap was seen is a rewind, never walked for', async () => {
  const r = rig(MAX_SKIP + 500);
  const wire = r.frame('late');
  const phases: string[] = [];
  // the first read sees a gap; by the time the walk starts, a save moved the counter past the frame
  const real = r.box.pair;
  let reads = 0;
  const vault = {
    async updatePair(_id: string, fn: any) {
      reads++;
      const pair = structuredClone(real);
      if (reads > 1) pair.rx.ctr = 99999;
      return fn(pair).value;
    },
  };
  const racing = createPhoneSession({
    prim,
    pairId: PAIR,
    vault,
    send: async () => {},
    onMessage: () => {},
    catchUpSkip: SMALL,
    onCatchUp: (p: string) => phases.push(p),
    pause: async () => {},
  });
  await assert.rejects(racing.receive(wire), (e: any) => e instanceof RemoteCryptoError && e.code === 'rewind');
  assert.deepEqual(phases, [], 'nothing was walked or announced');
});

test('a session closed during the walk stops walking and saves nothing', async () => {
  const r = rig(MAX_SKIP + 900);
  const before = structuredClone(r.box.pair);
  let session: ReturnType<typeof createPhoneSession>;
  let breaks = 0;
  session = createPhoneSession({
    prim,
    pairId: PAIR,
    vault: {
      async updatePair(_id: string, fn: any) {
        const result = fn(structuredClone(r.box.pair));
        r.box.pair = result.pair;
        return result.value;
      },
    },
    send: async () => {},
    onMessage: (m: any) => r.got.push(m),
    catchUpSkip: SMALL,
    onCatchUp: (p: string) => r.phases.push(p),
    pause: async () => void (++breaks === 1 && session.close()),
  });
  await assert.rejects(session.receive(r.frame('a')), (e: any) => /closed/.test(e.message));
  assert.equal(breaks, 1, 'no second chunk was walked');
  assert.deepEqual(r.box.pair, before);
  assert.deepEqual(r.phases, ['start', 'failed']);
});

test('a session that lost its computer (beyond the bound) can be retried: a new session catches up from a nearer frame', async () => {
  const r = rig(SMALL + 10);
  await assert.rejects(r.open().receive(r.frame('x')), (e: any) => e.code === 'lost');
  const again = rig(MAX_SKIP + 100);
  await again.open().receive(again.frame('y'));
  assert.deepEqual(
    again.got.map((m) => m.id),
    ['y'],
  );
});

test('the walk is told to the screen (start, then done or failed) and lets the app draw between chunks', async () => {
  const r = rig(MAX_SKIP + 900);
  await r.open().receive(r.frame('a'));
  assert.deepEqual(r.phases, ['start', 'done']);
  assert.ok(r.pauses.n >= 2, 'the walk gave the app room to draw more than once');
  const far = rig(MAX_SKIP + 500);
  const forged = far.frame('x');
  forged.box = forged.box.slice(0, -1) + (forged.box.endsWith('A') ? 'B' : 'A');
  await assert.rejects(far.open().receive(forged));
  assert.deepEqual(far.phases, ['start', 'failed']);
  const beyond = rig(SMALL + 10);
  await assert.rejects(beyond.open().receive(beyond.frame('y')));
  assert.deepEqual(beyond.phases, [], 'beyond the bound nothing is walked, so nothing is announced');
});

test('after the app is killed mid-stream the saved counters are what the next session catches up from', async () => {
  const r = rig(0);
  const first = r.open();
  await first.receive(r.frame('a'));
  first.close();
  for (let i = 0; i < MAX_SKIP + 20; i++) r.frame('lost');
  await r.open().receive(r.frame('b'));
  assert.deepEqual(
    r.got.map((m) => m.id),
    ['a', 'b'],
  );
});

test('B3: the phone gives the app room every 128 steps (about 30 ms at the measured 230 µs a step), and caches a point every 1024', async () => {
  assert.equal(CHUNK_STEPS, 128);
  assert.equal(CHECKPOINT_STRIDE, 1024);
  for (const ahead of [MAX_SKIP + 500, MAX_SKIP + 900, MAX_SKIP + 1]) {
    const r = rig(ahead);
    await r.open().receive(r.frame('a'));
    assert.equal(r.pauses.n, Math.ceil(ahead / CHUNK_STEPS), `${ahead} steps`);
  }
});

test('a save made while the walk is under way is not overwritten: the frame fails with `state` and nothing is dispatched or saved', async () => {
  const r = rig(MAX_SKIP + 500, (box) => {
    // another path advanced the saved receive counter during the walk
    box.pair.rx = { ctr: 1, chain: box.pair.rx.chain };
  });
  await assert.rejects(r.open().receive(r.frame('x')), (e: any) => e instanceof RemoteCryptoError && e.code === 'state');
  assert.deepEqual(r.got, []);
  assert.equal(r.box.pair.rx.ctr, 1, 'what was saved meanwhile stays');
  assert.deepEqual(r.phases, ['start', 'failed']);
});

test('after an opened catch-up frame the walker holds no point at or below the new counter; a failed one keeps its points', async () => {
  const r = rig(MAX_SKIP + 500);
  const session = r.open();
  const real = r.frame('a');
  const forged = { ...real, box: (real.box[0] === 'A' ? 'B' : 'A') + real.box.slice(1) };
  await assert.rejects(session.receive(forged));
  assert.ok(session.walkedPoints().length > 1, 'the walk of a forged frame left its points: they are ahead of the saved counter');
  assert.ok(session.walkedPoints().every((k: number) => k >= r.box.pair.rx.ctr));
  await session.receive(real);
  assert.equal(r.box.pair.rx.ctr, MAX_SKIP + 501);
  assert.deepEqual(session.walkedPoints(), [], 'nothing derived from before the new counter is kept');
  await session.receive(r.frame('b'));
  assert.deepEqual(session.walkedPoints(), [], 'an ordinary frame leaves none either');
});

test('a malformed payload that opened also drops the walker points', async () => {
  const r = rig(MAX_SKIP + 500);
  const session = r.open();
  const bad = toWire(r.mac.seal(utf8('not json')));
  await session.receive(bad);
  assert.deepEqual(session.walkedPoints(), []);
});
