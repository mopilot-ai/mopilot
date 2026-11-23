// The morning brief on the Mac (A7): a line of it in MoMo's chat is a plain MoMo line, or for a suggestion its card with the source line and Hide and Start (the user's own presses on the Mac; what was done shows in place of the buttons, a suggestion already gone says Done, a refusal says why); in Tasks › Scheduled its row says its next time, that it is paused because the user was away for a week, or "Couldn't start" with the reason and Try again, which writes the brief now and says why when it cannot.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(ms !== undefined && ms >= 3000 ? () => undefined : fn, ms !== undefined && ms >= 3000 ? 0 : ms, ...rest)) as any;

const waiting = { id: 's1', title: 'Reply to Sam' };
const f: any = {
  calls: [],
  tasks: [],
  listeners: new Set(),
  runNow: async () => ({ ok: true }),
  act: async () => ({ ok: true }),
  list: async () => ({ ok: true, v: 1, suggestions: [waiting], shown: 6, done: {}, now: 0 }),
};
mockSource('src/store/panes.ts', { navigate: (r: any) => f.calls.push(['navigate', r]) });
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async () => undefined } });
installNativeStub({
  momoTasks: {
    list: async () => ({ ok: true, v: 2, tasks: f.tasks, paused: false, now: NOW }),
    mark: async () => ({ ok: true }),
    onChanged: () => () => undefined,
  },
  momoSuggestions: {
    list: async () => f.list(),
    onChanged: (cb: () => void) => (f.listeners.add(cb), () => f.listeners.delete(cb)),
    act: async (...a: any[]) => (f.calls.push(['act', ...a]), f.act(...a)),
  },
  momoBrief: { runNow: async () => (f.calls.push(['runNow']), f.runNow()) },
  momoMemory: { loopAct: async () => ({ ok: true, loop: {} }), onChanged: () => () => undefined },
  momoRoutines: { edit: async () => ({}) },
  momoPrefs: { set: async () => true },
});
const { BriefLine } = await import('../src/components/momo/BriefLine.tsx');
const { TasksPanel } = await import('../src/components/momo/tasks/TasksPanel.tsx');
const { lineOf } = await import('../src/components/momo/tasks/taskCopy.ts');
const { useStore } = await import('../src/store/core.ts');

const NOW = new Date(2026, 10, 16, 6, 0).getTime();
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
  const all = (sel: string) => [...host.querySelectorAll(sel)] as any[];
  const click = async (b: any) => {
    await act(async () => b.click());
    await flush();
  };
  return { host, all, q: (sel: string) => host.querySelector(sel) as any, click, close: () => act(async () => root.unmount()) };
}
const card = { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam, Lease' };

test('a line of the brief is a plain MoMo line; with a suggestion it is a card with its source and Hide and Start; a malformed suggestion is only the line', async () => {
  const line = await mount(createElement(BriefLine, { text: 'Good morning, Mo.' }));
  assert.equal(line.host.textContent, 'Good morning, Mo.');
  assert.equal(line.all('button').length, 0);
  await line.close();
  const bad = await mount(createElement(BriefLine, { text: 'Reply', suggestion: { id: 'bad id', title: 'T' } }));
  assert.equal(bad.all('button').length, 0);
  await bad.close();
  const v = await mount(createElement(BriefLine, { text: 'Reply to Sam', suggestion: card }));
  assert.ok(v.host.textContent!.includes('Mail: Sam, Lease'));
  assert.deepEqual(
    v.all('button').map((b) => b.getAttribute('aria-label')),
    ['Hide Reply to Sam', 'Start Reply to Sam'],
  );
  assert.deepEqual(f.calls, [], 'showing a card sends nothing');
  await v.close();
});

test('Hide and Start are the user’s presses on the suggestion; each says what was done in place of the buttons', async () => {
  for (const [name, said] of [
    ['Hide', 'Hidden'],
    ['Start', 'Started'],
  ]) {
    f.calls = [];
    const v = await mount(createElement(BriefLine, { text: 'T', suggestion: card }));
    await v.click(v.all('button').find((b) => b.getAttribute('aria-label') === `${name} Reply to Sam`));
    assert.deepEqual(f.calls, [['act', 's1', name.toLowerCase()]]);
    assert.equal(v.all('button').length, 0);
    assert.ok(v.host.textContent!.includes(said));
    await v.close();
  }
});

test('a card reads what became of its suggestion from the Mac when it opens, and again when the Mac says it changed', async () => {
  const open = async () => mount(createElement(BriefLine, { text: 'T', suggestion: card }));
  const answer = (suggestions: object[], done: object) => async () => ({ ok: true, v: 1, suggestions, shown: 6, done, now: 0 });
  f.list = answer([], { s1: 'start' });
  const started = await open();
  assert.ok(started.host.textContent!.includes('Started'));
  assert.equal(started.all('button').length, 0);
  await started.close();
  f.list = answer([], { s1: 'hide' });
  const hidden = await open();
  assert.ok(hidden.host.textContent!.includes('Hidden'));
  await hidden.close();
  // not listed and nothing done: it expired or went
  f.list = answer([], {});
  const gone = await open();
  assert.ok(gone.host.textContent!.includes('Done'));
  await gone.close();
  // listed: still waiting, then started on another window
  f.list = answer([waiting], {});
  const waitingCard = await open();
  assert.equal(waitingCard.all('button').length, 2);
  f.list = answer([], { s1: 'start' });
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.ok(waitingCard.host.textContent!.includes('Started'));
  await waitingCard.close();
  // a read that fails or is refused leaves the buttons
  f.list = async () => Promise.reject(new Error('Mac went away'));
  const failing = await open();
  assert.equal(failing.all('button').length, 2);
  await failing.close();
  f.list = async () => ({ ok: false, reason: 'unavailable', error: 'off' });
  const off = await open();
  assert.equal(off.all('button').length, 0, 'suggestions are off: only the brief’s line');
  assert.ok(off.host.textContent!.includes('T'));
  await off.close();
  f.list = async () => ({ ok: true, v: 1, suggestions: [waiting], shown: 6, done: {}, now: 0 });
});

test('a read that settles after the card went away changes nothing', async () => {
  const late: { resolve: (r: any) => void } = { resolve: () => undefined };
  f.list = () => new Promise((resolve) => (late.resolve = resolve));
  const v = await mount(createElement(BriefLine, { text: 'T', suggestion: card }));
  await v.close();
  late.resolve({ ok: true, v: 1, suggestions: [], shown: 6, done: { s1: 'start' }, now: 0 });
  await flush();
  f.list = async () => ({ ok: true, v: 1, suggestions: [waiting], shown: 6, done: {}, now: 0 });
});

test('a suggestion that is gone says Done; a refusal and a throw say why and keep the buttons', async () => {
  f.act = async () => ({ ok: false, reason: 'gone', error: 'That suggestion is gone.' });
  const gone = await mount(createElement(BriefLine, { text: 'T', suggestion: card }));
  await gone.click(gone.all('button')[1]);
  assert.ok(gone.host.textContent!.includes('Done'));
  await gone.close();
  f.act = async () => ({ ok: false, error: 'MoMo is paused. Resume it first.' });
  const refused = await mount(createElement(BriefLine, { text: 'T', suggestion: card }));
  await refused.click(refused.all('button')[1]);
  assert.equal(refused.q('[role=alert]').textContent, 'MoMo is paused. Resume it first.');
  assert.equal(refused.all('button').length, 2);
  f.act = async () => {
    throw new Error('Mac went away');
  };
  await refused.click(refused.all('button')[0]);
  assert.match(refused.q('[role=alert]').textContent, /Mac went away/);
  await refused.close();
  f.act = async () => ({ ok: true });
});

const brief = (over: any) => ({
  id: 'brief:morning',
  kind: 'brief',
  tab: 'scheduled',
  state: 'scheduled',
  title: 'Morning brief',
  detail: null,
  at: null,
  dueAt: null,
  dueDay: null,
  ref: 'momo.brief',
  outcome: null,
  nextAt: NOW + 3_600_000,
  paused: false,
  ...over,
});
const rowText = (v: any) => v.q('[data-task="brief:morning"]').textContent as string;
async function scheduled(row: any) {
  f.calls = [];
  f.tasks = [row];
  useStore.setState({ toasts: [] });
  const v = await mount(createElement(TasksPanel));
  await v.click(v.all('[role=tab]').find((t) => t.textContent.startsWith('Scheduled')));
  return v;
}

test('Scheduled: the brief’s row says its next time; suspended it says why; and no Try again unless it could not start', async () => {
  const ok = await scheduled(brief({}));
  assert.ok(rowText(ok).includes('Morning brief') && rowText(ok).includes('Next 07:00'));
  assert.equal(ok.all('[data-task="brief:morning"] button').length, 0);
  await ok.close();
  const away = await scheduled(brief({ paused: true, nextAt: null, detail: 'Paused because you were away for a week.' }));
  assert.ok(rowText(away).includes('Paused because you were away for a week.'));
  assert.equal(rowText(away).includes('Next'), false);
  await away.close();
  const none = await scheduled(brief({ nextAt: null }));
  assert.equal(rowText(none), 'Morning brief');
  await none.close();
});

test('a brief that could not start shows "Couldn’t start" with its reason and Try again, which writes it now; a refusal says why in a toast', async () => {
  const failed = brief({ state: 'failed', detail: 'MoMo’s brain is not signed in.' });
  assert.equal(lineOf(failed, NOW), 'Couldn’t start · MoMo’s brain is not signed in.');
  const v = await scheduled(failed);
  assert.ok(rowText(v).includes('Couldn’t start · MoMo’s brain is not signed in.'));
  const button = v.all('[data-task="brief:morning"] button').find((b) => b.textContent === 'Try again');
  await v.click(button);
  assert.deepEqual(f.calls, [['runNow']]);
  f.runNow = async () => ({ ok: false, reason: 'skipped', error: 'Nothing to tell you today.' });
  await v.click(button);
  assert.equal((useStore.getState().toasts as any[]).at(-1).text, 'Nothing to tell you today.');
  f.runNow = async () => {
    throw new Error('Mac went away');
  };
  await v.click(button);
  assert.match((useStore.getState().toasts as any[]).at(-1).text, /Mac went away/);
  await v.close();
  f.runNow = async () => ({ ok: true });
});
