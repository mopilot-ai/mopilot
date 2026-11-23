// src/components/sidebar/ChildRows.tsx and ThreadRow.tsx, as in Claude's Code tab: a chat whose started chats nest under
// it hides or shows them (row button, context menu, a project's Hide all), per sidebar view and kept across reloads;
// hidden, one row counts them by state and shows them again, the open chat still shows; nested rows read who started
// them and show a linked session's done or failed report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, fx, thread, mountSidebar, flush, update, getState, click, mouse, named, byText } from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

type How = 'finished' | 'failed' | 'stopped' | 'lost';
const child = (parentId: string, createdAt: number, how: How | null = null) => ({
  parentId,
  name: `n${createdAt}`,
  title: `n${createdAt}`,
  harness: null,
  useWorktree: false,
  createdAt,
  lastReport: how && { how, report: null, at: createdAt },
});
const orchestration = (children: Record<string, unknown>) => ({ children, deliveries: {}, proposals: {}, queue: [] });

function fresh(ids: string[], over: Record<string, any> = {}, cwd = '/home') {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  const threads = Object.fromEntries(ids.map((id, i) => [id, thread(id, { cwd, updatedAt: 50 - i })]));
  reset({ threadOrder: ids, threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] }, ...over });
}
/** The Projects section (each project's group, or the one list); Recents lists recent chats again with its own choice. */
const projects = (host: HTMLElement) =>
  [...host.querySelectorAll('.sidebar-section')].find((s) => s.querySelector('.side-label')?.textContent === 'Projects') as HTMLElement;
const rowOf = (host: HTMLElement, id: string) => host.querySelector(`[data-sidebar-chat="${id}"]`) as HTMLElement | null;
const nestedIds = (host: HTMLElement) =>
  [...host.querySelectorAll('.side-children [data-sidebar-chat]')].map((r) => r.getAttribute('data-sidebar-chat'));
const toggleOf = (row: HTMLElement | null) => row?.querySelector('.nested-caret[aria-expanded]') as HTMLButtonElement | null;
const summaryOf = (host: HTMLElement) => host.querySelector('.nested-summary') as HTMLButtonElement | null;
const saved = () => JSON.parse(localStorage.getItem('mopilot.nestedHidden') ?? '[]');

test('a parent hides its nested sessions behind one row that counts them by state, and a click shows them again', async () => {
  fresh(['top', 'k1', 'k2', 'k3', 'k4', 'grand'], {
    unread: { k2: true },
    sessions: { k1: { rev: 1, turn: 'running', approvals: [] }, k3: { rev: 1, turn: 'awaitingUser', approvals: [] } },
  });
  fx.orchestration = orchestration({
    k1: child('top', 1),
    k2: child('top', 2, 'finished'),
    k3: child('top', 3),
    k4: child('top', 4, 'finished'),
    grand: child('k1', 5, 'lost'),
  });
  const view = await mountSidebar();
  await flush();
  const top = rowOf(view.host, 'top')!;
  assert.deepEqual(nestedIds(view.host), ['k1', 'grand', 'k2', 'k3', 'k4']);
  // only a chat with listed nested sessions has the toggle
  assert.equal(toggleOf(top)?.getAttribute('aria-label'), 'Hide nested sessions');
  assert.equal(toggleOf(top)?.getAttribute('aria-expanded'), 'true');
  assert.equal(toggleOf(rowOf(view.host, 'k1')), null, 'only the family head owns the caret');
  assert.equal(toggleOf(rowOf(view.host, 'k2')), null);
  // a nested row reads who started it, with no harness named; a top-level row doesn't
  const k1 = rowOf(view.host, 'k1')!;
  assert.equal(document.getElementById(k1.getAttribute('aria-describedby')!)?.textContent, 'Started by the agent from Chat top');
  assert.equal(top.hasAttribute('aria-describedby'), false);
  // the linked sessions' last reports: finished and read is done, lost is failed, an unread result stays unread
  assert.equal(rowOf(view.host, 'k4')!.querySelector('.row-dot.done'), null, 'completion has no status mark');
  assert.equal(rowOf(view.host, 'grand')!.querySelector('[aria-label="Failed"]')?.getAttribute('aria-label'), 'Failed');
  assert.ok(rowOf(view.host, 'k2')!.querySelector('.row-dot.unread'));

  await click(toggleOf(top)!);
  assert.deepEqual(nestedIds(view.host), ['k3'], 'input rows remain visible; failures and unread results are counted');
  const summary = summaryOf(view.host)!;
  assert.equal(summary.getAttribute('aria-label'), 'Show 4 more nested sessions, 1 failed, 1 unread, 1 working');
  assert.equal(summary.textContent, '4 more nested sessions·1 failed·1 unread·1 working');
  assert.deepEqual(saved(), ['recents:top']);
  assert.ok(
    named('ensureSession').some(([id]) => id === 'k1'),
    'family loads hidden rows from main too',
  );
  assert.equal(toggleOf(rowOf(view.host, 'top'))?.getAttribute('aria-expanded'), 'false');

  await update({ ...getState(), route: { name: 'thread', id: 'grand' } });
  assert.deepEqual(nestedIds(view.host), ['grand', 'k3'], 'an open grandchild does not add a second visual ancestry level');
  await update({ ...getState(), route: { name: 'thread', id: 'k1' } });
  assert.deepEqual(nestedIds(view.host), ['k1', 'k3']);
  assert.equal(summaryOf(view.host)!.getAttribute('aria-label'), 'Show 3 more nested sessions, 1 failed, 1 unread');

  // nothing left to count: no parts and no failure mark
  // the open chat no longer listed (archived): nothing to keep, the rest fold
  await update({ ...getState(), route: { name: 'thread', id: 'k2' }, unread: {}, sessions: {}, threadOrder: ['top', 'k4'] });
  assert.equal(summaryOf(view.host)!.getAttribute('aria-label'), 'Show 1 nested session');
  assert.equal(summaryOf(view.host)!.querySelector('.row-status'), null);

  await click(summaryOf(view.host)!);
  assert.deepEqual(nestedIds(view.host), ['k4']);
  assert.equal(summaryOf(view.host), null);
  assert.deepEqual(saved(), []);
  await view.unmount();
});

test('the choice is kept per view across a reload, and the row caret hides or shows them', async () => {
  fresh(['top', 'k1', 'self'], { prefs: { sidebarFolders: ['/work/a'], sidebarProjectOrder: ['/work/a'] } }, '/work/a');
  fx.orchestration = orchestration({ k1: child('top', 1), self: child('self', 2) });
  localStorage.setItem('mopilot.nestedHidden', JSON.stringify(['list:top']));
  let view = await mountSidebar();
  await flush();
  let list = projects(view.host);
  assert.deepEqual(nestedIds(list), ['k1'], 'hidden in the one-list view only');
  // a damaged record naming a chat as its own parent gives it nothing to hide
  assert.equal(toggleOf(rowOf(list, 'self')), null);
  await click(toggleOf(rowOf(list, 'top'))!);
  assert.deepEqual(nestedIds(list), []);
  assert.deepEqual(nestedIds(view.host), ['k1'], 'Recents keeps its own choice');
  assert.deepEqual(saved(), ['list:top', 'project:top']);
  assert.equal(toggleOf(rowOf(list, 'self')), null);
  await view.unmount();

  // after a reload the one-list view reads its own choice
  resetNestedHidden();
  await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
  view = await mountSidebar();
  await flush();
  list = projects(view.host);
  assert.deepEqual(nestedIds(list), []);
  assert.equal(summaryOf(list)?.getAttribute('aria-label'), 'Show 1 nested session');
  await click(toggleOf(rowOf(list, 'top'))!);
  assert.deepEqual(nestedIds(list), ['k1']);
  assert.deepEqual(saved(), ['project:top']);
  await view.unmount();
});

test('a project with several chats that started some hides or shows all of them from its menu', async () => {
  fresh(['a', 'b', 'a1', 'b1', 'lone', 'x1'], {
    prefs: { sidebarFolders: ['/work/a', '/work/b'], sidebarProjectOrder: ['/work/a', '/work/b'] },
  });
  const threads = getState().threads;
  for (const id of ['a', 'b', 'a1', 'b1']) threads[id].cwd = '/work/a';
  for (const id of ['lone', 'x1']) threads[id].cwd = '/work/b';
  fx.orchestration = orchestration({ a1: child('a', 1), b1: child('b', 2), x1: child('lone', 3) });
  await update({ ...getState(), threads: { ...threads } });
  const view = await mountSidebar();
  await flush();
  const menuOf = async (name: string) => {
    await mouse(byText(view.host, '.project-row .side-row-label', name).closest('.project-row')!, 'contextmenu');
    return [...view.host.querySelectorAll('[data-menu] [data-item]')].map((b) => b.textContent);
  };
  assert.ok(!(await menuOf('b')).some((t) => t?.includes('nested')), 'one chat with nested sessions: its own toggle is enough');
  await click(view.host.querySelector('[data-menu] [data-close]')!);
  assert.ok((await menuOf('a')).includes('Hide all nested sessions'));
  await click(byText(view.host, '[data-menu] [data-item]', 'Hide all nested sessions'));
  assert.deepEqual(nestedIds(projects(view.host)), ['x1']);
  assert.deepEqual(saved(), ['project:a', 'project:b']);
  assert.ok((await menuOf('a')).includes('Show all nested sessions'));
  await click(byText(view.host, '[data-menu] [data-item]', 'Show all nested sessions'));
  assert.deepEqual(nestedIds(projects(view.host)), ['a1', 'b1', 'x1']);
  // one shown is enough for Hide all
  await click(toggleOf(rowOf(projects(view.host), 'a'))!);
  assert.ok((await menuOf('a')).includes('Hide all nested sessions'));
  await view.unmount();
});

test('hidden nested sessions keep their counts while members stream, and follow a member that fails or asks', async (t) => {
  fresh(['top', 'k1', 'k2']);
  fx.orchestration = orchestration({ k1: child('top', 1), k2: child('top', 2) });
  const run = (n: number, status = 'inProgress') => ({
    activeTurnId: status === 'inProgress' ? 't' : null,
    error: null,
    turns: [{ id: 't', status, items: [{ n }] }],
  });
  const view = await mountSidebar();
  t.after(() => view.unmount());
  await flush();
  await click(toggleOf(rowOf(view.host, 'top'))!);
  await update({ ...getState(), runtime: { k1: run(0), k2: run(0) } });
  const label = () => summaryOf(view.host)!.getAttribute('aria-label');
  assert.equal(label(), 'Show 2 nested sessions, 2 working');
  // each streamed frame replaces the member's turns and changes no member's state
  for (let n = 1; n <= 10; n++) await update({ ...getState(), runtime: { k1: run(n), k2: run(n) } });
  assert.equal(label(), 'Show 2 nested sessions, 2 working');
  await update({ ...getState(), runtime: { k1: run(11, 'failed'), k2: run(11) } });
  assert.equal(label(), 'Show 2 nested sessions, 1 failed, 1 working');
  // an approval for a member the family holds brings its row out of the fold; another chat's does not
  await update({ ...getState(), pending: [{ threadId: 'elsewhere', method: 'item/commandExecution/requestApproval' }] });
  assert.deepEqual(nestedIds(view.host), []);
  await update({ ...getState(), pending: [{ threadId: 'k2', method: 'item/commandExecution/requestApproval' }] });
  assert.deepEqual(nestedIds(view.host), ['k2']);
});
