// The live meter of a voice note: bars that follow the microphone's level, a timer, and nothing once the recording is over.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { fakeMedia } from './support/phone/m3';
const meterPath = '../mobile/src/remote/useMeter';
const voicePath = '../mobile/src/components/VoiceNote';
const { clock, BARS, EVERY_MS } = await import(meterPath);
const { VoiceNote } = await import(voicePath);

test('a recording is timed in whole seconds', () => {
  for (const [ms, text] of [
    [0, '0:00'],
    [999, '0:00'],
    [7_400, '0:07'],
    [65_000, '1:05'],
    [600_000, '10:00'],
    [-5, '0:00'],
  ] as const)
    assert.equal(clock(ms), text, String(ms));
});

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return { host, root };
}
const heights = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-style]')]
    .map((n) => JSON.parse(n.getAttribute('data-style')!))
    .filter((s) => s.width === 3)
    .map((s) => s.height);

test('while recording the bars rise with the level, the timer counts, and a flat meter is drawn when the device gives no level', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
  try {
    let level: number | null = 1;
    const { media } = fakeMedia();
    (media as any).level = () => level;
    const { host } = await mount(createElement(VoiceNote, { media, request: async () => ({}), caps: null, use: () => {} }));
    assert.equal(host.querySelector('[aria-label^="Recording"]'), null, 'nothing before it records');
    await click('Record voice note');
    assert.equal(host.querySelector('[aria-label="Recording, 0:00"]') !== null, true);
    assert.equal(heights(host).length, BARS);
    assert.ok(
      heights(host).every((h) => h === 3),
      'flat before the first bar',
    );
    await act(async () => mock.timers.tick(EVERY_MS * 2));
    level = null;
    await act(async () => mock.timers.tick(EVERY_MS));
    const h = heights(host);
    assert.deepEqual(h.slice(-3), [26, 26, 3], 'two loud moments, then a flat one for a missing level; the newest at the right');
    assert.equal(h.length, BARS);
    await act(async () => mock.timers.tick(1000));
    assert.match(host.textContent!, /0:01/);
    assert.ok(host.querySelector('[aria-label="Recording, 0:01"]'));
    // a long recording keeps the last bars only
    await act(async () => mock.timers.tick(EVERY_MS * (BARS + 10)));
    assert.equal(heights(host).length, BARS);
    await click('Cancel recording');
    assert.equal(host.querySelector('[aria-label^="Recording"]'), null, 'gone with the recording');
    await click('Record voice note');
    assert.ok(
      heights(host).every((h2) => h2 === 3),
      'a new recording starts flat, at 0:00',
    );
    assert.match(host.textContent!, /0:00/);
  } finally {
    mock.timers.reset();
  }
});
