// A routine's row menu in the Tasks panel's Scheduled tab (src/components/momo/tasks/TaskRow.tsx, #4975): Run now starts a run and says so (off while one is going), Pause or Resume says so in a toast, View history lists the runs or says it hasn’t run yet, Rename opens the name on the row (Save, Cancel, Escape, a refused name stays open), Delete removes at once with no confirm; Pause all is MoMo's own pause.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
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
    runNow: async (id: string) => (f.calls.push(['runNow', id]), f.runAnswer()),
    history: async (id: string) => (f.calls.push(['history', id]), f.historyAnswer()),
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
const { useStore } = await import('../src/store/core.ts');

const NOW = new Date(2026, 10, 15, 12, 0).getTime();
const row = (over: any) => ({
  id: 'x',
  kind: 'routine',
  tab: 'scheduled',
  state: 'scheduled',
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
const ROUTINE = row({ id: 'routine:r1', title: 'Morning brief', ref: 'r1', nextAt: NOW + 20 * 3_600_000 });
const PAUSED = row({ id: 'routine:r2', title: 'Cleanup', ref: 'r2', paused: true });
const ALL = [ROUTINE, PAUSED];
const ok = (tasks: any[], paused = false) => ({ ok: true, v: 2, tasks, paused, now: NOW });
function reset() {
  f.calls = [];
  f.answer = async () => ok(ALL);
  f.editAnswer = async () => ({ id: 'r1' });
  f.removeAnswer = async () => true;
  f.runAnswer = async () => ({ chatId: 'c1' });
  f.historyAnswer = async () => [];
  useStore.setState({ toasts: [] });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function mount(el: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
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
    close: () => act(async () => root.unmount()),
  };
}
const rowOf = (v: any, id: string) => v.q(`[data-task="${id}"]`);
const toasts = () => useStore.getState().toasts as any[];

const menuItem = (label: string) =>
  [...window.document.querySelectorAll('[role=menuitem]')].find((m: any) => m.textContent.trim() === label) as any;

test('a routine’s menu pauses or resumes it and says so; Pause all is MoMo’s own pause and Resume all brings it back', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Scheduled'));
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  assert.deepEqual(
    [...window.document.querySelectorAll('[role=menuitem]')].map((m: any) => m.textContent.trim()),
    ['Run now', 'Pause', 'Rename', 'View history', 'Delete'],
  );
  await v.click(menuItem('Pause'));
  assert.equal(toasts().at(-1).text, 'Paused Morning brief');
  await v.click(v.button('…', rowOf(v, 'routine:r2')));
  await v.click(menuItem('Resume'));
  assert.equal(toasts().at(-1).text, 'Resumed Cleanup');
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'edit'),
    [
      ['edit', 'r1', { paused: true }],
      ['edit', 'r2', { paused: false }],
    ],
  );
  await v.click(v.button('Pause all'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'pref'),
    [['pref', 'paused', true]],
  );
  f.answer = async () => ok(ALL, true);
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  await v.click(v.button('Resume all'));
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'pref').at(-1), ['pref', 'paused', false]);
  // a routine that cannot be changed says why
  f.editAnswer = async () => {
    throw new Error('routine is gone');
  };
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  await v.click(menuItem('Pause'));
  assert.equal(toasts().at(-1).text, 'routine is gone');
  await v.close();
});

test('Rename opens the name on the row: Save keeps a new name, the same or an empty one and Cancel change nothing, a refused one stays open', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Scheduled'));
  const row = () => rowOf(v, 'routine:r1');
  const typeName = async (text: string) => {
    const input = v.q('input', row());
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, text);
      input.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => void v.q('form', row()).dispatchEvent(new (window as any).Event('submit', { bubbles: true, cancelable: true })));
    await flush();
  };
  const open = async () => {
    await v.click(v.button('…', row()));
    await v.click(menuItem('Rename'));
  };
  await open();
  assert.equal(v.q('input', row()).value, 'Morning brief');
  await submit();
  assert.equal(v.q('input', row()), null, 'the same name closes');
  await open();
  await typeName('   ');
  await submit();
  assert.equal(v.q('input', row()), null, 'an empty name closes');
  assert.equal(f.calls.filter((c: any) => c[0] === 'edit').length, 0, 'neither saves anything');
  await open();
  await v.click(v.button('Cancel', row()));
  assert.equal(v.q('input', row()), null);
  await open();
  // Escape that ends an input method's composition leaves the field open
  await act(async () =>
    v.q('form', row()).dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })),
  );
  assert.ok(v.q('input', row()));
  await act(async () => v.q('form', row()).dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(v.q('input', row()), null, 'Escape leaves it');
  await open();
  f.editAnswer = async () => {
    throw new Error('That name is taken.');
  };
  await typeName('Evening brief');
  await submit();
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'edit').at(-1), ['edit', 'r1', { name: 'Evening brief' }]);
  assert.equal(toasts().at(-1).text, 'That name is taken.');
  assert.ok(v.q('input', row()), 'a refused name stays for the user to fix');
  f.editAnswer = async () => ({ id: 'r1' });
  await submit();
  assert.equal(v.q('input', row()), null);
  await v.close();
});

test('Delete removes the routine at once, with no confirm, and says so; a failure says why', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Scheduled'));
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  await v.click(menuItem('Delete'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'remove'),
    [['remove', 'r1']],
  );
  assert.equal(toasts().at(-1).text, 'Deleted Morning brief');
  f.removeAnswer = async () => {
    throw new Error('Could not delete.');
  };
  await v.click(v.button('…', rowOf(v, 'routine:r2')));
  await v.click(menuItem('Delete'));
  assert.equal(toasts().at(-1).text, 'Could not delete.');
  await v.close();
});

test('Run now starts a run and says so; one already going has it off, its row says Working since when; a refusal says why', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Scheduled'));
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  await v.click(menuItem('Run now'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'runNow'),
    [['runNow', 'r1']],
  );
  assert.equal(toasts().at(-1).text, 'Started “Morning brief”');
  // a refused one says why and starts nothing more
  f.runAnswer = async () => {
    throw new Error('It’s already running.');
  };
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  await v.click(menuItem('Run now'));
  assert.equal(toasts().at(-1).text, 'It’s already running.');
  // the row of a routine with a run going: Working, started just now (and a while ago says when); Run now is off
  f.answer = async () => ok([{ ...ROUTINE, at: NOW - 5_000 }, PAUSED]);
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.match(rowOf(v, 'routine:r1').textContent, /Working · started just now/);
  await v.click(v.button('…', rowOf(v, 'routine:r1')));
  assert.equal(menuItem('Run now').getAttribute('aria-disabled'), 'true', 'a second Run now cannot be clicked while one goes');
  const before = f.calls.filter((c: any) => c[0] === 'runNow').length;
  await v.click(menuItem('Run now'));
  assert.equal(f.calls.filter((c: any) => c[0] === 'runNow').length, before, 'and a click starts nothing');
  f.answer = async () => ok([{ ...ROUTINE, at: NOW - 3 * 3_600_000 }, PAUSED]);
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.match(rowOf(v, 'routine:r1').textContent, /Working · started 11-1[45] \d\d:\d\d|Working · started \d\d:\d\d/);
  await v.close();
});

test('View history lists a routine’s runs with when and how each went, or says it hasn’t run yet; a failed read says why; Close leaves', async () => {
  reset();
  const v = await mount(createElement(TasksPanel));
  await v.click(v.tab('Scheduled'));
  const open = async () => {
    await v.click(v.button('…', rowOf(v, 'routine:r1')));
    await v.click(menuItem('View history'));
  };
  await open();
  const dialog = () => window.document.querySelector('.dialog') as any;
  assert.match(dialog().textContent, /Morning brief/);
  assert.match(dialog().textContent, /Hasn’t run yet/);
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'history'),
    [['history', 'r1']],
  );
  await v.click(dialog().querySelector('[aria-label=Close]'));
  assert.equal(dialog(), null);
  f.historyAnswer = async () => [
    { startedAt: NOW - 1_000, endedAt: null, outcome: 'running' },
    { startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000, outcome: 'completed' },
    { startedAt: NOW - 7_200_000, endedAt: NOW - 7_000_000, outcome: 'interrupted' },
    { startedAt: NOW - 9_000_000, endedAt: NOW - 8_900_000, outcome: 'other' },
  ];
  await open();
  assert.deepEqual(
    [...dialog().querySelectorAll('li')].map((li: any) => li.textContent.replace(/^\d\d:\d\d/, 'HH:MM')),
    ['HH:MM · Working', 'HH:MM · Finished', 'HH:MM · Cut short', 'HH:MM · Did not finish'],
  );
  await v.click(dialog().querySelector('[aria-label=Close]'));
  f.historyAnswer = async () => {
    throw new Error('MoMo is not available for this account.');
  };
  await open();
  assert.match(dialog().querySelector('[role=alert]').textContent, /not available for this account/);
  await v.close();
});
