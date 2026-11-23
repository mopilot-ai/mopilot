// At a large text size the computer's card keeps its name: the "N need input" count goes under the words instead of taking the row's width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const cardsPath = '../mobile/src/components/ComputerCards';
const { ComputerCards } = await import(cardsPath);

async function card(fontScale: number, chats: { state?: string; hostId?: string }[]) {
  (globalThis as any).__phoneFontScale = fontScale;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ComputerCards, { machines: [], chats, offline: false })));
  await flush();
  const spans = [...host.querySelectorAll('span')];
  const waiting = spans.find((n) => /need input$/.test(n.textContent ?? ''));
  const out = { waiting, spans, lines: (n: Element | undefined) => n?.getAttribute('numberoflines') ?? n?.getAttribute('numberOfLines') };
  const done = async () => {
    (globalThis as any).__phoneFontScale = undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  return { ...out, done };
}

test('at the standard size the count sits at the right of the row and the words are cut to one line', async () => {
  const c = await card(1, [{ state: 'waiting' }, { state: 'waiting' }]);
  assert.ok(c.waiting, 'the count is shown');
  assert.equal(c.waiting!.textContent, '2 need input');
  const name = c.spans.find((n) => c.lines(n) === '1');
  assert.ok(name, 'the name is cut to one line');
  assert.ok(!name!.parentElement!.contains(c.waiting!), 'the count is beside the words, not among them');
  await c.done();
});

test('at a large size the words wrap and the count is under them, in the same column', async () => {
  const c = await card(2, [{ state: 'waiting' }]);
  assert.equal(c.waiting!.textContent, '1 need input');
  assert.ok(
    c.spans.every((n) => c.lines(n) === null || c.lines(n) === undefined),
    'no text is cut to one line',
  );
  const column = c.waiting!.parentElement!;
  assert.ok(column.textContent!.length > '1 need input'.length, 'the name and the line are in the column with the count');
  await c.done();
});

test('a card with nothing waiting shows no count at either size', async () => {
  for (const scale of [1, 2]) {
    const c = await card(scale, [{ state: 'idle' }]);
    assert.equal(c.waiting, undefined, `scale ${scale}`);
    await c.done();
  }
});
