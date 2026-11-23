// The pairings MoPilot offers its Chrome extension (electron/capabilities/browser/chromePairOffers.cjs): one-time claim codes, and "Allow Chrome to connect?" raised when the extension asks by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PairOffers, PENDING, CLAIM_MS, STALE_MS }: any = await import('../electron/capabilities/browser/chromePairOffers.cjs');

function offers() {
  let now = 1_000;
  const o = new PairOffers({ now: () => now });
  const changes: boolean[] = [];
  o.on('change', (asking: boolean) => changes.push(asking));
  return { o, changes, later: (ms: number) => (now += ms) };
}
const AT = { port: 47615, connected: false };

test('a claim is taken once, in time, by its own token; a new offer replaces it', () => {
  const { o, later } = offers();
  assert.equal(o.take('x'), false, 'nothing offered');
  const first = o.offer(false);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  const second = o.offer(true);
  assert.equal(o.take(first), false, 'replaced');
  assert.equal(o.userOffer(), true);
  assert.equal(o.take(second), true);
  assert.equal(o.take(second), false, 'once');
  assert.equal(o.userOffer(), false);
  const late = o.offer(true);
  later(CLAIM_MS + 1);
  assert.equal(o.userOffer(), false);
  assert.equal(o.take(late), false, 'expired');
});

test('the host gets the open claim; an ask by itself only the user’s, else PENDING and the question', () => {
  const { o, changes } = offers();
  const chat = o.offer(false);
  assert.equal(o.forHost({ ...AT, auto: false }), `mopilot-claim:1:47615:${chat}`);
  // a chat's wait isn't the user's word: the extension asking by itself raises the question instead
  assert.equal(o.forHost({ ...AT, auto: true }), PENDING);
  assert.equal(o.asking, true);
  assert.equal(o.forHost({ ...AT, auto: true }), PENDING, 'asked again while up');
  assert.deepEqual(changes, [true], 'raised once');
  o.take(chat);
  assert.equal(o.forHost({ ...AT, auto: false }), null, 'nothing open: a page Pair gets nothing');
  assert.equal(o.forHost({ ...AT, auto: true, connected: true }), null, 'connected: no question');
});

test('Allow offers the user’s claim the next ask takes; Not now holds until reset; no question, no answer', () => {
  const { o, changes } = offers();
  assert.equal(o.answer(true), false, 'nothing asked');
  assert.equal(o.forHost({ ...AT, auto: true }), PENDING);
  assert.equal(o.answer(true), true);
  assert.equal(o.asking, false);
  const code = o.forHost({ ...AT, auto: true });
  assert.match(code, /^mopilot-claim:1:47615:/);
  assert.equal(o.take(code.split(':').at(-1)), true);
  assert.equal(o.forHost({ ...AT, auto: true }), PENDING);
  assert.equal(o.answer(false), true);
  assert.equal(o.forHost({ ...AT, auto: true }), null, 'declined: the asks raise nothing');
  assert.equal(o.asking, false);
  o.reset();
  assert.equal(o.forHost({ ...AT, auto: true }), PENDING, 'reset: asked again');
  o.reset();
  assert.equal(o.asking, false);
  o.reset();
  assert.deepEqual(changes, [true, false, true, false, true, false], 'a reset with nothing up changes nothing');
});

test('the default clock is the real one', () => {
  const o = new PairOffers();
  const t = o.offer(true);
  assert.equal(o.take(t), true);
});

test('the question goes once the extension stops asking; every ask keeps it up, and an answer stops the clock', () => {
  const timers: any[] = [];
  const o = new PairOffers({
    timers: {
      setTimeout: (f: () => void, ms: number) => (timers.push({ f, ms, live: true }), timers.length - 1),
      clearTimeout: (i: number | null) => i !== null && timers[i] && (timers[i].live = false),
    },
  });
  const changes: boolean[] = [];
  o.on('change', (a: boolean) => changes.push(a));
  o.forHost({ ...AT, auto: true });
  o.forHost({ ...AT, auto: true });
  assert.deepEqual(
    timers.map((t) => [t.ms, t.live]),
    [
      [STALE_MS, false],
      [STALE_MS, true],
    ],
    'each ask rearms it',
  );
  timers[1].f();
  assert.equal(o.asking, false);
  timers[1].f();
  assert.deepEqual(changes, [true, false], 'a late fire changes nothing');
  o.forHost({ ...AT, auto: true });
  o.answer(true);
  assert.equal(timers[2].live, false);
});
