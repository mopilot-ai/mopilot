// The per-item grapheme cache behind paced replies (src/lib/textPacer.ts): incremental segmentation
// matches full segmentation, replies streaming at once keep their own entries, and the map is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEGMENT_CACHE_SIZE, graphemeBoundaries, revealedPrefix } from '../src/lib/textPacer.ts';

const reference = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const full = (text: string) => [...reference.segment(text)].map((s) => s.index);
/** The longest whole-cluster prefix of `text` within `n` code units. */
const prefixOf = (text: string, n: number) => text.slice(0, Math.max(...full(text).filter((b) => b <= n)));

/** Lengths of the strings the cache handed to Intl.Segmenter while `run` ran. */
function segmentedLengths(run: () => void): number[] {
  const original = Intl.Segmenter.prototype.segment;
  const seen: number[] = [];
  Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string) {
    seen.push(input.length);
    return original.call(this, input);
  };
  try {
    run();
  } finally {
    Intl.Segmenter.prototype.segment = original;
  }
  return seen;
}

/** mulberry32: a fixed seed keeps the random chunkings reproducible. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces whose clusters depend on what comes next: combining marks (BMP and supplementary), ZWJ
// emoji and skin tones, regional indicators, variation selectors, CR LF, Hangul jamo, a Devanagari
// conjunct, CJK and plain ASCII.
const PIECES = 'a| |e|\u0301|\u0308|\u{1D165}|👩|🏽|\u200D|💻|❤|\uFE0F|🇺|🇸|🇫|🇷|\r|\n|ᄀ|ᅡ|ᆨ|क|्|ष|你|好|😀'.split('|');

test('incremental segmentation equals full segmentation for random chunkings of tricky text', () => {
  const next = random(1208);
  for (let round = 0; round < 300; round++) {
    let text = '';
    const length = 1 + Math.floor(next() * 40);
    for (let i = 0; i < length; i++) text += PIECES[Math.floor(next() * PIECES.length)];
    // Cut at code-unit offsets, so chunks also end between the halves of a surrogate pair.
    const key = `round-${round}`;
    for (let end = 0; end < text.length; ) {
      end = Math.min(text.length, end + 1 + Math.floor(next() * 6));
      const prefix = text.slice(0, end);
      assert.deepEqual(graphemeBoundaries(key, prefix), full(prefix), JSON.stringify(prefix));
    }
  }
});

test('chunks that split each kind of cluster across the old end segment like the whole text', () => {
  const cases = [
    ['Ae', '́B'],
    ['A👩🏽', '‍💻B'],
    ['A👩🏽‍', '💻B'],
    ['x🇺', '🇸🇫🇷'],
    ['x🇺🇸🇫', '🇷y'],
    ['x\uD83D', '\uDE00y'],
    ['e\uD834', '\uDD65z'],
    ['\r', '\nq'],
  ];
  for (const [head, tail] of cases) {
    const key = JSON.stringify(head);
    graphemeBoundaries(key, head);
    assert.deepEqual(graphemeBoundaries(key, head + tail), full(head + tail), key);
    assert.equal(revealedPrefix(head + tail, head.length, key), prefixOf(head + tail, head.length), key);
  }
});

test('a growing reply segments only what it appended, not its whole length', () => {
  const base = '这是一个很长的回复 with emoji 👩🏽‍💻 and flags 🇫🇷. '.repeat(400);
  graphemeBoundaries('long', base);
  const seen = segmentedLengths(() => {
    for (let i = 1; i <= 20; i++) graphemeBoundaries('long', base + 'more 😀 '.repeat(i));
  });
  assert.equal(seen.length, 20);
  assert.ok(Math.max(...seen) < 200, `segmented ${Math.max(...seen)} of ${base.length}`);
  // the same text again is a cache hit
  assert.deepEqual(
    segmentedLengths(() => graphemeBoundaries('long', base + 'more 😀 '.repeat(20))),
    [],
  );
});

test('text that does not extend the cached text is segmented again from the start', () => {
  graphemeBoundaries('edit', 'hello world');
  const edited = 'help me';
  let boundaries: number[] = [];
  assert.deepEqual(
    segmentedLengths(() => (boundaries = graphemeBoundaries('edit', edited))),
    [edited.length],
  );
  assert.deepEqual(boundaries, full(edited));
  // an empty cached text is extended by anything
  graphemeBoundaries('empty', '');
  assert.deepEqual(graphemeBoundaries('empty', 'é'), full('é'));
});

test('two replies streaming at once keep their own boundaries', () => {
  const a = 'Reply A 第一段 🇯🇵 '.repeat(200);
  const b = 'Reply B second 👨‍👩‍👧 '.repeat(200);
  graphemeBoundaries('A', a);
  graphemeBoundaries('B', b);
  const results: [number[], number[]][] = [];
  const seen = segmentedLengths(() => {
    for (let i = 1; i <= 10; i++) {
      results.push([[...graphemeBoundaries('A', a + 'x'.repeat(i))], [...graphemeBoundaries('B', b + 'y'.repeat(i))]]);
    }
  });
  results.forEach(([ba, bb], i) => {
    assert.deepEqual(ba, full(a + 'x'.repeat(i + 1)));
    assert.deepEqual(bb, full(b + 'y'.repeat(i + 1)));
  });
  assert.equal(seen.length, 20);
  assert.ok(Math.max(...seen) < 50, `segmented ${Math.max(...seen)}`);
  assert.equal(revealedPrefix(a + 'xx', 12, 'A'), prefixOf(a + 'xx', 12));
  // 17 falls inside the family emoji, which is never split
  assert.equal(revealedPrefix(b + 'yy', 17, 'B'), 'Reply B second ');
});

test('the cache holds the most recently used items and evicts the oldest', () => {
  const text = (i: number) => `item ${i} `.repeat(50);
  for (let i = 0; i < SEGMENT_CACHE_SIZE; i++) graphemeBoundaries(`lru-${i}`, text(i));
  // touching lru-0 makes lru-1 the oldest
  graphemeBoundaries('lru-0', text(0));
  graphemeBoundaries('lru-new', text(99));
  const grow = (i: number) => segmentedLengths(() => graphemeBoundaries(`lru-${i}`, text(i) + '!'));
  assert.deepEqual(grow(1), [text(1).length + 1]);
  // lru-0 survived; growing lru-1 back in evicted lru-2, the oldest left
  assert.ok(grow(0)[0] < 20);
  assert.deepEqual(grow(2), [text(2).length + 1]);
});

test('segmenting a long reply in small deltas costs its appended text (micro-benchmark, not asserted)', (t) => {
  const delta = 'tokens 流式 😀 ';
  const reply = delta.repeat(1500);
  let start = performance.now();
  for (let end = delta.length; end <= reply.length; end += delta.length * 10) full(reply.slice(0, end));
  const fullMs = performance.now() - start;
  start = performance.now();
  for (let end = delta.length; end <= reply.length; end += delta.length * 10) graphemeBoundaries('bench', reply.slice(0, end));
  const cachedMs = performance.now() - start;
  t.diagnostic(`${reply.length} chars in 150 steps: full ${fullMs.toFixed(1)} ms, incremental ${cachedMs.toFixed(1)} ms`);
  assert.deepEqual(graphemeBoundaries('bench', reply), full(reply));
});
