// The other direction of the store fix (src/lib/sideSessions.ts, desktopLineage.ts, #5398): a broadcast that changes what a sidebar row shows must still reach it. A linked chat added, removed, moved to another parent or detached, a report that changes, a new order: each shows after one broadcast, and a change nothing in the sidebar reads (a clock, a title) leaves the families as they were.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { reset, fx, thread, mountSidebar, flush } from './support/shell-sidebar-kit.ts';

const { resetSideSessions, linkedChildren, orchestrationNow } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
const { familyLineageNow, resetDesktopLineage } = await import('../src/session/harness/claude/desktopLineage.ts');
const { familiesOf } = await import('../src/lib/sidebarFamilyIndex.ts');
markWindowReady();

const child = (parentId: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
  parentId,
  name: `n${createdAt}`,
  title: `n${createdAt}`,
  harness: null,
  useWorktree: false,
  createdAt,
  worked: { ms: 0, turns: 0, since: null },
  lastReport: null,
  ...extra,
});
const view = (children: Record<string, unknown>) => ({ children, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const IDS = ['top', 'other', 'k1', 'k2', 'k3'];
beforeEach(() => {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  resetDesktopLineage();
  const threads = Object.fromEntries(IDS.map((id, i) => [id, thread(id, { cwd: '/home', updatedAt: 50 - i })]));
  reset({ threadOrder: IDS, threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
});

const rowOf = (host: HTMLElement, id: string) => host.querySelector(`[data-sidebar-chat="${id}"]`) as HTMLElement | null;
const nestedIds = (host: HTMLElement) =>
  [...host.querySelectorAll('.side-children [data-sidebar-chat]')].map((r) => r.getAttribute('data-sidebar-chat'));
const hasCaret = (host: HTMLElement, id: string) => !!rowOf(host, id)?.querySelector('.nested-caret[aria-expanded]');
const broadcast = (next: unknown) => act(async () => fx.orchestrationChanged(next));

test('a started chat that is added, moves to another parent, is detached or is removed reaches its parent row and its nest', async () => {
  fx.orchestration = view({ k1: child('top', 1) });
  const m = await mountSidebar();
  try {
    await flush();
    assert.equal(hasCaret(m.host, 'top'), true);
    assert.equal(hasCaret(m.host, 'other'), false);
    assert.equal(rowOf(m.host, 'k2')?.classList.contains('linked-child'), false);

    // added
    await broadcast(view({ k1: child('top', 1), k2: child('top', 2) }));
    assert.equal(rowOf(m.host, 'k2')?.classList.contains('linked-child'), true, 'a chat added under its parent nests at once');
    // moved to another parent: the old parent keeps one, the new one gains its first
    await broadcast(view({ k1: child('other', 1), k2: child('top', 2) }));
    assert.equal(hasCaret(m.host, 'other'), true, 'the new parent gets the toggle');
    assert.equal(rowOf(m.host, 'k1')?.classList.contains('linked-child'), true);
    // detached: it leaves the family and its old parent
    await broadcast(view({ k1: child('other', 1, { detached: true }), k2: child('top', 2) }));
    assert.equal(hasCaret(m.host, 'other'), false, 'the parent of a detached chat loses its toggle');
    assert.equal(rowOf(m.host, 'k1')?.classList.contains('linked-child'), false);
    assert.equal(hasCaret(m.host, 'top'), true);
    // removed
    await broadcast(view({ k1: child('other', 1, { detached: true }) }));
    assert.equal(hasCaret(m.host, 'top'), false, 'a parent with nothing left to nest loses its toggle');
  } finally {
    await m.unmount();
  }
});

test('a report that changes reaches the nested row, and the nest follows the list order, not the creation time of the linked sessions', async () => {
  fx.orchestration = view({ k1: child('top', 1), k2: child('top', 2) });
  const m = await mountSidebar();
  try {
    await flush();
    assert.deepEqual(nestedIds(m.host), ['k1', 'k2']);
    assert.equal(rowOf(m.host, 'k2')?.querySelector('[aria-label="Failed"]'), null);
    await broadcast(view({ k1: child('top', 1), k2: child('top', 2, { lastReport: { how: 'failed', report: null, at: 9 } }) }));
    assert.ok(rowOf(m.host, 'k2')?.querySelector('[aria-label="Failed"]'), 'its failure shows');
    // the nested rows follow the list's order (the families), so a changed creation time has nothing to reorder
    await broadcast(view({ k1: child('top', 5), k2: child('top', 2, { lastReport: { how: 'failed', report: null, at: 9 } }) }));
    assert.deepEqual(nestedIds(m.host), ['k1', 'k2'], 'the order stays the list order');
    assert.ok(rowOf(m.host, 'k2')?.querySelector('[aria-label="Failed"]'));
  } finally {
    await m.unmount();
  }
});

test('what the families read of the view is who started whom and detached; a clock, a title or a creation time changes neither the family view nor its families', async () => {
  fx.orchestration = view({ k1: child('top', 1), k2: child('top', 2) });
  const m = await mountSidebar();
  try {
    await flush();
    const before = familyLineageNow();
    const store = (await import('./support/shell-sidebar-kit.ts')).getState();
    const families = familiesOf(before, store.threadOrder, store.threads, store.momoChats, false);

    const moved = clone(orchestrationNow() as any);
    moved.children.k1.worked.ms = 999;
    moved.children.k1.title = 'renamed';
    moved.children.k2.createdAt = 77;
    await broadcast(moved);
    assert.notEqual(orchestrationNow(), before as any, 'the view itself changed');
    assert.equal(familyLineageNow(), before, 'the family view is the same object: its readers do not render');
    assert.equal(
      familiesOf(familyLineageNow(), store.threadOrder, store.threads, store.momoChats, false),
      families,
      'and the index was not rebuilt',
    );
    // what does read creation time (linkedChildren: the chat's own cards and strips) reads the whole view and follows it
    assert.deepEqual(linkedChildren(orchestrationNow(), 'top'), ['k1', 'k2']);
    const swapped = clone(moved);
    swapped.children.k1.createdAt = 99;
    await broadcast(swapped);
    assert.deepEqual(linkedChildren(orchestrationNow(), 'top'), ['k2', 'k1']);
    assert.equal(familyLineageNow(), before, 'and the family view is still the same');

    // a change of who started whom is a new family view
    const reparented = clone(swapped);
    reparented.children.k1.parentId = 'other';
    await broadcast(reparented);
    assert.notEqual(familyLineageNow(), before);
    assert.deepEqual(familiesOf(familyLineageNow(), store.threadOrder, store.threads, store.momoChats, false).descendants.get('other'), [
      'k1',
    ]);
    const detached = clone(reparented);
    detached.children.k1.detached = true;
    await broadcast(detached);
    assert.equal(
      familiesOf(familyLineageNow(), store.threadOrder, store.threads, store.momoChats, false).descendants.get('other')?.length ?? 0,
      0,
    );
  } finally {
    await m.unmount();
  }
});
