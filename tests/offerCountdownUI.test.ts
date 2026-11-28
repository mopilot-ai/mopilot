// src/components/thread/OfferCountdown.tsx: an offer card's countdown as a window draws main's deadline: whole seconds
// that tick as each one passes and never go below zero, then "Starting a new session…" until main answers; and the
// fill's timing, fixed once per countdown and started as far back as main's countdown already ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';

const { createRoot } = await import('react-dom/client');
const { secondsLeft, fillTiming, useFillTiming, OfferCountdownNote } = await import('../src/components/thread/OfferCountdown.tsx');

function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  return { host, root: createRoot(host as any) };
}

test('the seconds left round up, so the last second reads 1, and stop at 0', () => {
  assert.equal(secondsLeft(60_000, 0), 60);
  assert.equal(secondsLeft(60_000, 1), 60);
  assert.equal(secondsLeft(60_000, 59_000), 1);
  assert.equal(secondsLeft(60_000, 59_999), 1);
  assert.equal(secondsLeft(60_000, 60_000), 0);
  assert.equal(secondsLeft(60_000, 90_000), 0, 'a deadline already past is 0, never negative');
});

test('the fill runs the whole countdown, started as far back as main already counted', () => {
  assert.deepEqual(fillTiming({ from: 1000, at: 61_000 }, 11_000), { '--offer-countdown': '60000ms', '--offer-countdown-ran': '-10000ms' });
  // drawn before it began (clocks a little apart) or after it ran out: from its start, or full
  assert.deepEqual(fillTiming({ from: 1000, at: 61_000 }, 0), { '--offer-countdown': '60000ms', '--offer-countdown-ran': '0ms' });
  assert.deepEqual(fillTiming({ from: 1000, at: 61_000 }, 99_000), { '--offer-countdown': '60000ms', '--offer-countdown-ran': '-60000ms' });
  // a deadline no later than its start is a countdown already over
  assert.deepEqual(fillTiming({ from: 5, at: 5 }, 5), { '--offer-countdown': '1ms', '--offer-countdown-ran': '0ms' });
});

test('the note ticks each whole second from main’s deadline, then says it is starting a new session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { host, root } = mount();
  const draw = (at: number) => act(() => root.render(h(OfferCountdownNote, { id: 'n1', at })));
  await draw(1_000_000 + 2500);
  const note = () => host.querySelector('#n1')!;
  assert.equal(note().getAttribute('role'), 'timer');
  assert.equal(note().textContent, 'Starting a new session in 3s');
  // the number changes the moment a whole second runs out, not a timer's period after the render
  await act(async () => t.mock.timers.tick(499));
  assert.equal(note().textContent, 'Starting a new session in 3s');
  await act(async () => t.mock.timers.tick(1));
  assert.equal(note().textContent, 'Starting a new session in 2s');
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(note().textContent, 'Starting a new session in 1s');
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(note().textContent, 'Starting a new session…');
  // nothing ticks once it ran out; main's answer takes the card from here
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(note().textContent, 'Starting a new session…');
  // a new deadline (another window's hold, then a new countdown) starts the count again
  await draw(Date.now() + 2000);
  assert.equal(note().textContent, 'Starting a new session in 2s');
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(note().textContent, 'Starting a new session in 1s');
  await act(() => root.unmount());
  host.remove();
});

test('the fill timing is read once per countdown, so re-renders never restart or skip the animation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { host, root } = mount();
  const seen: unknown[] = [];
  const Probe = ({ countdown }: { countdown: { from: number; at: number } | null }) => (seen.push(useFillTiming(countdown)), null);
  const draw = (countdown: { from: number; at: number } | null) => act(() => root.render(h(Probe, { countdown })));
  await draw(null);
  assert.equal(seen.at(-1), undefined, 'nothing to fill');
  await draw({ from: 990_000, at: 1_050_000 });
  const first = seen.at(-1);
  assert.deepEqual(first, { '--offer-countdown': '60000ms', '--offer-countdown-ran': '-10000ms' });
  t.mock.timers.tick(20_000);
  // the same countdown drawn again (a new object from main's next publish) keeps the timing it started with
  await draw({ from: 990_000, at: 1_050_000 });
  assert.equal(seen.at(-1), first);
  // another countdown is timed afresh
  await draw({ from: 1_020_000, at: 1_080_000 });
  assert.deepEqual(seen.at(-1), { '--offer-countdown': '60000ms', '--offer-countdown-ran': '0ms' });
  await act(() => root.unmount());
  host.remove();
});
