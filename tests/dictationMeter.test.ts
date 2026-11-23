// While dictation records: the level meter, its clock and countdown, Enter to stop and Esc to discard in its own input
// (src/components/ui/DictationMeter.tsx), and hold-to-talk on the dictation shortcut (src/components/composer/holdToTalk.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, flush, mount } from './support/composer-kit.ts';
import { mockTsx } from './support/composer-kit.ts';
import { createElement, act } from 'react';

mockTsx(new URL('../src/components/ui/Popover.tsx', import.meta.url), { Tooltip: ({ children }: any) => children });
const { DictationMeter, clock, DICTATION_MAX_MS } = await import('../src/components/ui/DictationMeter.tsx');
const { holdToTalk, HOLD_MS } = await import('../src/components/composer/holdToTalk.ts');

test('the clock reads m:ss', () => {
  assert.deepEqual([clock(0), clock(9_999), clock(61_000), clock(-5)], ['0:00', '0:09', '1:01', '0:00']);
});

function scene() {
  const box = document.createElement('div');
  const input = document.createElement('div');
  const outside = document.createElement('div');
  box.append(input);
  document.body.append(box, outside);
  return { box, input, outside };
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new (window as any).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

test('Enter stops and Esc discards only in its own input, before the input sees them; the clock counts down at the end', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const { box, input, outside } = scene();
  const calls: string[] = [];
  const editorSaw: string[] = [];
  input.addEventListener('keydown', (e) => editorSaw.push(e.key));
  const m = await mount(
    createElement(DictationMeter, {
      stream: {} as MediaStream,
      startedAt: 1_000_000,
      scope: () => box,
      onStop: () => calls.push('stop'),
      onCancel: () => calls.push('cancel'),
    }),
  );
  try {
    // a steady label: the clock is on screen only, so a screen reader isn't told the time every second
    assert.equal($('.dictation-meter').getAttribute('aria-label'), 'Recording');
    assert.equal($('.dictation-time').getAttribute('aria-hidden'), 'true');
    assert.equal($('.dictation-time').textContent, '0:00');
    assert.equal(m.host.querySelectorAll('.dictation-wave i').length, 12);
    assert.equal(press(input, 'Enter').defaultPrevented, true);
    press(input, 'Escape');
    assert.deepEqual(calls, ['stop', 'cancel']);
    assert.deepEqual(editorSaw, [], 'the editor neither sends nor closes');
    // other keys, modified keys, IME composition and other inputs are left alone
    press(input, 'a');
    press(input, 'Enter', { shiftKey: true });
    press(input, 'Enter', { isComposing: true });
    press(outside, 'Enter');
    assert.deepEqual(calls, ['stop', 'cancel']);
    await act(async () => void t.mock.timers.tick(65_000));
    assert.equal($('.dictation-time').textContent, '1:05');
    await act(async () => void t.mock.timers.tick(DICTATION_MAX_MS - 65_000 - 4_500));
    assert.equal($('.dictation-time').textContent, '5s left');
    assert.match($('.dictation-time').className, /ending/);
    await act(async () => ($('.dictation-cancel') as HTMLButtonElement).click());
    assert.deepEqual(calls.at(-1), 'cancel');
  } finally {
    await m.unmount();
  }
  press(input, 'Enter');
  assert.equal(calls.length, 3, 'an ended recording no longer takes Enter');
  const gone = await mount(
    createElement(DictationMeter, {
      stream: {} as MediaStream,
      startedAt: 0,
      scope: () => null,
      onStop: () => calls.push('x'),
      onCancel() {},
    }),
  );
  press(input, 'Enter');
  assert.equal(calls.length, 3, 'no input: no keys taken');
  await gone.unmount();
});

test('the bars follow the microphone’s level, and the meter lets go of its audio when it ends', async () => {
  const frames: ((t: number) => void)[] = [];
  let closed = 0;
  let level = 0;
  const raf = (cb: any) => (frames.push(cb), frames.length);
  for (const g of [window, globalThis] as any[]) Object.assign(g, { requestAnimationFrame: raf, cancelAnimationFrame: () => {} });
  (window as any).AudioContext = class {
    createAnalyser() {
      return { fftSize: 0, getFloatTimeDomainData: (d: Float32Array) => d.fill(level) };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      closed++;
      return closed > 1 ? Promise.reject(new Error('closed')) : Promise.resolve();
    }
  };
  try {
    for (let round = 0; round < 2; round++) {
      const m = await mount(
        createElement(DictationMeter, { stream: {} as MediaStream, startedAt: Date.now(), scope: () => null, onStop() {}, onCancel() {} }),
      );
      level = 0.04;
      await act(async () => frames.at(-1)!(100));
      await act(async () => frames.at(-1)!(120)); // too soon for another bar
      const bars = [...m.host.querySelectorAll('.dictation-wave i')] as HTMLElement[];
      assert.equal(bars.length, 12);
      assert.equal(bars[0].style.transform, 'scaleY(0.12)');
      assert.match(bars[11].style.transform, /scaleY\(0\.(?!12)/, 'the newest bar shows the level');
      await m.unmount();
      await flush();
    }
    assert.equal(closed, 2);
  } finally {
    delete (window as any).AudioContext;
  }
});

test('a held shortcut stops dictating when it comes up; a tap keeps it going; leaving the window ends the hold', () => {
  let now = 0;
  let stops = 0;
  const up = () => window.dispatchEvent(new (window as any).KeyboardEvent('keyup', { key: 'v' }));
  holdToTalk(
    () => stops++,
    () => now,
  );
  now = HOLD_MS - 1;
  up();
  assert.equal(stops, 0, 'a tap toggles');
  now = 0;
  holdToTalk(
    () => stops++,
    () => now,
  );
  now = HOLD_MS;
  up();
  up();
  assert.equal(stops, 1, 'once, on the first release');
  holdToTalk(
    () => stops++,
    () => now - HOLD_MS * 2,
  );
  window.dispatchEvent(new (window as any).Event('blur'));
  up();
  assert.equal(stops, 1);
  const disarm = holdToTalk(() => stops++);
  disarm();
  up();
  assert.equal(stops, 1);
});
