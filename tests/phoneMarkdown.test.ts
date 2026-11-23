// A reply's Markdown on the phone, and its text revealed at Claude's pace while it streams.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
// through variables, so the desktop typecheck does not follow into React Native's global types
const markdownPath = '../mobile/src/components/Markdown';
const revealPath = '../mobile/src/useStreamReveal';
const bubblePath = '../mobile/src/components/MessageBubble';
const { Markdown } = await import(markdownPath);
const { useStreamReveal, useStreamRevealSteps } = await import(revealPath);
const { MessageBubble } = await import(bubblePath);
const catchUpPath = '../mobile/src/catchUp';
const { startCatchUp, catchingUp, CATCH_UP_MS, useCatchUpWhenBack } = await import(catchUpPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    root,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
/** The innermost text of that content (a paragraph holding only `bold` has the same text as its bold run). */
const span = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].filter((n) => n.textContent === text).at(-1);

test('headings, emphasis, code, lists, quotes, rules and links render as native text', async () => {
  const md = [
    '# Title',
    '### Small',
    'Plain **bold** *it* `code` [site](https://example.com) ![pic](https://example.com/a.png)  ',
    'next line',
    '',
    '- one',
    '- two',
    '',
    '3. three',
    '4. four',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '<div>raw</div>',
  ].join('\n');
  const v = await mount(createElement(Markdown, { text: md }));
  const text = v.host.textContent!;
  assert.match(text, /Title/);
  assert.equal(styleOf(span(v.host, 'Title')).fontSize, 22);
  assert.equal(styleOf(span(v.host, 'Small')).fontSize, 17);
  assert.equal(span(v.host, 'Title')!.getAttribute('role'), 'header');
  assert.equal(styleOf(span(v.host, 'bold')).fontWeight, '600');
  assert.equal(styleOf(span(v.host, 'it')).fontStyle, 'italic');
  assert.equal(styleOf(span(v.host, 'code')).fontFamily, 'Menlo');
  assert.match(text, /pic/, 'an image reads as its text');
  assert.match(text, /\nnext line/, 'a hard break is a new line');
  assert.match(text, /•one/);
  assert.match(text, /3\.three4\.four/, 'an ordered list counts from its start');
  assert.match(text, /quoted/);
  assert.match(text, /const x = 1;/);
  assert.match(text, /<div>raw<\/div>/, 'raw HTML shows as its text');
  (globalThis as any).__openedUrls = [];
  await act(async () => (span(v.host, 'site') as HTMLElement).click());
  (globalThis as any).__linkFails = true;
  await act(async () => (span(v.host, 'site') as HTMLElement).click());
  (globalThis as any).__linkFails = false;
  assert.deepEqual(
    (globalThis as any).__openedUrls,
    ['https://example.com', 'https://example.com'],
    'a link that cannot open fails quietly',
  );
  await v.done();
});

test('a block the renderer does not draw shows its text', async () => {
  // a definition has neither children nor a value: it shows nothing rather than failing
  const v = await mount(createElement(Markdown, { text: 'Use [x] ![shot][x].\n\n[x]: https://example.com' }));
  assert.match(v.host.textContent!, /Use x shot\./);
  await v.done();
});

test('your messages stay plain text; replies are Markdown', async () => {
  const v = await mount(
    createElement('div', null, [
      createElement(MessageBubble, { key: 'u', role: 'user', text: '**not bold**' }),
      createElement(MessageBubble, { key: 'a', role: 'assistant', text: '**bold**' }),
    ]),
  );
  assert.match(v.host.textContent!, /\*\*not bold\*\*/);
  assert.equal(styleOf(span(v.host, 'bold')).fontWeight, '600');
  await v.done();
});

test('later reference definitions invalidate the parsed meaning of an unchanged earlier block', async () => {
  const initial = 'Read [docs][ref].\n\nMore words.';
  const v = await mount(createElement(Markdown, { text: initial }));
  const final = `${initial}\n\n[ref]: https://example.com`;
  await act(async () => v.root.render(createElement(Markdown, { text: final })));
  const fresh = await mount(createElement(Markdown, { text: final }));
  assert.equal(v.host.textContent, fresh.host.textContent);
  assert.match(v.host.textContent!, /Read docs\./);
  await fresh.done();
  await v.done();
});

test('a correction clears obsolete reveal offsets before the same reply grows again', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let current: { shown: string; steps: { at: number; time: number }[] };
  const Probe = ({ text }: { text: string }) => {
    current = useStreamRevealSteps('corrected', text, true);
    return null;
  };
  try {
    const v = await mount(createElement(Probe, { text: 'Intro ' }));
    await act(async () => v.root.render(createElement(Probe, { text: 'Intro and more words '.repeat(10) })));
    for (let i = 0; i < 10; i++) await act(async () => mock.timers.tick(25));
    assert.ok(current!.steps.length > 0);
    await act(async () => v.root.render(createElement(Probe, { text: 'Hi ' })));
    assert.equal(current!.steps.length, 0);
    await act(async () => v.root.render(createElement(Probe, { text: 'Hi and a fresh continuation '.repeat(10) })));
    for (let i = 0; i < 10; i++) await act(async () => mock.timers.tick(25));
    assert.equal(current!.steps[0].at, 3);
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('text there at mount shows whole; text that arrives is shown in even steps, and a finished reply drains', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    let shown = '';
    const Probe = ({ text, streaming }: { text: string; streaming: boolean }) => {
      shown = useStreamReveal('r', text, streaming);
      return null;
    };
    const first = 'Hello there. ';
    const v = await mount(createElement(Probe, { text: first, streaming: true }));
    assert.equal(shown, first, 'what was there when it mounted is not replayed');
    const more = `${first}${'word '.repeat(40)}`;
    await act(async () => v.root.render(createElement(Probe, { text: more, streaming: true })));
    const lengths: number[] = [];
    for (let i = 0; i < 12; i++) {
      await act(async () => mock.timers.tick(25));
      lengths.push(shown.length);
    }
    assert.ok(lengths[lengths.length - 1] > first.length, 'it moves forward');
    assert.ok(lengths[lengths.length - 1] < more.length, 'but not all at once');
    assert.ok(more.startsWith(shown));
    // the reply finished: the rest shows within about PACE.finishMs
    await act(async () => v.root.render(createElement(Probe, { text: more, streaming: false })));
    for (let i = 0; i < 40; i++) await act(async () => mock.timers.tick(25));
    assert.equal(shown, more);
    // an open construct waits for its close, and shows once the reply has been quiet for a while
    const open = `${more}see [the docs](https://exa`;
    await act(async () => v.root.render(createElement(Probe, { text: open, streaming: true })));
    for (let i = 0; i < 8; i++) await act(async () => mock.timers.tick(25));
    assert.ok(shown.length < open.length, 'a half-written link is held back');
    for (let i = 0; i < 12; i++) await act(async () => mock.timers.tick(100));
    assert.equal(shown, open, 'and shown after the pause');
    // a reply that shrinks (corrected) shows the shorter text
    await act(async () => v.root.render(createElement(Probe, { text: first, streaming: false })));
    assert.equal(shown, first);
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('back in front after being away, what arrived shows at once with no fade, and the pacing is back after the window', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  try {
    let current: { shown: string; steps: unknown[] } = { shown: '', steps: [] };
    const Probe = ({ text }: { text: string }) => {
      current = useStreamRevealSteps('away', text, true);
      return null;
    };
    const first = 'Hello there. ';
    const v = await mount(createElement(Probe, { text: first }));
    assert.equal(catchingUp(), false);
    startCatchUp();
    assert.equal(catchingUp(), true);
    const more = `${first}${'word '.repeat(80)}`;
    await act(async () => v.root.render(createElement(Probe, { text: more })));
    assert.equal(current.shown, more, 'the whole backlog is there at once');
    assert.deepEqual(current.steps, [], 'with no word to fade');
    // after the window the pacing is back
    await act(async () => mock.timers.tick(CATCH_UP_MS + 1));
    const evenMore = `${more}${'again '.repeat(80)}`;
    await act(async () => v.root.render(createElement(Probe, { text: evenMore })));
    assert.ok(current.shown.length < evenMore.length, 'new text is paced again');
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('the catch-up starts when the computer is back after it was away, not on the first render or while it stays away', async () => {
  startCatchUp(0);
  const Probe = ({ away }: { away: boolean }) => {
    useCatchUpWhenBack(away);
    return null;
  };
  const v = await mount(createElement(Probe, { away: false }));
  assert.equal(catchingUp(), false, 'nothing was lost');
  await act(async () => v.root.render(createElement(Probe, { away: true })));
  assert.equal(catchingUp(), false, 'while it is away');
  await act(async () => v.root.render(createElement(Probe, { away: false })));
  assert.equal(catchingUp(), true, 'back');
  startCatchUp(0);
  await v.done();
});
