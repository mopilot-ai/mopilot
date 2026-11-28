// The session rail's section layout, as Claude Desktop's (src/store/railSections.ts, src/components/panels/RailSection.tsx):
// a fold by hand is the chat's and becomes how new chats start, Alt+click folds every section, the header's menu shows or
// hides sections (not Environment) and resets them, and only the newest chats keep their own folds.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { act, createElement as h } from 'react';
import './support/dom.ts';
import { fakeStore, one, popoverStub, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ prefs: {} });
stubStore(store.exports);
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStub });
const { RailSection } = await import('../src/components/panels/RailSection.tsx');
const rail = await import('../src/store/railSections.ts');

const prefs = () => store.get().prefs;
const two = (chatId: string) =>
  h(
    'div',
    null,
    h(RailSection, { chatId, id: 'environment', summary: 'repo', children: h('span', null, 'env body') }),
    h(RailSection, {
      chatId,
      id: 'connectors',
      summary: '2 to reconnect',
      children: (open: boolean) => h('span', null, open ? 'rows' : 'closed'),
    }),
  );
const section = (host: HTMLElement, id: string) => host.querySelector(`[data-rail-section="${id}"]`) as HTMLDetailsElement | null;
const header = (host: HTMLElement, id: string) => section(host, id)!.querySelector('summary') as HTMLElement;

beforeEach(() => store.set({ prefs: {} }));

test('a section starts as Claude Desktop’s do, a fold by hand is the chat’s and how new chats start', async () => {
  const a = await render(two('a'));
  assert.equal(section(a.host, 'environment')!.open, true);
  assert.equal(section(a.host, 'connectors')!.open, false, 'Connectors and Context start collapsed');
  assert.equal(one(a.host, '[data-rail-section="connectors"] .rail-section-summary').textContent, '2 to reconnect');
  assert.match(section(a.host, 'connectors')!.textContent!, /closed/, 'a costly body knows it is folded');
  await act(() => header(a.host, 'connectors').click());
  assert.equal(section(a.host, 'connectors')!.open, true);
  assert.match(section(a.host, 'connectors')!.textContent!, /rows/);
  assert.deepEqual(prefs().railFolds, { a: { expanded: ['connectors'], collapsed: [] } });
  assert.deepEqual(prefs().railSections, { startsOpen: { connectors: true } });
  // a new chat starts the way the last fold left it; this chat's own fold wins over a later default
  const b = await render(two('b'));
  assert.equal(section(b.host, 'connectors')!.open, true);
  await act(() => header(b.host, 'connectors').click());
  assert.equal(section(a.host, 'connectors')!.open, true, 'another chat keeps its own fold');
  assert.equal(rail.sectionOpen(prefs(), 'new', 'connectors'), false);
  await act(() => header(b.host, 'environment').click());
  assert.deepEqual(prefs().railFolds.b, { expanded: [], collapsed: ['connectors', 'environment'] });
  // Alt+click folds every section of the chat, and leaves how new chats start alone
  await act(() => header(b.host, 'environment').dispatchEvent(new window.MouseEvent('click', { bubbles: true, altKey: true })));
  assert.equal(section(b.host, 'environment')!.open, true);
  assert.equal(section(b.host, 'connectors')!.open, true);
  assert.equal(prefs().railFolds.b.expanded.length, rail.RAIL_SECTIONS.length);
  assert.deepEqual(prefs().railSections.startsOpen, { connectors: false, environment: false });
  await a.unmount();
  await b.unmount();
});

test('the header menu hides and shows sections, never Environment, and resets the layout', async () => {
  const r = await render(two('a'));
  const menu = () => r.host.querySelector('[role="menu"]');
  const items = () => [...r.host.querySelectorAll('[role="menuitem"]')].map((i) => [i.textContent, i.getAttribute('data-checked')]);
  await act(() => header(r.host, 'connectors').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.ok(menu());
  assert.ok(!items().some(([name]) => name === 'Environment'), 'Environment cannot be hidden');
  assert.deepEqual(items().slice(0, 2), [
    ['Move up', null],
    ['Move down', null],
  ]);
  assert.deepEqual(items().at(2), ['Goal', 'true']);
  assert.deepEqual(items().at(-1), ['Reset to defaults', null]);
  assert.equal(rail.sectionsChanged(prefs(), 'a'), false, 'nothing to reset yet');
  await act(() => (one(r.host, '[role="menuitem"]', 'Connectors') as HTMLElement).click());
  assert.equal(section(r.host, 'connectors'), null);
  assert.deepEqual(prefs().railSections.hidden, ['connectors']);
  assert.equal(rail.sectionsChanged(prefs(), 'a'), true);
  // Environment is never hidden, even if a saved list names it
  rail.setSectionHidden('environment', true);
  assert.equal(rail.sectionHidden(prefs(), 'environment'), false);
  await act(() => header(r.host, 'environment').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.deepEqual(
    items().find(([name]) => name === 'Connectors'),
    ['Connectors', 'false'],
  );
  await act(() => (one(r.host, '[role="menuitem"]', 'Connectors') as HTMLElement).click());
  assert.ok(section(r.host, 'connectors'));
  await act(() => header(r.host, 'connectors').click());
  rail.setSectionHidden('activity', true);
  await act(() => header(r.host, 'environment').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await act(() => (one(r.host, '[role="menuitem"]', 'Reset to defaults') as HTMLElement).click());
  assert.deepEqual(prefs().railSections, {});
  assert.equal(prefs().railFolds.a, undefined);
  assert.equal(section(r.host, 'connectors')!.open, false);
  await r.unmount();
});

test('what counts as changed, and only the newest chats keep their own folds', () => {
  assert.equal(rail.sectionsChanged(undefined, 'a'), false);
  assert.equal(rail.sectionsChanged({ railSections: { startsOpen: { connectors: false, changes: true } } } as never, 'a'), false);
  assert.equal(rail.sectionsChanged({ railSections: { startsOpen: { changes: false } } } as never, 'a'), true);
  assert.equal(rail.sectionsChanged({ railFolds: { a: { expanded: [], collapsed: [] } } } as never, 'a'), false);
  assert.equal(rail.sectionOpen(undefined, 'a', 'context'), false);
  assert.equal(rail.sectionOpen(undefined, 'a', 'changes'), true);
  rail.resetSections('nobody');
  store.set({ prefs: undefined });
  rail.setSectionHidden('activity', false);
  rail.resetSections('nobody');
  store.set({ prefs: {} });
  for (let i = 0; i < 101; i++) rail.setSectionOpen(`chat-${i}`, 'activity', false);
  const kept = Object.keys(prefs().railFolds);
  assert.equal(kept.length, 100);
  assert.equal(kept.includes('chat-0'), false, 'the oldest chat falls back to how new chats start');
  rail.setSectionOpen('chat-1', 'activity', true);
  assert.equal(Object.keys(prefs().railFolds).at(-1), 'chat-1', 'a chat folded again is the newest');
});

test('controls beside the header stay reachable while folded, and the app opens a section for this chat only', async () => {
  let pressed = 0;
  const r = await render(
    h(RailSection, {
      chatId: 'a',
      id: 'changes',
      trailing: h('button', { className: 'beside', onClick: () => pressed++ }, 'More'),
      children: h('span', null, 'body'),
    }),
  );
  assert.equal(section(r.host, 'changes')!.getAttribute('role'), 'group');
  assert.equal(section(r.host, 'changes')!.getAttribute('aria-label'), 'Changes');
  await act(() => header(r.host, 'changes').click());
  assert.equal(section(r.host, 'changes')!.open, false);
  // the control sits outside the fold
  assert.equal(section(r.host, 'changes')!.contains(one(r.host, '.beside')), false);
  await act(() => (one(r.host, '.beside') as HTMLElement).click());
  assert.equal(pressed, 1);
  await act(() => rail.setSectionOpenFor('a', 'changes', true));
  assert.equal(rail.sectionOpen(prefs(), 'a', 'changes'), true);
  assert.equal(section(r.host, 'changes')!.open, true);
  assert.equal(prefs().railSections.startsOpen.changes, false, 'how new chats start is the user’s, not the app’s');
  const writes = store.calls.filter((c) => c[0] === 'setPrefs').length;
  rail.setSectionOpenFor('a', 'changes', true);
  assert.equal(store.calls.filter((c) => c[0] === 'setPrefs').length, writes, 'an open section is not written again');
  // the element's own toggle (an assistive technology's) is kept in step with the saved fold
  await act(() => {
    const d = section(r.host, 'changes')!;
    d.open = false;
    d.dispatchEvent(new window.Event('toggle'));
  });
  assert.equal(rail.sectionOpen(prefs(), 'a', 'changes'), false);
  await act(() => section(r.host, 'changes')!.dispatchEvent(new window.Event('toggle')));
  assert.equal(rail.sectionOpen(prefs(), 'a', 'changes'), false);
  await r.unmount();
});

test('sections move up and down as Claude Desktop’s drag does, the order outlives a new section, and Reset puts it back', async () => {
  const r = await render(two('a'));
  const menuFor = (id: string) =>
    act(() => header(r.host, id).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const item = (name: string) => one(r.host, '[role="menuitem"]', name) as HTMLElement;
  // Move down passes the next section the rail shows (Goal, Context and the rest show nothing here), as a drag onto it does
  await menuFor('environment');
  await act(() => item('Move down').click());
  assert.deepEqual(rail.sectionOrder(prefs().railSections.order).slice(0, 4), ['goal', 'context', 'connectors', 'environment']);
  assert.equal(rail.sectionsChanged(prefs(), 'a'), true);
  // the store's one-place moves stop at either end
  rail.moveSection('goal', -1);
  rail.moveSection('sources', 1);
  assert.equal(rail.sectionOrder(prefs().railSections.order)[0], 'goal');
  assert.equal(rail.sectionOrder(prefs().railSections.order).at(-1), 'sources');
  rail.moveSection('goal', 1);
  assert.deepEqual(rail.sectionOrder(prefs().railSections.order).slice(0, 2), ['context', 'goal']);
  // Move up passes the section shown above it
  await menuFor('connectors');
  await act(() => item('Move up').click());
  assert.ok(
    rail.sectionOrder(prefs().railSections.order).indexOf('connectors') <
      rail.sectionOrder(prefs().railSections.order).indexOf('environment'),
  );
  await menuFor('connectors');
  await act(() => item('Reset to defaults').click());
  assert.deepEqual(
    rail.sectionOrder(prefs().railSections.order),
    rail.RAIL_SECTIONS.map((s) => s.id),
  );
  // a saved order from an older version: unknown and repeated ids dropped, a missing section after its predecessor
  assert.deepEqual(rail.sectionOrder(['changes', 'nope', 'changes', 'environment']).slice(0, 7), [
    'changes',
    'servers',
    'backgroundTasks',
    'activity',
    'sources',
    'environment',
    'goal',
  ]);
  assert.deepEqual(rail.sectionOrder(['changes']).slice(0, 3), ['environment', 'goal', 'context']);
  await r.unmount();
});

test('a section dragged by its header onto another takes its place before or after it, as Claude Desktop’s', async () => {
  const r = await render(two('a'));
  const drag = async (from: string, to: string, lower: boolean) => {
    const source = header(r.host, from);
    const target = section(r.host, to)!;
    target.getBoundingClientRect = () =>
      ({ top: 0, height: 40, bottom: 40, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const data = { effectAllowed: '', setData() {} };
    const over = Object.assign(new window.Event('dragover', { bubbles: true, cancelable: true }), { clientY: lower ? 30 : 10 });
    await act(() => {
      source.dispatchEvent(Object.assign(new window.Event('dragstart', { bubbles: true }), { dataTransfer: data }));
      target.dispatchEvent(over);
    });
    assert.equal(over.defaultPrevented, true, 'another section accepts the drop');
    assert.equal(target.getAttribute('data-drop'), lower ? 'after' : 'before');
    await act(() => {
      target.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
      source.dispatchEvent(new window.Event('dragend', { bubbles: true }));
    });
  };
  assert.equal(header(r.host, 'connectors').getAttribute('draggable'), 'true');
  await drag('connectors', 'environment', false);
  assert.deepEqual(rail.sectionOrder(prefs().railSections.order).slice(0, 2), ['connectors', 'environment']);
  assert.equal(section(r.host, 'environment')!.getAttribute('data-drop'), null, 'the line goes with the drop');
  await drag('connectors', 'environment', true);
  assert.deepEqual(rail.sectionOrder(prefs().railSections.order).slice(0, 2), ['environment', 'connectors']);
  // dragging over itself, leaving, or a drag that is not a section's changes nothing
  const before = prefs().railSections.order;
  await act(() => {
    const own = section(r.host, 'connectors')!;
    header(r.host, 'connectors').dispatchEvent(
      Object.assign(new window.Event('dragstart', { bubbles: true }), { dataTransfer: { setData() {} } }),
    );
    const self = new window.Event('dragover', { bubbles: true, cancelable: true });
    own.dispatchEvent(self);
    assert.equal(self.defaultPrevented, false);
    own.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
    section(r.host, 'environment')!.dispatchEvent(new window.Event('dragleave', { bubbles: true }));
  });
  await act(() => {
    const stray = new window.Event('dragover', { bubbles: true, cancelable: true });
    section(r.host, 'environment')!.dispatchEvent(stray);
    assert.equal(stray.defaultPrevented, false, 'a file or text drag is not a section');
    section(r.host, 'environment')!.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(prefs().railSections.order, before);
  rail.moveSectionTo('goal', 'goal', true);
  assert.deepEqual(prefs().railSections.order, before);
  await r.unmount();
});
