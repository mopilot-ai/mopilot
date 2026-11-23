// A streaming reply's word fades on the document timeline (src/lib/stepFade.ts): started at their moment, once per element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FADE_MS, fadeWords, timelineNow, watchFades } from '../src/lib/stepFade.ts';

/** A word element whose Web Animations are recorded. */
function word(at: string | null, animate = true) {
  const animations: { keyframes: unknown; options: KeyframeAnimationOptions; startTime: number | null }[] = [];
  return {
    animations,
    getAttribute: (name: string) => (name === 'data-fade-at' ? at : null),
    animate: animate
      ? (keyframes: unknown, options: KeyframeAnimationOptions) => {
          const animation = { keyframes, options, startTime: null as number | null };
          animations.push(animation);
          return animation as unknown as Animation;
        }
      : undefined,
  };
}

test('a word fades from its moment on the timeline, filling backwards: one mounted later carries on mid-fade', () => {
  const fresh = word('1000');
  const remounted = word('900');
  const done = new WeakSet<object>();
  fadeWords({ querySelectorAll: () => [fresh, remounted] }, done, 1000);
  assert.deepEqual(fresh.animations, [
    { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: FADE_MS, easing: 'linear', fill: 'backwards' }, startTime: 1000 },
  ]);
  // its fade began 100 ms ago: started at its moment, it shows a quarter faded in, not from nothing
  assert.equal(remounted.animations[0].startTime, 900);
});

test('each element fades once; one whose fade has ended, one without a moment, or without Web Animations does not', () => {
  const once = word('1000');
  const ended = word(String(1000 - FADE_MS));
  const bad = word('soon');
  const old = word('1000', false);
  const done = new WeakSet<object>();
  const root = { querySelectorAll: () => [once, ended, bad, old] };
  fadeWords(root, done, 1000);
  fadeWords(root, done, 1001);
  assert.equal(once.animations.length, 1, 'a render later does not start it again');
  assert.equal(ended.animations.length, 0);
  assert.equal(bad.animations.length, 0);
  assert.ok(done.has(old));
});

test("the timeline's time comes from the document, else performance.now", () => {
  assert.equal(timelineNow({ timeline: { currentTime: 1234 } } as unknown as Document), 1234);
  const was = performance.now();
  const now = timelineNow({ timeline: { currentTime: null } } as unknown as Document);
  assert.ok(now >= was);
  assert.ok(timelineNow({} as Document) >= was);
});

test('watching a reply fades what it holds now and what each change adds, without looking at the rest again', () => {
  const now = 1000;
  const doc = { timeline: { currentTime: now } } as unknown as Document;
  const first = word('1000');
  const nested = word('1010');
  const self = word('1020');
  const asked: string[] = [];
  const container = (name: string, children: unknown[], matches = false) => ({
    nodeType: 1,
    matches: () => matches,
    querySelectorAll: () => (asked.push(name), children),
  });
  let notify: ((records: unknown[]) => void) | null = null;
  let disconnected = false;
  class FakeObserver {
    constructor(cb: (records: unknown[]) => void) {
      notify = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const root = { ownerDocument: doc, querySelectorAll: () => (asked.push('root'), [first]) };
  const stop = watchFades(root as never, FakeObserver as unknown as typeof MutationObserver);
  assert.equal(first.animations.length, 1);
  // a paragraph added with a word in it, a word added on its own, and text
  notify!([
    { addedNodes: [container('p', [nested]), { nodeType: 3 }] },
    { addedNodes: [Object.assign(self, container('span', [], true))] },
  ]);
  assert.deepEqual(asked, ['root', 'p', 'span'], 'only what was added is looked at');
  assert.equal(nested.animations[0].startTime, 1010);
  assert.equal(self.animations[0].startTime, 1020);
  stop();
  assert.ok(disconnected);
  // without a document of its own the root's time is this window's
  const bare = { ownerDocument: null, querySelectorAll: () => [] };
  watchFades(bare as never, FakeObserver as unknown as typeof MutationObserver)();
});
