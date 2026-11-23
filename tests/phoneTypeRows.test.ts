// The grouped list, the single-choice list and the "⋯" menu draw their text from the type scale in every state they have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click } from './support/phone/component-kit';
const listPath = '../mobile/src/components/List';
const choicePath = '../mobile/src/components/Choice';
const menuPath = '../mobile/src/components/Menu';
const typographyPath = '../mobile/src/typography';
const { ListGroup, ListRow } = await import(listPath);
const { Choice } = await import(choicePath);
const { MenuButton } = await import(menuPath);
const { typo, typoWeight } = await import(typographyPath);

const mount = async (element: any) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, unmount: () => act(async () => root.unmount()) };
};

const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const span = (host: Element, text: string) => [...host.querySelectorAll('span')].filter((n) => n.textContent === text).at(-1);
const px = (n: number) => n;

test('list rows set their name and value at the callout size, whatever the row does', async () => {
  const view = await mount(
    createElement(
      ListGroup,
      null,
      createElement(ListRow, { label: 'Notifications', value: 'On', onPress: () => undefined }),
      createElement(ListRow, { label: 'Pair a computer', action: true, onPress: () => undefined }),
      createElement(ListRow, { label: 'Sign out', danger: true, onPress: () => undefined }),
      createElement(ListRow, { label: 'Version', value: '1.0' }),
    ),
  );
  for (const [label, value] of [
    ['Notifications', 'On'],
    ['Version', '1.0'],
  ]) {
    assert.equal(styleOf(span(view.host, label)).fontSize, px(typo.callout.fontSize!));
    assert.equal(styleOf(span(view.host, value)).fontSize, px(typo.callout.fontSize!));
  }
  for (const label of ['Pair a computer', 'Sign out']) assert.equal(styleOf(span(view.host, label)).fontSize, px(typo.callout.fontSize!));
  await view.unmount();
});

test('a choice marks the chosen row heavier, explains a disabled one and shows the chosen one’s hint', async () => {
  const picks: string[] = [];
  const options = [
    { id: 'a', label: 'Alpha', hint: 'Alpha hint' },
    { id: 'b', label: 'Beta', disabled: 'Needs setup' },
    { id: 'c', label: 'Gamma' },
  ];
  const view = await mount(createElement(Choice, { title: 'Model', options, value: 'a', pick: (id: string) => picks.push(id) }));
  assert.equal(styleOf(span(view.host, 'Alpha')).fontWeight, typoWeight.semibold);
  assert.equal(styleOf(span(view.host, 'Gamma')).fontWeight, typoWeight.medium);
  assert.equal(styleOf(span(view.host, 'Needs setup')).fontSize, px(typo.caption.fontSize!));
  assert.equal(styleOf(span(view.host, 'Alpha hint')).fontSize, px(typo.footnote.fontSize!));
  await click('Gamma');
  assert.deepEqual(picks, ['c']);
  await view.unmount();
  const locked = await mount(createElement(Choice, { title: 'Model', options, value: null, pick: () => undefined, locked: true }));
  assert.equal(locked.host.textContent?.includes('Alpha hint'), false, 'no hint without a chosen row');
  await locked.unmount();
});

test('the menu list shows each item at the callout size where the system menu is not used', async () => {
  (globalThis as any).__phonePlatform = 'android';
  try {
    const taps: string[] = [];
    const view = await mount(
      createElement(MenuButton, {
        label: 'More',
        items: [{ label: 'Rename', onPress: () => taps.push('rename') }],
        children: createElement('span', null, 'Trigger'),
      }),
    );
    await click('More');
    assert.equal(styleOf(span(view.host, 'Rename')).fontSize, px(typo.callout.fontSize!));
    await click('Rename');
    assert.deepEqual(taps, ['rename']);
    await view.unmount();
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});
