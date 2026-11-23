// Paced streaming text (arrival.tsx, textPacer.ts): steps and their lag, completion, motion, visibility and focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONG, PACE, act, clock, media, mount, run, setFocused, setVisibility, tick, timers, window } from './support/smoothText.ts';

test('text arriving after a pause waits one step, then shows in steps; completion drains and stops the timer', async () => {
  clock.now = 0;
  const m = await mount('continuous', 'first');
  try {
    await m.update('first second');
    await m.update('first second 第三');
    // one timer however many deltas came: each delta replaces it
    assert.equal(timers.size, 1);
    await tick(0);
    assert.equal(m.host.textContent, '', 'a burst after a pause waits one step: the lag that evens out the next one');
    await tick(PACE.maxStepMs);
    // a CJK word cuts anywhere: the whole of what arrived shows
    assert.equal(m.host.textContent, 'first second 第三');
    assert.equal(m.host.firstElementChild!.getAttribute('data-steps'), '0');
    await m.update('first second 第三 four');
    await run(clock.now + 400);
    // a Latin word at the end of what arrived may not be whole yet: it waits for what follows, or for the end
    assert.equal(m.host.textContent, 'first second 第三 ');
    await m.update('first second 第三 four', false);
    await run(clock.now + 1000);
    assert.equal(m.host.textContent, 'first second 第三 four');
    assert.equal(m.host.firstElementChild!.getAttribute('data-streaming'), 'false');
    assert.equal(timers.size, 0);
  } finally {
    await m.close();
  }
});

test('text arriving at a steady rate shows about the target lag behind it, in whole words, never stalling', async () => {
  clock.now = 0;
  const text = 'word '.repeat(200);
  const m = await mount('steady-lag', '');
  try {
    // 20 characters every 50 ms (400 a second), as a model streams
    const lags: number[] = [];
    const revealedAt: number[] = [];
    let last = 0;
    for (let t = 50, received = 20; received <= text.length; t += 50, received += 20) {
      await m.update(text.slice(0, received));
      for (let at = t - 25; at <= t; at += 25) {
        await tick(at);
        const shown = m.host.textContent!.length;
        if (shown !== last) revealedAt.push(at);
        last = shown;
      }
      // how long ago what is shown clock.now had arrived
      if (t >= 1000) lags.push(t - (Math.floor(m.host.textContent!.length / 20) + 1) * 50);
    }
    const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
    assert.ok(mean > PACE.targetLagMs * 0.6 && mean < PACE.targetLagMs * 1.4, `mean lag ${mean} ms`);
    const gaps = revealedAt.slice(1).map((t, i) => t - revealedAt[i]);
    assert.ok(Math.max(...gaps) <= PACE.maxStepMs + 25, `longest pause ${Math.max(...gaps)} ms`);
    const steps = m.host.firstElementChild!.getAttribute('data-steps')!.split(',').map(Number);
    for (const s of steps.slice(1)) assert.equal(text[s - 1], ' ', `step at ${s} splits a word`);
  } finally {
    await m.close();
  }
});

test('a reply that pauses shows what it held back once quiet for quietMs: its last word, a block that may be a link', async () => {
  clock.now = 0;
  const m = await mount('quiet', 'The turn is still going SLOW');
  try {
    await run(PACE.quietMs - 100);
    assert.equal(m.host.textContent, 'The turn is still going ', 'the last word may not be whole yet');
    // quiet from 1000 ms, shown one step after
    await run(clock.now + 100 + PACE.maxStepMs + 50);
    assert.equal(m.host.textContent, 'The turn is still going SLOW');
    assert.equal(timers.size, 0, 'nothing more to wait for');
    // a block that may become a link waits too, then shows
    await m.update('The turn is still going SLOW [cu: Done: click in Notes.]');
    await run(clock.now + PACE.quietMs - 100);
    assert.equal(m.host.textContent, 'The turn is still going SLOW ');
    // shown in steps, as a reply that finished with it open would be
    await run(clock.now + 100 + 2 * PACE.maxStepMs + 50);
    assert.equal(m.host.textContent, 'The turn is still going SLOW [cu: Done: click in Notes.]');
    // text after the pause paces again, holding back as before
    await m.update('The turn is still going SLOW [cu: Done: click in Notes.] and more wor');
    await run(clock.now + 300);
    assert.equal(m.host.textContent, 'The turn is still going SLOW [cu: Done: click in Notes.] and more ');
  } finally {
    await m.close();
  }
});

test("each step's time is recorded with it, on performance.now's clock, for its words' fades", async () => {
  clock.now = 0;
  const m = await mount('step-times', 'one two three four five six seven eight nine ten '.repeat(3));
  try {
    await run(400);
    const el = m.host.firstElementChild!;
    const steps = el.getAttribute('data-steps')!.split(',').map(Number);
    const times = el.getAttribute('data-step-times')!.split(',').map(Number);
    assert.ok(steps.length >= 2);
    assert.equal(times.length, steps.length);
    // each step showed after the one before it, all within the run so far
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1] && times[i] <= clock.now);
  } finally {
    await m.close();
  }
});

test('a delta arriving as the pacer catches up cannot strand the remaining commentary', async () => {
  clock.now = 0;
  const m = await mount('catch-up-delta', '我去查用户');
  const full = '我去查用户发消息和授权后，为什么这轮仍被判成无人值守。';
  try {
    // the pacer catches up and stops; another delta then has to wake it
    await run(500);
    assert.equal(m.host.textContent, '我去查用户');
    assert.equal(timers.size, 0);
    await m.update(full);
    await run(2000);
    assert.equal(m.host.textContent, full);
  } finally {
    await m.close();
  }
});

test('completion shows the backlog in quick small steps within about finishMs, not at once, and keeps streaming until then', async () => {
  clock.now = 0;
  const text = 'Final reply with a substantial reveal backlog. '.repeat(100);
  const m = await mount('complete-backlog', text);
  try {
    await run(100);
    assert.ok(m.host.textContent!.length < text.length);
    await m.update(text, false);
    assert.equal(m.host.firstElementChild!.getAttribute('data-streaming'), 'true', 'still revealing after the reply ended');
    const lengths: number[] = [];
    const end = clock.now + 2000;
    for (let t = clock.now + 25; m.host.textContent!.length < text.length && t < end; t += 25) {
      await tick(t);
      lengths.push(m.host.textContent!.length);
    }
    assert.equal(m.host.textContent, text);
    // in small steps, within about finishMs
    assert.ok(lengths.length * 25 <= PACE.finishMs + 100, `finished after ${lengths.length * 25} ms`);
    assert.ok(new Set(lengths).size >= 10, `${new Set(lengths).size} steps`);
    assert.equal(m.host.firstElementChild!.getAttribute('data-streaming'), 'false');
    await run(clock.now + PACE.minStepMs);
    assert.equal(timers.size, 0, 'nothing left to step');
    await m.update(text + ' Late authoritative correction.', false);
    await run(clock.now + 500);
    assert.equal(m.host.textContent, text + ' Late authoritative correction.');
  } finally {
    await m.close();
  }
});

test('completion in a hidden window shows everything at once', async () => {
  clock.now = 0;
  const text = 'Final reply with a backlog. '.repeat(50);
  const m = await mount('complete-hidden', text);
  try {
    await run(100);
    await setVisibility('hidden');
    await m.update(text, false);
    assert.equal(m.host.textContent, text);
    assert.equal(timers.size, 0);
  } finally {
    await m.close();
    await setVisibility('visible');
  }
});

test('a finished reply that unmounts before its last steps is whole when it mounts again', async () => {
  clock.now = 0;
  const text = 'Reply that ends while it still has a backlog to show. '.repeat(10);
  const first = await mount('drain-remount', text);
  await run(100);
  await first.update(text, false);
  assert.ok(first.host.textContent!.length < text.length);
  await first.close();
  const next = await mount('drain-remount', text, {});
  try {
    assert.equal(next.host.textContent, text);
    assert.equal(next.host.firstElementChild!.getAttribute('data-animate'), 'false');
  } finally {
    await next.close();
  }
});

test('changing motion preferences reveals the backlog without replaying or hiding text', async () => {
  clock.now = 0;
  const text = 'Streamed response with a backlog. '.repeat(20);
  const m = await mount('motion-changes', text);
  try {
    await run(100);
    assert.ok(m.host.textContent!.length < text.length);
    await act(() => {
      media.matches = true;
      media.dispatchEvent(new window.Event('change'));
    });
    assert.equal(m.host.textContent, text);
    assert.equal(timers.size, 0);
    await act(() => {
      media.matches = false;
      media.dispatchEvent(new window.Event('change'));
    });
    assert.equal(m.host.textContent, text);
    await tick(clock.now);
    assert.equal(timers.size, 0, 'nothing to show: the pacer waits for text');
    await m.update(text + 'New streamed text.');
    assert.equal(timers.size, 1);
    await m.update(text + 'New streamed text.', false);
    await run(clock.now + 600);
    assert.equal(m.host.textContent, text + 'New streamed text.');
  } finally {
    await m.close();
    media.matches = false;
  }
});

test('a hidden window shows arriving text at once and schedules no steps', async () => {
  clock.now = 0;
  await setVisibility('hidden');
  const m = await mount('background-reply', '第一段');
  try {
    await m.update(LONG);
    assert.equal(m.host.textContent, LONG);
    assert.equal(timers.size, 0);
    // word fades still apply, so showing the window again does not fade the whole reply in
    assert.equal(m.host.firstElementChild!.getAttribute('data-animate'), 'true');
  } finally {
    await m.close();
    await setVisibility('visible');
  }
});

test('a visible window paces the same reply, with or without focus', async () => {
  clock.now = 0;
  await setFocused(false);
  const m = await mount('foreground-reply', '');
  try {
    await m.update(LONG);
    await run(200);
    const shown = m.host.textContent!;
    assert.ok(shown.length > 0 && shown.length < LONG.length, `showed ${shown.length}`);
    assert.ok(LONG.startsWith(shown));
  } finally {
    await m.close();
    await setFocused(true);
  }
});

test('hiding the window mid-reply shows the rest; showing it paces on from there; blurring changes nothing', async () => {
  clock.now = 0;
  const m = await mount('visibility-mid-stream', '');
  try {
    await m.update(LONG);
    await run(200);
    assert.ok(m.host.textContent!.length < LONG.length);
    await setVisibility('hidden');
    assert.equal(m.host.textContent, LONG);
    assert.equal(timers.size, 0);
    const more = LONG + '後半 🇯🇵 '.repeat(30);
    await m.update(more);
    assert.equal(m.host.textContent, more);
    await setVisibility('visible');
    // nothing that was shown goes away
    assert.equal(m.host.textContent, more);
    const tail = more + 'and the rest arrives paced again. '.repeat(10);
    await m.update(tail);
    await run(clock.now + 200);
    const paced = m.host.textContent!;
    assert.ok(paced.length >= more.length && paced.length < tail.length, `showed ${paced.length} of ${tail.length}`);
    await setFocused(false);
    assert.equal(m.host.textContent, paced, 'losing focus keeps pacing');
    await setFocused(true);
    await m.update(tail, false);
    await run(clock.now + 1000);
    assert.equal(m.host.textContent, tail);
  } finally {
    await m.close();
    await setVisibility('visible');
    await setFocused(true);
  }
});
