// The amber "Saved on this phone" line is drawn over the list's top edge with room kept for it (#5379 row A): its going changes neither the list's frame nor its padding, so a reader at the top of the saved rows does not move; the room is its measured height, it is read before the rows, and another chat starts without it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { Thread, at, KEY, memory, mounted, rig, rows, wait } from './support/phone/pages-kit';
import { fakeDraft } from './support/phone/drafts';
const noticePath = '../mobile/src/components/Notice';
const { SAVED_ON_PHONE } = await import(noticePath);

afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
});

const paintOf = (from: number, n: number) =>
  rows(from, n).map((r) => ({ key: JSON.stringify(['item', r.id]), role: r.role, text: r.text }));
/** The view that holds the line (the one whose layout the screen measures), or null. */
const lineView = (host: HTMLElement) =>
  ([...host.querySelectorAll('*')].find((e: any) => e.__onLayout && e.textContent === SAVED_ON_PHONE) as any) ?? null;
/** The list's top padding, as its content asks for it. */
const paddingTop = () => {
  const style = [(globalThis as any).__scrollEvents.contentContainerStyle].flat(Infinity).filter(Boolean);
  return Object.assign({}, ...style).paddingTop;
};
const list = (host: HTMLElement) => host.querySelector('[data-scrollview="true"]')!;

test('the line goes over the list, keeps its measured room, and its going changes neither the list nor the row being read (a reader at the top of the saved rows)', async () => {
  const { pages, rowCache } = memory(paintOf(270, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = rig(300);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  mounted.push(root);
  const drafts = fakeDraft('');
  const show = (offline: boolean, chatId = 'c') =>
    act(async () => root.render(createElement(Thread, { runtime, chatId, back: () => {}, drafts, historyKey: KEY, rowCache, offline })));
  await show(true);
  await wait(80);
  const line = lineView(host);
  assert.ok(line, 'asleep: the line shows');
  // over the list, before it in the screen's order (VoiceOver reads it first), and not in the body above the list
  assert.equal(line.parentElement, list(host).parentElement, 'a sibling of the list, over it');
  assert.ok(line.compareDocumentPosition(list(host)) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the rows');
  assert.equal(paddingTop(), 16, 'no room before it was measured');
  await act(async () => line.__onLayout({ nativeEvent: { layout: { height: 36 } } }));
  assert.equal(paddingTop(), 16 + 36, 'the room is its measured height, so scrolled to the top no row is under it');
  // a layout that measures the same changes nothing
  await act(async () => lineView(host).__onLayout({ nativeEvent: { layout: { height: 36 } } }));
  assert.equal(paddingTop(), 16 + 36);
  // larger text makes it taller: the room follows the measure
  await act(async () => lineView(host).__onLayout({ nativeEvent: { layout: { height: 58 } } }));
  assert.equal(paddingTop(), 16 + 58);

  const frame = list(host).parentElement!.getAttribute('data-style');
  const reading = at(host, 100);
  assert.ok(reading, 'a row near the top of the saved rows');
  await show(false);
  await wait(120);
  assert.equal(lineView(host), null, 'awake: the line has gone');
  assert.equal(paddingTop(), 16 + 58, 'the room stays: nothing above the rows changed');
  assert.equal(list(host).parentElement!.getAttribute('data-style'), frame, 'the list’s frame is the same');
  assert.equal(at(host, 100), reading, 'the row being read is the same view');

  // another chat starts with no room
  await show(false, 'd');
  await wait(20);
  assert.equal(paddingTop(), 16);
});
