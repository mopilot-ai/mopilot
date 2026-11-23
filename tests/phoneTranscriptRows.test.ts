// The transcript's rows as Claude draws them: the reply in serif revealed whole blocks at a time, your grey bubble, and quiet step rows.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
const bubblePath = '../mobile/src/components/MessageBubble';
const markdownPath = '../mobile/src/components/Markdown';
const { MessageBubble, StepRow, stepParts } = await import(bubblePath);
const { Markdown } = await import(markdownPath);

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
const span = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].filter((n) => n.textContent === text).at(-1);

test('the reply is New York at 17 pt, full width; your message is a 17 pt grey bubble', async () => {
  const v = await mount(
    createElement('div', null, [
      createElement(MessageBubble, { key: 'a', role: 'assistant', text: 'A reply.\n\n# Head' }),
      createElement(MessageBubble, { key: 'u', role: 'user', text: 'Mine' }),
    ]),
  );
  assert.equal(styleOf(span(v.host, 'A reply.')).fontFamily, 'ui-serif');
  assert.equal(styleOf(span(v.host, 'A reply.')).fontSize, 17);
  assert.equal(styleOf(span(v.host, 'Head')).fontFamily, 'ui-serif', 'headings share the prose face');
  const reply = span(v.host, 'A reply.')!.closest('[data-style*="alignSelf"]')!;
  assert.equal(styleOf(reply).alignSelf, 'stretch');
  const mine = span(v.host, 'Mine')!;
  assert.equal(styleOf(mine).fontSize, 17);
  const bubble = mine.closest('[data-style*="borderRadius"]');
  assert.equal(styleOf(bubble).borderRadius, 22);
  assert.equal(styleOf(bubble).maxWidth, '82%');
  // a card's Markdown keeps the sans body, and no fade
  const card = await mount(createElement(Markdown, { text: 'Plain.' }));
  assert.equal(styleOf(span(card.host, 'Plain.')).fontFamily, undefined);
  assert.equal(card.host.querySelector('[data-entering]'), null);
  await card.done();
  await v.done();
});

test('a streaming reply reveals in steps whose new words fade in once, and shows all of it when done', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 16) as unknown as number;
  try {
    const row = (text: string, streaming: boolean) => createElement(MessageBubble, { id: 'r', role: 'preview', text, streaming });
    const faded = (host: HTMLElement) =>
      [...host.querySelectorAll('span')].filter((n) => /rgba\(/.test(n.getAttribute('data-style') ?? ''));
    const v = await mount(row('Intro', true));
    assert.match(v.host.textContent!, /Intro/, 'what was there when it mounted shows at once');
    assert.equal(faded(v.host).length, 0, 'and does not fade');
    const more = 'Intro and then a long second sentence that keeps on going for a while longer. Third sentence here too.';
    await act(async () => v.root.render(row(more, true)));
    for (let i = 0; i < 8; i++) await act(async () => mock.timers.tick(20)); // the first step waits its lag
    const early = v.host.textContent!;
    assert.ok(early.length > 'Intro'.length && early.length < more.length, 'a burst shows in steps, not whole');
    assert.ok(faded(v.host).length > 0, 'the words of the newest step are mid-fade');
    assert.doesNotMatch(
      faded(v.host)
        .map((n) => n.textContent)
        .join(''),
      /^Intro/,
      'shown text is not faded again',
    );
    await act(async () => v.root.render(row(more, false)));
    assert.ok(faded(v.host).length > 0, 'completion keeps the ongoing fade while the pacer drains');
    for (let i = 0; i < 40; i++) await act(async () => mock.timers.tick(50));
    assert.equal(v.host.textContent, more);
    assert.equal(faded(v.host).length, 0, 'every word is opaque once the fades end');
    await v.done();
  } finally {
    globalThis.requestAnimationFrame = raf;
    mock.timers.reset();
  }
});

test('Reduce Motion disables word and nested-code fades without losing the reply', async () => {
  (globalThis as any).__phoneReduceMotion = true;
  try {
    const text = 'Intro\n\n- item\n\n  ```ts\n  const x = 1;\n  ```\n\n> ```\n> quoted\n> ```';
    const v = await mount(createElement(Markdown, { text, fade: true, steps: [{ at: 0, time: Date.now() }] }));
    assert.match(v.host.textContent!, /const x = 1;/);
    assert.equal(v.host.querySelector('[data-entering]'), null);
    assert.equal(v.host.querySelector('[data-style*="rgba("]'), null);
    await v.done();
  } finally {
    (globalThis as any).__phoneReduceMotion = false;
  }
});

test('code arriving inside lists and quotes follows the whole-code fade policy', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const text = '- item\n\n  ```ts\n  const x = 1;\n  ```\n\n> ```\n> quoted\n> ```';
    const v = await mount(createElement(Markdown, { text, fade: true, steps: [{ at: 0, time: Date.now() }] }));
    assert.equal(v.host.querySelectorAll('[data-entering="FadeIn"]').length, 2);
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('a new keyed reply starts independently after the previous turn finishes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const row = (id: string, text: string, streaming: boolean) =>
      createElement(MessageBubble, { key: id, id, role: 'preview', text, streaming });
    const v = await mount(row('first', 'Completed turn.', false));
    await act(async () => v.root.render(row('second', 'New ', true)));
    assert.equal(v.host.textContent, 'New');
    const text = `New ${'reply words '.repeat(30)}`;
    await act(async () => v.root.render(row('second', text, true)));
    for (let i = 0; i < 8; i++) await act(async () => mock.timers.tick(20));
    assert.ok(v.host.textContent!.length > 4 && v.host.textContent!.length < text.length);
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('a step is one quiet line, its subject in mono, and a tap shows all of it', async () => {
  assert.deepEqual(stepParts('Edited auth/callback.ts'), { verb: 'Edited', subject: 'auth/callback.ts' });
  assert.deepEqual(stepParts('Searched for x y'), { verb: 'Searched for', subject: 'x y' });
  assert.deepEqual(stepParts('Thought for 3s'), { verb: 'Thought for 3s', subject: '' });
  const v = await mount(createElement(StepRow, { text: 'Ran npm test -- auth' }));
  const row = v.host.querySelector('button')!;
  assert.equal(row.getAttribute('aria-label'), 'Activity: Ran npm test -- auth');
  assert.equal(styleOf(span(v.host, ' npm test -- auth')).fontFamily, 'Menlo');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  await act(async () => row.click());
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(span(v.host, 'Ran npm test -- auth')!.getAttribute('data-selectable'), 'true', 'an open step can be selected');
  const plain = await mount(createElement(StepRow, { text: 'Thought for 3s', label: 'Live activity: Thought for 3s' }));
  assert.equal(plain.host.querySelector('button')!.getAttribute('aria-label'), 'Live activity: Thought for 3s');
  assert.equal(plain.host.querySelectorAll('span[data-style*="Menlo"]').length, 0);
  await plain.done();
  await v.done();
});

test('a code block that arrives while the reply streams fades in whole, and one there at mount does not', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const row = (text: string) => createElement(MessageBubble, { id: 'r', role: 'preview', text, streaming: true });
    const code = '```ts\nconst a = 1;\n```';
    const v = await mount(row(`Intro\n\n${code}`));
    assert.equal(v.host.querySelector('[data-entering="FadeIn"]'), null, 'mounted blocks show at once');
    await act(async () =>
      v.root.render(row(`Intro\n\n${code}\n\nAfter the code the reply goes on for a while with more words.\n\n${code}`)),
    );
    for (let i = 0; i < 150; i++) await act(async () => mock.timers.tick(20));
    assert.ok(v.host.querySelector('[data-entering="FadeIn"]'), 'a block that arrives fades in');
    await v.done();
  } finally {
    mock.timers.reset();
  }
});

test('a streaming reply that stops growing shows what the reveal held back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const row = (text: string) => createElement(MessageBubble, { id: 'r', role: 'preview', text, streaming: true });
    const v = await mount(row('Intro'));
    await act(async () => v.root.render(row('Intro\n\nThe tool runs next')));
    for (let i = 0; i < 40; i++) await act(async () => mock.timers.tick(100));
    assert.match(v.host.textContent!, /The tool runs next/, 'shown once it has been still for a moment');
    await v.done();
  } finally {
    mock.timers.reset();
  }
});
