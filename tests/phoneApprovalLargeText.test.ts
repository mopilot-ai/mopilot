// At a large text size an approval card's choices stack and their labels wrap, so "Allow once" is never cut to "Allo…".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const cardPath = '../mobile/src/components/ApprovalCard';
const { ApprovalCard } = await import(cardPath);

async function show(fontScale: number) {
  (globalThis as any).__phoneFontScale = fontScale;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const card = {
    id: 'a1',
    rev: 1,
    title: 'Run this command?',
    detail: 'git status --short',
    choices: [
      { key: 'once', label: 'Allow once' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  };
  await act(async () => root.render(createElement(ApprovalCard, { card, answer: async () => true })));
  await flush();
  const spans = [...host.querySelectorAll('span')];
  const label = (text: string) => spans.find((n) => n.textContent === text)!;
  const lines = (n: Element) => n.getAttribute('numberoflines') ?? n.getAttribute('numberOfLines');
  const styleOf = (el: Element | null) => JSON.parse((el as HTMLElement).dataset.style ?? '{}');
  const pills = { allow: label('Allow once'), deny: label('Deny') };
  const out = { lines, styleOf, pills, row: pills.allow.parentElement!.parentElement! };
  const done = async () => {
    (globalThis as any).__phoneFontScale = undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  return { ...out, done };
}

test('at the standard size the two choices share one row and their labels are cut to one line', async () => {
  const v = await show(1);
  assert.equal(v.lines(v.pills.allow), '1');
  assert.equal(v.styleOf(v.row).flexDirection, 'row');
  assert.equal(v.styleOf(v.pills.allow.parentElement).flex, 1);
  await v.done();
});

test('at a large size the choices stack, each takes the row, and the labels wrap', async () => {
  const v = await show(2);
  assert.equal(v.lines(v.pills.allow), null, 'Allow once is not cut');
  assert.equal(v.lines(v.pills.deny), null);
  assert.equal(v.styleOf(v.row).flexDirection, 'column');
  assert.equal(v.styleOf(v.pills.allow.parentElement).alignSelf, 'stretch');
  await v.done();
});
