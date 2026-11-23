// startEdgeDrag (src/lib/edgeDrag.ts): pointer moves coalesced to one write per frame, one commit on release (#2049).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { pointerEvent } from './support/pointerCapture.ts';
import { startEdgeDrag } from '../src/lib/edgeDrag.ts';

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
const originals = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] as const;
beforeEach(() => {
  frames = new Map();
  globalThis.requestAnimationFrame = (cb) => (frames.set(++nextFrame, cb), nextFrame);
  globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
});
afterEach(() => {
  [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = originals;
});
/** Runs the frames waiting now, as the browser does before it paints. */
const paint = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
};
let edge: HTMLElement;
const fire = (type: string, clientX = 0, init: Record<string, unknown> = {}) =>
  edge.dispatchEvent(pointerEvent(type, { clientX, ...init }));

function drag() {
  edge = document.createElement('div');
  const log: string[] = [];
  const stop = startEdgeDrag(
    { currentTarget: edge, pointerId: 1 },
    {
      axis: 'column',
      size: (e) => 1000 - e.clientX,
      apply: (w) => void log.push(`apply ${w}`),
      ended: () => void log.push('ended'),
      commit: (w) => void log.push(`commit ${w}`),
    },
  );
  return { log, stop };
}

test('moves within one frame are shown once, at the last pointer position', () => {
  const { log } = drag();
  fire('pointermove', 900);
  fire('pointermove', 850);
  fire('pointermove', 800);
  assert.deepEqual(log, [], 'nothing is written between frames');
  assert.equal(frames.size, 1, 'one frame asked for, not one per move');
  paint();
  assert.deepEqual(log, ['apply 200']);
  fire('pointermove', 700);
  paint();
  assert.deepEqual(log, ['apply 200', 'apply 300']);
  fire('pointerup');
});

test('release shows and commits the final size once, drops the pending frame and stops listening', () => {
  const { log } = drag();
  fire('pointermove', 900);
  fire('pointermove', 600);
  fire('pointerup');
  assert.deepEqual(log, ['ended', 'apply 400', 'commit 400']);
  assert.equal(frames.size, 0, 'the pending frame is cancelled, so it cannot write after the commit');
  fire('pointermove', 100);
  fire('pointerup');
  paint();
  assert.deepEqual(log, ['ended', 'apply 400', 'commit 400']);
});

test('a press released without a move commits nothing, and tells the owner the drag is over', () => {
  const { log } = drag();
  fire('pointerup');
  paint();
  assert.deepEqual(log, ['ended']);
});

for (const end of ['lostpointercapture', 'pointercancel'])
  test(`a release the edge does not hear ends the drag (${end}): what it showed is kept, later moves do nothing (#3833)`, () => {
    const { log } = drag();
    assert.equal(edge.hasPointerCapture(1), true, 'the pointer is captured from the press');
    assert.equal(document.documentElement.dataset.edgeDrag, 'column');
    fire('pointermove', 900);
    paint();
    fire(end);
    assert.deepEqual(log, ['apply 100', 'ended', 'apply 100', 'commit 100']);
    assert.equal(document.documentElement.dataset.edgeDrag, undefined);
    fire('pointermove', 200);
    paint();
    assert.equal(log.length, 4);
  });

test("another pointer's events neither move nor end the drag", () => {
  const { log } = drag();
  fire('pointermove', 900, { pointerId: 2 });
  fire('pointermove', 900, { pointerId: 2, buttons: 0 });
  fire('pointerup', 900, { pointerId: 2 });
  fire('lostpointercapture', 900, { pointerId: 2 });
  paint();
  assert.deepEqual(log, []);
  assert.equal(edge.hasPointerCapture(1), true);
  fire('pointerup');
});

test('stop (an unmount mid-drag) drops the drag: no frame, no commit, no listener left', () => {
  const { log, stop } = drag();
  fire('pointermove', 900);
  assert.equal(edge.hasPointerCapture(1), true);
  stop();
  assert.equal(frames.size, 0);
  assert.equal(edge.hasPointerCapture(1), false, 'the capture goes with the drag');
  assert.equal(document.documentElement.dataset.edgeDrag, undefined);
  fire('pointermove', 800);
  fire('pointerup');
  paint();
  assert.deepEqual(log, []);
  stop(); // stopping twice is harmless
});

test('a second drag after the first works from its own start', () => {
  drag();
  fire('pointermove', 900);
  fire('pointerup');
  const second = drag();
  fire('pointermove', 500);
  paint();
  fire('pointerup');
  assert.deepEqual(second.log, ['apply 500', 'ended', 'apply 500', 'commit 500']);
});

test('a move with no button held ends the drag: a release the edge did not hear (#3833)', () => {
  const { log } = drag();
  fire('pointermove', 900);
  fire('pointermove', 700, { buttons: 0 }); // back over the app after a release inside an iframe
  assert.deepEqual(log, ['ended', 'apply 100', 'commit 100'], 'commits the size of the last move that had a button');
  assert.equal(frames.size, 0);
  assert.equal(document.documentElement.dataset.edgeDrag, undefined);
  fire('pointermove', 100);
  fire('pointerup');
  paint();
  assert.equal(log.length, 3, 'no longer following the mouse');
});

test('a buttonless move before any held move ends the drag without a commit', () => {
  const { log } = drag();
  fire('pointermove', 700, { buttons: 0 });
  fire('pointermove', 600);
  paint();
  assert.deepEqual(log, ['ended']);
});

test('returning from a frame flushes a pending held move before the stopped width can be compared', () => {
  const { log } = drag();
  fire('pointermove', 900.25);
  paint();
  fire('pointermove', 896.25); // the last held position has not painted when the release goes to the iframe
  assert.deepEqual(log, ['apply 99.75']);
  assert.equal(frames.size, 1);
  fire('pointermove', 110, { buttons: 0 });
  const committed = ['apply 99.75', 'ended', 'apply 103.75', 'commit 103.75'];
  assert.deepEqual(log, committed, 'release discovery flushes the held position, not the new buttonless position');
  assert.equal(frames.size, 0);
  assert.equal(edge.hasPointerCapture(1), false);
  assert.equal(document.documentElement.dataset.edgeDrag, undefined);
  fire('pointermove', 600, { buttons: 0 });
  paint();
  assert.deepEqual(log, committed, 'later motion cannot alter the committed width');
});

test('the window losing focus mid-drag ends it like a release', () => {
  const { log } = drag();
  fire('pointermove', 900);
  window.dispatchEvent(new (window as any).Event('blur'));
  assert.deepEqual(log, ['ended', 'apply 100', 'commit 100']);
  assert.equal(edge.hasPointerCapture(1), false);
  fire('pointermove', 300);
  window.dispatchEvent(new (window as any).Event('blur'));
  paint();
  assert.equal(log.length, 3);
});

test('frameCoalescer: values between frames show once, at the last; a cancelled value is never shown', async () => {
  const { frameCoalescer } = await import('../src/lib/edgeDrag.ts');
  const shown: number[] = [];
  const coalescer = frameCoalescer((v: number) => void shown.push(v));
  coalescer.push(1);
  coalescer.push(2);
  assert.equal(frames.size, 1);
  paint();
  assert.deepEqual(shown, [2]);
  coalescer.push(3);
  coalescer.cancel();
  assert.equal(frames.size, 0);
  paint();
  assert.deepEqual(shown, [2]);
  coalescer.cancel(); // nothing waiting: harmless
  coalescer.push(4);
  paint();
  assert.deepEqual(shown, [2, 4]);
});
