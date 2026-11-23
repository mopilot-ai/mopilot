// The phone's per-word fade of streamed text: which words are still fading, how opaque, and that shown text never fades twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FADE_MS, fadeEnd, liveSteps, splitFades, withAlpha } from '../mobile/src/presentation/wordFade';

const T = 10_000;

test('text before the first step is opaque and one piece', () => {
  assert.deepEqual(splitFades('hello world', 0, 11, [{ at: 20, time: T }], T), [{ text: 'hello world', alpha: 1 }]);
  assert.deepEqual(splitFades('hello world', 0, 11, [], T), [{ text: 'hello world', alpha: 1 }]);
});

test('a step fades its words one after another over 400 ms, linear', () => {
  const steps = [{ at: 6, time: T }];
  const at0 = splitFades('hello world again', 0, 17, steps, T);
  assert.deepEqual(
    at0.map((p) => p.text),
    ['hello ', 'world ', 'again'],
  );
  assert.equal(at0[0].alpha, 1);
  assert.equal(at0[1].alpha, 0);
  const mid = splitFades('hello world again', 0, 17, steps, T + 200);
  assert.equal(mid[1].alpha, 0.5);
  assert.ok(mid[2].alpha < mid[1].alpha, 'the later word starts later');
  const late = splitFades('hello world again', 0, 17, steps, T + FADE_MS + 200);
  assert.deepEqual(late, [{ text: 'hello world again', alpha: 1 }]);
});

test('a word already shown is not faded again when later steps arrive', () => {
  const steps = [
    { at: 6, time: T },
    { at: 12, time: T + 300 },
  ];
  const p = splitFades('hello world again', 0, 17, steps, T + 450);
  assert.deepEqual(p[0], { text: 'hello world ', alpha: 1 }, 'the older words are opaque and join');
  assert.ok(p[1].text === 'again' && p[1].alpha < 0.5, 'the newest step is still fading');
});

test('source offsets that differ from the text length place steps proportionally', () => {
  const p = splitFades('ab cd', 0, 10, [{ at: 5, time: T }], T);
  assert.equal(p.at(-1)!.alpha, 0);
});

test('live steps drop once their words are opaque; the newest stays', () => {
  const steps = [
    { at: 0, time: T },
    { at: 5, time: T + 1000 },
  ];
  assert.deepEqual(liveSteps(steps, T + 1100), [steps[1]]);
  assert.deepEqual(liveSteps(steps, T + 5000), [steps[1]]);
  assert.deepEqual(liveSteps(steps, T), steps);
  assert.equal(fadeEnd([]), 0);
  assert.equal(fadeEnd(steps), T + 1000 + 150 + FADE_MS);
});

test('withAlpha tints a hex color and leaves other formats alone', () => {
  assert.equal(withAlpha('#1a1a18', 1), '#1a1a18');
  assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255,0,0,0.500)');
  assert.equal(withAlpha('red', 0.5), 'red');
});

test('a step inside unspaced text fades only the newly revealed suffix', () => {
  for (const value of ['你好世界', 'abcdefghijklmnopqrstuvwxyz', '😀😀😀😀']) {
    const at = value === 'abcdefghijklmnopqrstuvwxyz' ? 24 : 2;
    const parts = splitFades(value, 0, value.length, [{ at, time: T }], T);
    assert.deepEqual(parts, [
      { text: value.slice(0, at), alpha: 1 },
      { text: value.slice(at), alpha: 0 },
    ]);
  }
});

test('a quote’s markers and an entity are in the source and not in the text: new words still fade from their own offset', () => {
  const quote = '> aaaa bbbb\n> cccc dddd';
  const node = { value: 'aaaa bbbb\ncccc dddd', start: 2, end: quote.length };
  const steps = [{ at: quote.indexOf('cccc'), time: T }];
  const parts = splitFades(node.value, node.start, node.end, steps, T + 10, quote.slice(node.start, node.end));
  assert.deepEqual(parts[0], { text: 'aaaa bbbb\n', alpha: 1 }, 'the shown words stay solid');
  assert.deepEqual(
    parts.slice(1).map((p) => p.text),
    ['cccc ', 'dddd'],
  );
  assert.ok(parts.slice(1).every((p) => p.alpha < 1));
  const entity = '&amp; 😀 ok';
  const e = splitFades('& 😀 ok', 0, entity.length, [{ at: entity.indexOf('ok'), time: T }], T + 10, entity);
  assert.deepEqual(
    e.map((p) => p.text),
    ['& 😀 ', 'ok'],
  );
  assert.equal(e[0].alpha, 1);
});

test('a source that does not hold the text, or none, falls back to scaling by the two lengths', () => {
  for (const source of ['', 'zzzzzzzzzz', 'ab']) {
    const parts = splitFades('ab cd', 0, source.length === 2 ? 2 : 10, [{ at: 5, time: T }], T + 10, source);
    assert.equal(parts.map((p) => p.text).join(''), 'ab cd');
  }
  assert.deepEqual(splitFades('', 0, 4, [{ at: 1, time: T }], T, 'abcd'), []);
  // a step past the end of the text node changes nothing in it
  assert.deepEqual(splitFades('a b', 0, 5, [{ at: 40, time: T }], T, 'a \\b..'), [{ text: 'a b', alpha: 1 }]);
});

test('a long paragraph with an escape splits within a frame’s budget, however many steps are live', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
  const source = `\\*${words.join(' ')}`;
  const value = `*${words.join(' ')}`;
  const steps = Array.from({ length: 25 }, (_, i) => ({ at: 200 * i, time: T + i * 20 }));
  const t0 = performance.now();
  const parts = splitFades(value, 0, source.length, steps, T + 300, source);
  assert.ok(performance.now() - t0 < 50, 'one frame of splitting stays well under a frame budget');
  assert.equal(parts.map((p) => p.text).join(''), value);
  assert.ok(parts.some((p) => p.alpha < 1));
});
