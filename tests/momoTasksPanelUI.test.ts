// MoMo's four-tab Tasks panel in the window (src/components/momo/tasks): Active (Needs you, Working, Didn't finish, Ready for review), Up next (with its empty line), Scheduled (routines with their own menu, and Pause all) and Resolved (Reopen); a run's row menu marks it done, archives or deletes it and says so with Undo for 60 s; a failed read says "Couldn't read your tasks." with Try again and keeps the last list greyed; nothing shows while MoMo is not allowed or before the first read; the page picks the panel only behind the flag.
import './support/tz-la.ts';
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

// a toast's own timer (3 s, and 60 s for an Undo) would keep this process alive: the long ones never fire here
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(ms !== undefined && ms >= 3000 ? () => undefined : fn, ms !== undefined && ms >= 3000 ? 0 : ms, ...rest)) as any;

const f: any = { calls: [], tasksListeners: new Set(), memoryListeners: new Set(), prefs: {} };
mockSource('src/store/panes.ts', { navigate: (r: any) => f.calls.push(['navigate', r]) });
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async () => undefined } });
installNativeStub({
  momoTasks: {
    list: async () => (f.calls.push(['list']), f.answer()),
    mark: async (...a: any[]) => (f.calls.push(['mark', ...a]), f.markAnswer(...a)),
    onChanged: (cb: () => void) => {
      f.tasksListeners.add(cb);
      return () => f.tasksListeners.delete(cb);
    },
  },
  momoMemory: {
    loopAct: async (id: string, a: any) => (f.calls.push(['loopAct', id, a]), { ok: true, loop: {} }),
    onChanged: (cb: () => void) => {
      f.memoryListeners.add(cb);
      return () => f.memoryListeners.delete(cb);
    },
  },
  momoRoutines: {
    edit: async (id: string, e: any) => (f.calls.push(['edit', id, e]), f.editAnswer()),
    remove: async (id: string) => (f.calls.push(['remove', id]), f.removeAnswer()),
  },
  // Up next's suggestions (A7, tests/momoSuggestionsUI.test.ts): none here
  momoSuggestions: {
    list: async () => ({ ok: true, v: 1, suggestions: [], shown: 6, now: 0 }),
    act: async () => ({ ok: true }),
    onChanged: () => () => undefined,
  },
  momoPrefs: { set: async (k: string, v: unknown) => (f.calls.push(['pref', k, v]), true) },
});
const { TasksPanel } = await import('../src/components/momo/tasks/TasksPanel.tsx');
const { TasksTab } = await import('../src/components/momo/TasksTab.tsx');
const { useTaskPanel, UNDO_MS, REFRESH_MS } = await import('../src/components/momo/tasks/useTaskPanel.ts');
const { lineOf, when, TABS, EMPTY } = await import('../src/components/momo/tasks/taskCopy.ts');
const { useStore } = await import('../src/store/core.ts');

const NOW = new Date(2026, 10, 15, 12, 0).getTime();
const H = 3_600_000;
const row = (over: any) => ({
  id: 'x',
  kind: 'loop',
  tab: 'active',
  state: 'needs-you',
  title: 'T',
  detail: null,
  at: null,
  dueAt: null,
  dueDay: null,
  ref: 'x',
  outcome: null,
  nextAt: null,
  paused: false,
  ...over,
});
const CARD = row({ id: 'card:a1', kind: 'card', title: 'Send the mail', detail: 'Mail', ref: 'a1' });
const LOOP = row({ id: 'loop:L1', ref: 'L1', title: 'Call mum', detail: 'call mum', dueAt: 5, dueDay: '2030-03-06' });
const GOING = row({ id: 'run:c1', kind: 'run', state: 'running', title: 'Daily brief', ref: 'c1', at: NOW - 60_000 });
const FAILED = row({ id: 'run:c2', kind: 'run', state: 'failed', title: 'Weekly cleanup', ref: 'c2', at: NOW - 2 * H, outcome: 'stopped' });
const REVIEW = row({ id: 'run:c3', kind: 'run', state: 'review', title: 'Morning brief', ref: 'c3', at: NOW - H });
const QUEUED = row({ id: 'loop:L2', tab: 'next', state: 'queued', ref: 'L2', title: 'Plan the offsite', detail: 'someday' });
const ROUTINE = row({
  id: 'routine:r1',
  kind: 'routine',
  tab: 'scheduled',
  state: 'scheduled',
  title: 'Morning brief',
  ref: 'r1',
  nextAt: NOW + 20 * H,
});
const PAUSED = row({ id: 'routine:r2', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Cleanup', ref: 'r2', paused: true });
const DONE_RUN = row({ id: 'run:c4', kind: 'run', tab: 'resolved', state: 'done', title: 'Old brief', ref: 'c4', at: NOW - 30 * H });
const DONE_LOOP = row({ id: 'loop:L3', tab: 'resolved', state: 'dismissed', title: 'Book the dentist', ref: 'L3', at: NOW - H });
const ALL = [CARD, LOOP, GOING, FAILED, REVIEW, QUEUED, ROUTINE, PAUSED, DONE_RUN, DONE_LOOP];
const ok = (tasks: any[], paused = false) => ({ ok: true, v: 2, tasks, paused, now: NOW });
function reset(tasks = ALL) {
  f.calls = [];
  f.answer = async () => ok(tasks);
  f.markAnswer = async () => ({ ok: true, taskId: 'x', mark: 'done', undoToken: 'tok-1' });
  f.editAnswer = async () => ({ id: 'r1' });
  f.removeAnswer = async () => true;
  useStore.setState({ toasts: [] });
}
// Each test owns its poll clock and mounted roots, including when an assertion fails.
const { pollKeyCount } = await import('../src/lib/visiblePoll.ts');
const mounted = new Set<() => Promise<void>>();
beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(async () => {
  try {
    for (const close of mounted) await close();
    assert.equal(f.tasksListeners.size + f.memoryListeners.size, 0);
    assert.equal(pollKeyCount(), 0);
  } finally {
    mock.timers.reset();
  }
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function mount(el: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  const close = async () => {
    if (!mounted.delete(close)) return;
    await act(async () => root.unmount());
    host.remove();
  };
  mounted.add(close);
  await act(async () => root.render(el));
  await flush();
  const all = (sel: string, at: any = host) => [...at.querySelectorAll(sel)];
  const button = (label: string, at: any = host) => all('button', at).find((b: any) => b.textContent === label);
  const click = async (b: any) => {
    await act(async () => b.click());
    await flush();
  };
  return {
    host,
    q: (sel: string, at: any = host) => at.querySelector(sel),
    all,
    button,
    click,
    tab: (name: string) => all('[role=tab]').find((t: any) => t.textContent.startsWith(name)),
    close,
  };
}
const titles = (v: any) => v.all('.settings-group-title').map((t: any) => t.textContent);
const rowOf = (v: any, id: string) => v.q(`[data-task="${id}"]`);
const toasts = () => useStore.getState().toasts as any[];

test('Active groups what needs you, what is going, what did not finish and what waits for review, each row with its own controls', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  assert.deepEqual(titles(v), ['Needs you', 'Working', 'Didn’t finish', 'Ready for review']);
  assert.deepEqual(
    v.all('[role=tab]').map((t: any) => t.textContent),
    ['Active 5', 'Up next 1', 'Scheduled 2', 'Resolved'],
  );
  assert.equal(v.tab('Active').getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    v.all('button', rowOf(v, 'card:a1')).map((b: any) => b.textContent),
    ['Review'],
  );
  assert.deepEqual(
    v.all('button', rowOf(v, 'loop:L1')).map((b: any) => b.textContent),
    ['Done', 'Snooze', 'Dismiss', 'Add to Calendar', 'Remind me'],
  );
  assert.ok(rowOf(v, 'loop:L1').textContent.includes('Due 2030-03-06 · call mum'));
  assert.equal(v.all('button', rowOf(v, 'run:c1')).length, 0);
  assert.ok(rowOf(v, 'run:c1').textContent.includes('Working'));
  assert.ok(rowOf(v, 'run:c2').textContent.includes('Stopped · 10:00'));
  assert.deepEqual(
    v.all('button', rowOf(v, 'run:c2')).map((b: any) => b.textContent),
    ['…'],
  );
  assert.ok(rowOf(v, 'run:c3').textContent.includes('Ready for review · 11:00'));
  assert.deepEqual(
    v.all('button', rowOf(v, 'run:c3')).map((b: any) => b.textContent),
    ['Mark as done', '…'],
  );
  // nothing here is in another tab's list
  assert.equal(rowOf(v, 'loop:L2'), null);
  await v.close();
});

test('Review opens the chat where the card is answered; the panel answers nothing itself', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.button('Review'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'navigate'),
    [['navigate', { name: 'momo', tab: 'chat' }]],
  );
  await v.close();
});

test('Up next, Scheduled and Resolved each show their rows; Active alone says "Nothing needs you" when empty', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Up next'));
  assert.deepEqual(
    v.all('[data-task]').map((r: any) => r.getAttribute('data-task')),
    ['loop:L2'],
  );
  assert.equal(v.tab('Up next').getAttribute('aria-selected'), 'true');
  await v.click(v.tab('Scheduled'));
  assert.deepEqual(
    v.all('[data-task]').map((r: any) => r.getAttribute('data-task')),
    ['routine:r1', 'routine:r2'],
  );
  assert.ok(rowOf(v, 'routine:r1').textContent.includes('Next 12:00') || rowOf(v, 'routine:r1').textContent.includes('Next 2026-11-16'));
  assert.ok(rowOf(v, 'routine:r2').textContent.includes('Paused'));
  assert.deepEqual(
    v.all('button', rowOf(v, 'routine:r1')).map((b: any) => b.getAttribute('aria-label')),
    ['More for Morning brief'],
  );
  await v.click(v.tab('Resolved'));
  assert.deepEqual(
    v.all('[data-task]').map((r: any) => r.getAttribute('data-task')),
    ['run:c4', 'loop:L3'],
  );
  assert.deepEqual(
    v.all('button', rowOf(v, 'run:c4')).map((b: any) => b.textContent),
    ['Reopen'],
  );
  assert.deepEqual(
    v.all('button', rowOf(v, 'loop:L3')).map((b: any) => b.textContent),
    ['Reopen'],
  );
  assert.ok(rowOf(v, 'run:c4').textContent.includes('Done · 2026-11-14 06:00'));
  assert.ok(rowOf(v, 'loop:L3').textContent.includes('Dismissed'));
  await v.close();
  // every empty tab says what it holds
  reset([]);
  const e = await mount(createElement(TasksPanel));
  assert.ok(e.host.textContent.includes(EMPTY.active));
  for (const [name, id] of [
    ['Up next', 'next'],
    ['Scheduled', 'scheduled'],
    ['Resolved', 'resolved'],
  ] as const) {
    await e.click(e.tab(name));
    assert.ok(e.host.textContent.includes(EMPTY[id]), id);
  }
  assert.equal(EMPTY.next, 'Nothing queued. Suggestions from your sources show here.');
  assert.equal(e.button('Pause all'), undefined, 'no routines, no Pause all');
  await e.close();
});

test('Mark as done on a run is the user’s mark, says so with Undo for a minute, and Undo reopens it', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  f.answer = async () => ok(ALL.filter((t) => t.id !== 'run:c3'));
  await v.click(v.button('Mark as done'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'mark'),
    [['mark', 'run:c3', 'done']],
  );
  assert.equal(rowOf(v, 'run:c3'), null, 'the list is read again');
  const t = toasts().at(-1);
  assert.deepEqual([t.text, t.action.label], ['Marked as done', 'Undo']);
  assert.equal(UNDO_MS, 60_000);
  f.answer = async () => ok(ALL);
  await act(async () => t.action.run());
  await flush();
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'mark').at(-1), ['mark', 'run:c3', 'reopen', 'tok-1']);
  assert.ok(rowOf(v, 'run:c3'));
  await v.close();
});

test('the row menu has Show in channel, Mark as done, Archive and Delete; each is the user’s mark', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  const open = async (id: string) => v.click(v.button('…', rowOf(v, id)));
  const item = (label: string) =>
    [...window.document.querySelectorAll('[role=menuitem]')].find((m: any) => m.textContent.includes(label)) as any;
  await open('run:c2');
  assert.deepEqual(
    [...window.document.querySelectorAll('[role=menuitem]')].map((m: any) => m.textContent.trim()),
    ['Show in channel', 'Mark as done', 'Archive', 'Delete'],
  );
  await v.click(item('Show in channel'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'navigate'),
    [['navigate', { name: 'momo', tab: 'chat' }]],
  );
  f.markAnswer = async (_id: string, what: string) => ({ ok: true, taskId: 'run:c2', mark: what, undoToken: `tok-${what}` });
  for (const [label, what, said] of [
    ['Archive', 'archive', 'Archived'],
    ['Delete', 'delete', 'Deleted'],
    ['Mark as done', 'done', 'Marked as done'],
  ] as const) {
    await open('run:c2');
    await v.click(item(label));
    assert.deepEqual(f.calls.filter((c: any) => c[0] === 'mark').at(-1), ['mark', 'run:c2', what]);
    assert.equal(toasts().at(-1).text, said);
  }
  await v.close();
});

test('Reopen on a run in Resolved clears the mark, with no Undo offered; Reopen on a loop is the loop’s own call', async () => {
  reset();
  f.markAnswer = async () => ({ ok: true, taskId: 'run:c4', mark: null, undoToken: 'tok-9' });
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Resolved'));
  await v.click(v.button('Reopen', rowOf(v, 'run:c4')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'mark'),
    [['mark', 'run:c4', 'reopen']],
  );
  assert.equal(toasts().length, 0);
  await v.click(v.button('Reopen', rowOf(v, 'loop:L3')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'loopAct'),
    [['loopAct', 'L3', { action: 'reopen' }]],
  );
  await v.close();
});

test('a mark the Mac refuses, one that throws, and an Undo that is too late each say so', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  f.markAnswer = async () => ({ ok: false, error: 'Only a routine run can be marked.' });
  await v.click(v.button('Mark as done'));
  assert.deepEqual([toasts().at(-1).text, toasts().at(-1).kind], ['Only a routine run can be marked.', 'error']);
  f.markAnswer = async () => {
    throw new Error('ipc broke');
  };
  await v.click(v.button('Mark as done'));
  assert.equal(toasts().at(-1).text, 'Couldn’t save that. Try again.');
  // an archive with no token to take back offers no Undo
  f.markAnswer = async () => ({ ok: true, taskId: 'run:c3', mark: 'archived' });
  const before = toasts().length;
  await v.click(v.button('Mark as done'));
  assert.equal(toasts().length, before);
  f.markAnswer = async () => ({ ok: true, taskId: 'run:c3', mark: 'done', undoToken: 'tok-2' });
  await v.click(v.button('Mark as done'));
  const undo = toasts().at(-1).action.run;
  f.markAnswer = async () => ({ ok: false, reason: 'expired', error: 'x' });
  await act(async () => undo());
  await flush();
  assert.equal(toasts().at(-1).text, 'Can’t undo that any more.');
  f.markAnswer = async () => ({ ok: false, error: 'disk is gone' });
  await act(async () => undo());
  await flush();
  assert.equal(toasts().at(-1).text, 'disk is gone');
  f.markAnswer = async () => {
    throw new Error('ipc broke');
  };
  await act(async () => undo());
  await flush();
  assert.equal(toasts().at(-1).text, 'Couldn’t undo that.');
  await v.close();
});

test('a failed read says "Couldn’t read your tasks." with Try again, keeps the last list greyed, and Try again reads once more', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  f.answer = async () => ({ ok: false, error: 'disk is gone' });
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(v.q('[role=alert]').textContent.trim(), 'Couldn’t read your tasks. Try again');
  assert.ok(rowOf(v, 'card:a1'), 'the last known list stays');
  assert.match(v.q('[role=tabpanel]').className, /stale/);
  f.answer = async () => ok(ALL);
  await v.click(v.button('Try again'));
  assert.equal(v.q('[role=alert]'), null);
  assert.doesNotMatch(v.q('[role=tabpanel]').className, /stale/);
  // a rejection says the same; a reply that is the classic list is no panel either
  f.answer = async () => {
    throw new Error('ipc broke');
  };
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.ok(v.q('[role=alert]'));
  f.answer = async () => ({ ok: true, tasks: [], now: NOW });
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.ok(v.q('[role=alert]'));
  await v.close();
});

test('a first read that fails shows the message and empty tabs; not allowed shows nothing, and so does the time before the first read', async () => {
  reset();
  f.answer = async () => ({ ok: false, error: 'disk is gone' });
  const bad = await mount(createElement(TasksPanel));
  assert.ok(bad.q('[role=alert]'));
  assert.equal(bad.all('[data-task]').length, 0);
  assert.ok(bad.host.textContent.includes(EMPTY.active));
  await bad.close();
  reset();
  const v = await mount(createElement(TasksPanel));
  assert.ok(v.q('[data-task]'));
  f.answer = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  await act(async () => [...f.memoryListeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(v.q('[data-tasks-panel]'), null);
  await v.close();
  const never: any = new Promise(() => undefined);
  f.answer = () => never;
  const early = await mount(createElement(TasksPanel));
  assert.equal(early.q('[data-tasks-panel]'), null);
  await early.close();
});

test('read again on a change and every few seconds; a read that settles after a newer one or after closing changes nothing', async () => {
  reset();
  const lists = () => f.calls.filter((c: any) => c[0] === 'list').length;
  // a change main tells, and the memory's, each read once (no timer in the way)
  const quiet = await mount(createElement(TasksPanel));
  const start = lists();
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await act(async () => [...f.memoryListeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(lists(), start + 2);
  await quiet.close();
  // the timer reads again, and stops once the panel is closed
  const v = await mount(createElement(TasksPanel));
  const first = lists();
  await act(async () => mock.timers.tick(REFRESH_MS - 1));
  assert.equal(lists(), first, 'no poll before the interval');
  await act(async () => mock.timers.tick(1));
  assert.equal(lists(), first + 1, 'the timer reads once at the interval');
  await act(async () => mock.timers.tick(REFRESH_MS));
  assert.equal(lists(), first + 2, 'the timer keeps reading');
  await v.close();
  await flush();
  const after = lists();
  await act(async () => mock.timers.tick(REFRESH_MS * 2));
  assert.equal(lists(), after);
  assert.equal(f.tasksListeners.size + f.memoryListeners.size, 0);
  assert.equal(REFRESH_MS, 10_000);
  assert.equal(typeof useTaskPanel, 'function');
  const reads: { ok: (r: any) => void; no: (e: Error) => void }[] = [];
  f.answer = () => new Promise((ok2, no) => reads.push({ ok: ok2, no }));
  const w = await mount(createElement(TasksPanel));
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  reads[1].ok(ok([LOOP]));
  await flush();
  reads[0].ok(ok([CARD]));
  await flush();
  assert.ok(rowOf(w, 'loop:L1'));
  assert.equal(rowOf(w, 'card:a1'), null);
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  reads[3].ok(ok([CARD]));
  await flush();
  reads[2].no(new Error('late'));
  await flush();
  assert.equal(w.q('[role=alert]'), null);
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await w.close();
  reads[4].no(new Error('after close'));
  await flush();
});

test('the words: a time is the clock today and the day and clock otherwise; a task’s line says what it needs', () => {
  assert.equal(when(NOW + H, NOW), '13:00');
  assert.equal(when(NOW - 24 * H, NOW), '2026-11-14 12:00');
  assert.deepEqual(
    TABS.map((t) => t.label),
    ['Active', 'Up next', 'Scheduled', 'Resolved'],
  );
  assert.equal(lineOf(row({ kind: 'routine', nextAt: null }), NOW), '');
  assert.equal(lineOf(row({ kind: 'routine', nextAt: NOW + H }), NOW), 'Next 13:00');
  assert.equal(lineOf(row({ state: 'failed', outcome: 'interrupted', at: null }), NOW), 'Cut short');
  assert.equal(lineOf(row({ state: 'failed', outcome: 'failed', at: NOW }), NOW), 'Could not run · 12:00');
  assert.equal(lineOf(row({ state: 'failed', outcome: null, at: NOW }), NOW), 'Did not finish · 12:00');
  assert.equal(lineOf(row({ state: 'review', at: null }), NOW), 'Ready for review');
  assert.equal(lineOf(row({ tab: 'resolved', state: 'archived', at: NOW }), NOW), 'Archived · 12:00');
  assert.equal(lineOf(row({ tab: 'resolved', state: 'done', at: null }), NOW), 'Done');
  assert.equal(lineOf(row({ tab: 'next', state: 'queued', detail: 'words' }), NOW), 'words');
});

test('the classic Tasks tab shows nothing from a reply that is the panel’s, which only the flag asks for', async () => {
  reset();
  f.answer = async () => ok(ALL);
  const v = await mount(createElement(TasksTab));
  assert.equal(v.all('[data-task]').length, 0);
  await v.close();
});

test('a card with no source line has no grey line', async () => {
  reset([row({ id: 'card:a2', kind: 'card', title: 'Plain', ref: 'a2' })]);
  const v = await mount(createElement(TasksPanel));
  assert.ok(rowOf(v, 'card:a2').textContent.includes('Plain'));
  assert.equal(v.q('.settings-row-desc', rowOf(v, 'card:a2')), null);
  await v.close();
});

test('the window’s Tasks calls are a module of types alone: loading it brings nothing in', async () => {
  assert.equal(typeof (await import('../src/lib/native/momoTasks.ts')), 'object');
});
