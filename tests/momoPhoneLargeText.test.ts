// MoMo's phone screens at the largest text size: every action of the state cards is inside the scrolling page (reachable by scrolling, never in a clipped band), the header pill and the tab labels are cut to one line instead of running off or fusing, and an empty composer is one line high however long its placeholder is.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { find, homeIs, mount, tap, unmountAll } from './support/phone/momo-screens';
import { act } from './support/phone/component-kit';

const g = globalThis as any;
const LARGEST = 3.1;
afterEach(async () => {
  g.__phoneFontScale = undefined;
  await unmountAll();
});

const lines = (n: Element | null | undefined) => n?.getAttribute('numberoflines') ?? n?.getAttribute('numberOfLines');
const inScroll = (label: string) => !!find(label)?.closest('[data-scrollview="true"]');

test('the asleep card’s actions are in the scrolling page at the largest text size', async () => {
  g.__phoneFontScale = LARGEST;
  await mount(homeIs('asleep'));
  for (const label of ['Wake', 'Move MoMo']) assert.equal(inScroll(label), true, `${label} scrolls with the page`);
});

test('the move card’s Cancel is in the scrolling page at the largest text size', async () => {
  g.__phoneFontScale = LARGEST;
  await mount((v) => {
    Object.assign(v.home, { state: 'moving' });
    v.home.move = {
      moveId: 'm1',
      from: { machineId: 'studio', name: 'Studio' },
      to: { machineId: 'mini', name: 'Mac mini' },
      step: 'sealed',
      outcome: 'running',
      finishedAt: null,
      failure: null,
      oldMachineOffline: false,
      reclaim: null,
    };
  });
  assert.equal(inScroll('Cancel'), true);
});

test('Tasks keeps Ask MoMo in the scrolling page, with room under it for the tab bar', async () => {
  g.__phoneFontScale = LARGEST;
  await mount((v) => (v.tasks = []));
  await tap('Tasks');
  assert.equal(inScroll('Ask MoMo'), true);
  assert.equal(g.__scrollEvents.contentContainerStyle.paddingBottom, 96, 'the page ends above the tab bar');
});

test('the header pill and each tab label are cut to one line, and the tabs cap how far their text grows', async () => {
  g.__phoneFontScale = LARGEST;
  const m = await mount();
  const pill = [...m.host.querySelectorAll('span')].find((n) => n.textContent === 'MoMo\nStudio');
  assert.equal(lines(pill), '2', 'at the largest size the machine name wraps to a second line, so machine and state stay readable');
  for (const tab of ['Chat', 'Tasks', 'Notes']) {
    const label = [...m.host.querySelectorAll('button[aria-label] span')].find((n) => n.textContent === tab);
    assert.equal(lines(label), '1', `${tab} stays on one line`);
    assert.equal(
      label?.getAttribute('maxfontsizemultiplier') ?? label?.getAttribute('maxFontSizeMultiplier'),
      '1.2',
      `${tab} grows only so far`,
    );
  }
});

test('an empty composer is one line high at every size and grows with what is typed', async () => {
  const high = async (scale: number) => {
    g.__phoneFontScale = scale;
    const m = await mount();
    return JSON.parse(m.host.querySelector('input[placeholder]')?.getAttribute('data-style') ?? '{}');
  };
  const normal = await high(1);
  const largest = await high(LARGEST);
  assert.equal(normal.height, 39);
  assert.equal(largest.height, 88);
  assert.equal(normal.maxHeight, 120);
  g.__phoneFontScale = 1;
  const m = await mount();
  await m.drafts.set('a long message');
  await m.rerender();
  assert.equal(JSON.parse(m.host.querySelector('input[placeholder]')?.getAttribute('data-style') ?? '{}').height, undefined);
});

test('each tab is a named button that says whether it is the open one', async () => {
  const m = await mount();
  for (const [name, selected] of [
    ['Chat', 'true'],
    ['Tasks', 'false'],
    ['Notes', 'false'],
  ]) {
    const tab = find(name);
    assert.equal(tab?.getAttribute('aria-label'), name);
    assert.equal(tab?.getAttribute('aria-selected'), selected, `${name} selected`);
  }
  await tap('Tasks');
  assert.equal(find('Tasks')?.getAttribute('aria-selected'), 'true');
  assert.equal(m.text().includes('Chat'), true);
});

test('the tab bar has a full-width backdrop, so rows are covered under it and not seen through the gaps around it', async () => {
  await mount();
  const styles = [...document.querySelectorAll('[data-style]')].map((e) => JSON.parse(e.getAttribute('data-style') ?? '{}'));
  assert.ok(
    styles.some(
      (s) => s.position === 'absolute' && s.left === 0 && s.right === 0 && s.bottom === 0 && s.height === 72 && s.backgroundColor,
    ),
  );
});

test('at the normal size the pill stays on one line', async () => {
  const m = await mount();
  const pill = [...m.host.querySelectorAll('span')].find((n) => n.textContent === 'MoMo · Studio');
  assert.equal(lines(pill), '1');
});

/** The direction of the row of buttons a label sits in: how the buttons are laid out (the shim writes each View's style into data-style). */
const rowOf = (label: string) => {
  const button = find(label);
  for (let n = button?.parentElement; n; n = n.parentElement) {
    const style = n.getAttribute('data-style') ?? '';
    if (style.includes('flexDirection')) return /"flexDirection":"(row|column)"/.exec(style)?.[1] ?? null;
  }
  return null;
};
const older = {
  id: 'older:studio',
  code: 'older_home',
  cause: 'There are two MoMos.',
  fix: { id: 'use-older:studio', label: 'Use the one on Studio' },
  also: [
    { id: 'keep-older:studio', label: 'Keep this one' },
    { id: 'delete-older:studio', label: 'Delete the old MoMo' },
  ],
  since: null,
};

test('three buttons, or one with a long label, stack one under the other at any size, so no label is cut mid-word or spills out of its pill', async () => {
  await mount((v) => v.problems.push({ ...older }));
  for (const label of ['Use the one on Studio', 'Keep this one', 'Delete the old MoMo']) assert.equal(rowOf(label), 'column', label);
  await unmountAll();
  g.__phoneFontScale = LARGEST;
  await mount((v) => v.problems.push({ ...older }));
  for (const label of ['Use the one on Studio', 'Keep this one', 'Delete the old MoMo']) assert.equal(rowOf(label), 'column', label);
});

test('two short buttons sit side by side at the default size and stack at the largest', async () => {
  const brief = (v: any) =>
    v.chat.splice(0, v.chat.length, {
      kind: 'brief',
      id: 'b1',
      at: 1,
      brief: {
        day: 'd',
        greeting: 'Hi',
        attention: null,
        offers: [{ id: 'o1', title: 'Offer', why: 'Because' }],
        overnight: { read: 0, notesUpdated: 0, rulesLearned: 0 },
        leftOut: [],
      },
    });
  await mount(brief);
  assert.equal(rowOf('Start'), 'row');
  await unmountAll();
  g.__phoneFontScale = LARGEST;
  await mount(brief);
  assert.equal(rowOf('Start'), 'column');
});

const draftRow = {
  kind: 'draft',
  id: 'draft:x',
  at: 1,
  draft: { to: ['ana@acme.example'], subject: 'Re: Acme renewal', body: 'Thursday works for me.' },
  matter: { key: 'k', title: 'Acme renewal' },
  untrusted: true,
  truncated: false,
};

test('the draft card’s Edit, Copy and Open in Mail sit side by side at the default size and stack at the largest, words whole', async () => {
  const put = (v: any) => v.chat.splice(0, v.chat.length, draftRow);
  await mount(put);
  for (const label of ['Edit', 'Copy']) assert.equal(rowOf(label), 'row', label);
  await unmountAll();
  g.__phoneFontScale = LARGEST;
  await mount(put);
  for (const label of ['Edit', 'Copy']) assert.equal(rowOf(label), 'column', label);
  // Edit's own Cancel and Done stack too
  await tap('Edit');
  for (const label of ['Cancel', 'Done']) assert.equal(rowOf(label), 'column', label);
});

test('a failure that appears while the page is scrolled down brings the page to where it is drawn', async () => {
  g.__scrolledTo = [];
  const m = await mount((v) => v.problems.push({ ...older }));
  m.transport.fail({ ok: false, cause: 'Studio did not answer.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' });
  await tap('Keep this one');
  assert.match(m.text(), /Studio did not answer\./);
  const last = (g.__scrolledTo as { y: number }[]).at(-1);
  assert.equal(last?.y, 0, 'the page was taken to the top, where the failure is');
});

test('the banner that appears at the bottom of a followed chat is not scrolled away again when the page grows under it', async () => {
  g.__scrolledTo = [];
  g.__scrolledToEnd = [];
  const m = await mount((v) => v.problems.push({ ...older }));
  m.transport.fail({ ok: false, cause: 'Studio did not answer.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' });
  await tap('Keep this one');
  assert.match(m.text(), /Studio did not answer\./);
  // the banner makes the content taller: the page must stay at the top where the banner is, not follow the chat to its end
  g.__scrolledToEnd = [];
  await act(async () => (g.__scrollEvents.onContentSizeChange(0, 4000), void 0));
  assert.deepEqual(g.__scrolledToEnd, []);
});
