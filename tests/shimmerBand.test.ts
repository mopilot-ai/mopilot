// A shimmering label's band (src/components/ui/ShimmerBand.tsx): an empty, hidden layer that starts on the phase every
// band shares and keeps it across re-renders, so labels sweep together and a remounted one resumes mid-sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ShimmerBand, ShimmerSpan, SHIMMER_SWEEP_MS } = await import('../src/components/ui/ShimmerBand.tsx');

async function mount(t: any, element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(() => root.render(element));
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  return { host, render: (next: any) => act(() => root.render(next)) };
}

function withClock(t: any, now: number) {
  const clock = { now };
  t.mock.method(performance, 'now', () => clock.now);
  return clock;
}

const delay = (el: Element) => (el as HTMLElement).style.getPropertyValue('--shimmer-delay');

test('the band is an empty hidden layer whose delay puts it on the shared sweep phase', async (t) => {
  withClock(t, 7 * SHIMMER_SWEEP_MS + 1234.4);
  const { host } = await mount(t, h('span', { className: 'shimmer-text' }, 'Login bug', h(ShimmerBand)));
  const band = host.querySelector('.shimmer-band')!;
  assert.equal(band.getAttribute('aria-hidden'), 'true');
  assert.equal(band.textContent, '');
  assert.equal(host.querySelector('.shimmer-text')!.textContent, 'Login bug');
  assert.equal(delay(band), '-1234ms');
});

test('the phase is read once: a later render keeps it, a remount takes the clock again', async (t) => {
  const clock = withClock(t, 500);
  const view = await mount(t, h('span', null, 'a', h(ShimmerBand, { key: 1 })));
  clock.now = 2900;
  await view.render(h('span', null, 'b', h(ShimmerBand, { key: 1 })));
  assert.equal(delay(view.host.querySelector('.shimmer-band')!), '-500ms');
  await view.render(h('span', null, 'b', h(ShimmerBand, { key: 2 })));
  assert.equal(delay(view.host.querySelector('.shimmer-band')!), '-2900ms');
});

// #4654: a shimmering label masks its own glyphs (mask-clip: text). The mask of an element whose words changed in place kept
// the old words' glyph shapes, so the new words showed only inside them: a smear after the first words. A new label is a
// new element, whose mask is painted fresh.
const label = (text: any, props: Record<string, unknown> = {}) =>
  h(ShimmerSpan as any, { className: 'claude-activity-label', ...props }, text);

test('a new label is a new element with the words and one band; the old element is gone', async (t) => {
  const clock = withClock(t, 100);
  const view = await mount(t, label('Searching the web for Bosch 800 Series 36'));
  const first = view.host.querySelector('.shimmer-text')!;
  assert.equal(first.className, 'claude-activity-label shimmer-text');
  assert.equal(first.textContent, 'Searching the web for Bosch 800 Series 36');
  assert.equal(delay(first.querySelector('.shimmer-band')!), '-100ms');
  clock.now = 1300;
  await view.render(label('Checking whether the Cafe 36 in smart induction cooktop is available'));
  const second = view.host.querySelector('.shimmer-text')!;
  assert.notEqual(second, first, 'new words, new element');
  assert.equal(first.isConnected, false);
  assert.equal(view.host.querySelectorAll('.shimmer-text').length, 1);
  assert.equal(second.textContent, 'Checking whether the Cafe 36 in smart induction cooktop is available');
  assert.equal(second.querySelectorAll('.shimmer-band').length, 1);
  // the band takes the shared clock's phase, so the sweep carries on across the change
  assert.equal(delay(second.querySelector('.shimmer-band')!), '-1300ms');
});

test('rapid label changes leave one clean element: no stale style, class or second band', async (t) => {
  const view = await mount(t, label('first'));
  for (const words of ['Reading a.ts', 'Editing b.ts', 'Running tests', 'Writing the final list', 'Reading a.ts'])
    await view.render(label(words));
  const all = view.host.querySelectorAll('*');
  assert.deepEqual(
    [...all].map((el) => el.tagName),
    ['SPAN', 'SPAN'],
    'the label and its band, nothing left from the earlier labels',
  );
  const span = view.host.querySelector('span')!;
  assert.equal(span.getAttribute('style'), null);
  assert.equal(span.className, 'claude-activity-label shimmer-text');
  assert.equal(span.textContent, 'Reading a.ts');
});

test('the same words keep their element and their band phase', async (t) => {
  const clock = withClock(t, 400);
  const view = await mount(t, label('Reading a.ts'));
  const first = view.host.querySelector('.shimmer-text')!;
  clock.now = 2000;
  await view.render(label('Reading a.ts'));
  assert.equal(view.host.querySelector('.shimmer-text'), first);
  assert.equal(delay(first.querySelector('.shimmer-band')!), '-400ms');
});

test('words that are nodes have no key: the element stays across renders', async (t) => {
  const view = await mount(t, label(h('b', null, 'one')));
  const first = view.host.querySelector('.shimmer-text')!;
  await view.render(label(h('b', null, 'two')));
  assert.equal(view.host.querySelector('.shimmer-text'), first);
  assert.equal(first.textContent, 'two');
});

test("the shimmer class and the element class are the caller's; off is plain words with no band", async (t) => {
  const view = await mount(t, h(ShimmerSpan as any, { shimmer: 'shimmer' }, 'Thinking'));
  assert.equal(view.host.querySelector('span')!.className, 'shimmer');
  await view.render(label('Done', { on: false }));
  const off = view.host.querySelector('span')!;
  assert.equal(off.className, 'claude-activity-label');
  assert.equal(off.querySelector('.shimmer-band'), null);
  await view.render(h(ShimmerSpan as any, { on: false }, 'Bare'));
  assert.equal(view.host.querySelector('span')!.getAttribute('class'), null);
  await view.render(h(ShimmerSpan as any, null, 'Bare'));
  assert.equal(view.host.querySelector('span')!.className, 'shimmer-text');
});

const resume = (el: Element) => (el as HTMLElement).style.getPropertyValue('--shimmer-resume');

test('a cadenced label resumes its timeline across a new element: 600 ms in at first, then where the label has run to', async (t) => {
  const clock = withClock(t, 1000);
  const view = await mount(t, label('Reading a.ts', { shimmer: 'shimmer' }));
  assert.equal(resume(view.host.querySelector('.shimmer-band')!), '600ms');
  clock.now = 3000;
  await view.render(label('Reading b.ts', { shimmer: 'shimmer' }));
  assert.equal(view.host.querySelector('.shimmer')!.textContent, 'Reading b.ts');
  assert.equal(resume(view.host.querySelector('.shimmer-band')!), '-1400ms', '2000 ms into the label, its sweep was due 600 ms in');
});

test('a band with no label timeline sets only the shared-clock delay', async (t) => {
  withClock(t, 250);
  const view = await mount(t, h('span', null, 'a', h(ShimmerBand)));
  const band = view.host.querySelector('.shimmer-band')!;
  assert.equal(delay(band), '-250ms');
  assert.equal(resume(band), '');
});

test('words made of text and numbers are the key, however they are written; a node leaves no key', async (t) => {
  const view = await mount(t, h(ShimmerSpan as any, null, 'Running ', 'npm test'));
  const first = view.host.querySelector('.shimmer-text')!;
  await view.render(h(ShimmerSpan as any, null, 'Running ', 'npm test'));
  assert.equal(view.host.querySelector('.shimmer-text'), first, 'the same words in pieces keep the element');
  await view.render(h(ShimmerSpan as any, null, 'Running ', 'npm build'));
  const second = view.host.querySelector('.shimmer-text')!;
  assert.notEqual(second, first);
  assert.equal(second.textContent, 'Running npm build');
  await view.render(h(ShimmerSpan as any, null, 3));
  const third = view.host.querySelector('.shimmer-text')!;
  assert.notEqual(third, second);
  await view.render(h(ShimmerSpan as any, null, 'Running ', h('b', null, 'x')));
  const fourth = view.host.querySelector('.shimmer-text')!;
  await view.render(h(ShimmerSpan as any, null, 'Running ', h('b', null, 'y')));
  assert.equal(view.host.querySelector('.shimmer-text'), fourth);
});
