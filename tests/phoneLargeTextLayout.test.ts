// At large text sizes words get room instead of being cut: a row's state goes under its name, a chat's title takes two lines, and the model pill gives way before the send end leaves the composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const groupedPath = '../mobile/src/components/Grouped';
const rowPath = '../mobile/src/components/ChatRow';
const sessionPath = '../mobile/src/components/SessionRow';
const boxPath = '../mobile/src/components/ComposerBox';
const largePath = '../mobile/src/useLargeText';
const { Group, GroupItem } = await import(groupedPath);
const { ChatRow } = await import(rowPath);
const { SessionRow } = await import(sessionPath);
const { LARGE_TEXT } = await import(largePath);

async function mount(node: any, scale: number) {
  (globalThis as any).__phoneFontScale = scale;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      delete (globalThis as any).__phoneFontScale;
    },
  };
}
const spanOf = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].find((n) => n.textContent === text)!;
const lines = (el: Element) => el.getAttribute('numberoflines') ?? el.getAttribute('numberOfLines');

test("a row's state word sits beside its name at the usual sizes and under it at large text", async () => {
  const item = createElement(Group, null, createElement(GroupItem, { title: 'DUs-MacBook-Pro', value: 'Connected', onPress: () => {} }));
  const usual = await mount(item, 1);
  assert.notEqual(spanOf(usual.host, 'DUs-MacBook-Pro').parentElement, spanOf(usual.host, 'Connected').parentElement, 'beside it');
  await usual.done();
  const large = await mount(item, 2.4);
  assert.equal(
    spanOf(large.host, 'DUs-MacBook-Pro').parentElement,
    spanOf(large.host, 'Connected').parentElement,
    'under it, in its column',
  );
  assert.equal(large.host.querySelectorAll('span').length, 2, 'drawn once');
  await large.done();
  // a row without a state has nothing to move
  const bare = await mount(createElement(Group, null, createElement(GroupItem, { title: 'Add a computer', onPress: () => {} })), 2.4);
  assert.ok(spanOf(bare.host, 'Add a computer'));
  await bare.done();
});

test('a chat title takes two lines at large text and one otherwise', async () => {
  const chat = { id: 'c', title: 'Fix the discount rounding in checkout' };
  const node = createElement(ChatRow, { chat, open: () => {} });
  const usual = await mount(node, 1);
  assert.equal(lines(spanOf(usual.host, chat.title)), '1');
  await usual.done();
  const large = await mount(node, LARGE_TEXT);
  assert.equal(lines(spanOf(large.host, chat.title)), '2');
  await large.done();
  const below = await mount(node, LARGE_TEXT - 0.01);
  assert.equal(lines(spanOf(below.host, chat.title)), '1', 'the standard sizes stay one line');
  await below.done();
});

test("a session row's title takes two lines at large text too", async () => {
  const node = createElement(SessionRow, { title: 'Draft the changelog entry', state: 'idle', detail: '4h', onPress: () => {} });
  const usual = await mount(node, 1);
  assert.equal(lines(spanOf(usual.host, 'Draft the changelog entry')), '1');
  await usual.done();
  const large = await mount(node, 2.4);
  assert.equal(lines(spanOf(large.host, 'Draft the changelog entry')), '2');
  await large.done();
});

test('the model pill gives way, so the send end stays in the box', async () => {
  const { ModelPill } = await import(boxPath);
  const pill = await mount(createElement(ModelPill, { model: 'Dev Fast', detail: 'Low', onPress: () => {} }), 2.4);
  const style = JSON.parse(pill.host.querySelector('[data-style]')!.getAttribute('data-style') ?? '{}');
  assert.equal(style.flexShrink, 1, 'it may be cut shorter than its words');
  assert.equal(style.minWidth, 0, 'and is not held open by them');
  const words = JSON.parse(spanOf(pill.host, 'Dev Fast').getAttribute('data-style') ?? '{}');
  assert.equal(words.flexShrink, 1, 'the name ends in … rather than overflowing the pill');
  assert.equal(lines(spanOf(pill.host, 'Dev Fast')), '1');
  await pill.done();
});
