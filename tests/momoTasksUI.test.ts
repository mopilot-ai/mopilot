// MoMo's Tasks tab in the window (src/components/momo/TasksTab.tsx): what needs the user (a card with Review, a loop with its own Done, Snooze and Dismiss) and what is running, read again on a change main tells and every few seconds; nothing is marked done by the tab itself; nothing shows while MoMo is not allowed; a failed read says so with Retry; a read that settles late changes nothing.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], tasksListeners: new Set(), memoryListeners: new Set() };
mockSource('src/store/panes.ts', { navigate: (r: any) => f.calls.push(['navigate', r]) });
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async () => undefined } });
installNativeStub({
  momoTasks: {
    list: async () => (f.calls.push(['list']), f.answer()),
    onChanged: (cb: () => void) => {
      f.tasksListeners.add(cb);
      return () => f.tasksListeners.delete(cb);
    },
  },
  momoMemory: {
    loopAct: async (id: string, a: any) => (f.calls.push(['loopAct', id, a]), f.actAnswer(id, a)),
    onChanged: (cb: () => void) => {
      f.memoryListeners.add(cb);
      return () => f.memoryListeners.delete(cb);
    },
  },
});
const { TasksTab, REFRESH_MS } = await import('../src/components/momo/TasksTab.tsx');

const task = (over: any) => ({
  id: 'x',
  kind: 'loop',
  state: 'needs-you',
  title: 'T',
  detail: null,
  at: null,
  dueAt: null,
  dueDay: null,
  ref: 'x',
  ...over,
});
const CARD = task({ id: 'card:a1', kind: 'card', title: 'Send the mail', detail: 'Mail', ref: 'a1' });
const LOOP = task({ id: 'loop:L1', ref: 'L1', title: 'Call mum', detail: 'call mum', dueAt: 5, dueDay: '2030-03-06' });
const BARE = task({ id: 'loop:L2', ref: 'L2', title: 'Water the plants' });
const RUN = task({ id: 'run:c1', kind: 'run', state: 'running', title: 'Daily brief', ref: 'c1', at: 1 });
const ok = (tasks: any[]) => ({ ok: true, tasks, now: 1 });
function reset(tasks = [CARD, LOOP, RUN]) {
  f.calls = [];
  f.answer = async () => ok(tasks);
  f.actAnswer = async () => ({ ok: true, loop: {} });
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
    close,
  };
}
const lists = () => f.calls.filter((c: any) => c[0] === 'list').length;

test('the tasks that need the user come first, each with its own controls; runs are listed apart, with no control', async () => {
  reset([CARD, LOOP, BARE, RUN]);
  const v = await mount(createElement(TasksTab));
  assert.deepEqual(
    v.all('.settings-group-title').map((t: any) => t.textContent),
    ['Needs you', 'Running'],
  );
  const row = (id: string) => v.q(`[data-task="${id}"]`);
  assert.ok(row('loop:L2'), 'a loop with no due day or words');
  assert.ok(row('card:a1').textContent.includes('Send the mail'));
  assert.ok(row('card:a1').textContent.includes('Mail'));
  assert.deepEqual(
    v.all('button', row('card:a1')).map((b: any) => b.textContent),
    ['Review'],
  );
  assert.ok(row('loop:L1').textContent.includes('Due 2030-03-06 · call mum'));
  assert.deepEqual(
    v.all('button', row('loop:L1')).map((b: any) => b.textContent),
    ['Done', 'Snooze', 'Dismiss', 'Add to Calendar', 'Remind me'],
  );
  assert.equal(v.all('button', row('run:c1')).length, 0);
  assert.equal(v.q('.momo-chip', row('run:c1')).textContent, 'Running');
  await v.close();
});

test('Review opens the chat where the card is answered; the tab answers nothing itself', async () => {
  reset();
  const v = await mount(createElement(TasksTab));
  await v.click(v.button('Review'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'navigate'),
    [['navigate', { name: 'momo', tab: 'chat' }]],
  );
  await v.close();
});

test('a channel’s card names its channel and Review opens that channel’s chat, not Main’s', async () => {
  const kitchen = task({
    id: 'card:ch_1:a9',
    kind: 'card',
    title: 'Order the oven',
    detail: 'Mail',
    ref: 'a9',
    channel: { id: 'ch_1', name: 'Kitchen' },
    chatId: 'chat-kitchen',
  });
  reset([CARD, kitchen]);
  const v = await mount(createElement(TasksTab));
  assert.ok(v.q('[data-task="card:ch_1:a9"]').textContent.includes('#Kitchen · Mail'));
  assert.ok(!v.q('[data-task="card:a1"]').textContent.includes('#'));
  await v.click(v.button('Review', v.q('[data-task="card:ch_1:a9"]')));
  await v.click(v.button('Review', v.q('[data-task="card:a1"]')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'navigate'),
    [
      ['navigate', { name: 'momo', tab: 'chat', chatId: 'chat-kitchen' }],
      ['navigate', { name: 'momo', tab: 'chat' }],
    ],
  );
  await v.close();
});

test('Done on a loop is the loop’s own call, then the list is read again without it', async () => {
  reset();
  const v = await mount(createElement(TasksTab));
  f.answer = async () => ok([CARD, RUN]);
  await v.click(v.button('Done', v.q('[data-task="loop:L1"]')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'loopAct'),
    [['loopAct', 'L1', { action: 'done' }]],
  );
  assert.equal(v.q('[data-task="loop:L1"]'), null);
  assert.ok(v.q('[data-task="card:a1"]'));
  await v.close();
});

test('with nothing to do it says so; no Running group without a run', async () => {
  reset([]);
  const v = await mount(createElement(TasksTab));
  assert.equal(v.q('.settings-group-title').textContent, 'Needs you');
  assert.ok(v.host.textContent.includes('Nothing needs you'));
  assert.equal(v.all('.settings-group-title').length, 1);
  await v.close();
});

test('while MoMo is not allowed nothing shows, even after tasks were shown', async () => {
  reset();
  const v = await mount(createElement(TasksTab));
  assert.ok(v.q('[data-task]'));
  f.answer = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(v.q('[data-task]'), null);
  assert.equal(v.q('[role=alert]'), null);
  assert.equal(v.all('.settings-group').length, 0);
  await v.close();
});

test('a read that fails says why with Retry, keeps what was shown, and the retry reads again; a rejection says why too', async () => {
  reset();
  f.answer = async () => ({ ok: false, error: 'disk is gone' });
  const v = await mount(createElement(TasksTab));
  assert.ok(v.q('[role=alert]').textContent.includes('read the tasks: disk is gone'));
  assert.equal(v.q('[data-task]'), null);
  f.answer = async () => ok([LOOP]);
  await v.click(v.button('Retry'));
  assert.equal(v.q('[role=alert]'), null);
  assert.ok(v.q('[data-task="loop:L1"]'));
  f.answer = async () => {
    throw new Error('ipc broke');
  };
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await flush();
  assert.ok(v.q('[role=alert]').textContent.includes('ipc broke'));
  assert.ok(v.q('[data-task="loop:L1"]'), 'what was shown stays');
  await v.close();
});

test('read again when main tells the loops or the memory changed, and every few seconds; none after the tab closed', async () => {
  reset();
  const v = await mount(createElement(TasksTab));
  const start = lists();
  await act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  await act(async () => [...f.memoryListeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(lists(), start + 2);
  await act(async () => mock.timers.tick(REFRESH_MS - 1));
  assert.equal(lists(), start + 2, 'no poll before the interval');
  await act(async () => mock.timers.tick(1));
  assert.equal(lists(), start + 3, 'the timer reads once at the interval');
  await v.close();
  const after = lists();
  await act(async () => mock.timers.tick(REFRESH_MS * 2));
  assert.equal(lists(), after);
  assert.equal(f.tasksListeners.size + f.memoryListeners.size, 0);
  assert.equal(REFRESH_MS, 10_000);
});

test('a read that settles after a newer one, or after the tab closed, changes nothing, whether it answered or failed', async () => {
  reset();
  const reads: { ok: (r: any) => void; no: (e: Error) => void }[] = [];
  f.answer = () => new Promise((ok, no) => reads.push({ ok, no }));
  const v = await mount(createElement(TasksTab));
  const again = () => act(async () => [...f.tasksListeners].forEach((cb: any) => cb()));
  // the first read is still out; a change asks again, and the newer one answers first
  await again();
  reads[1].ok(ok([LOOP]));
  await flush();
  reads[0].ok(ok([CARD]));
  await flush();
  assert.ok(v.q('[data-task="loop:L1"]'));
  assert.equal(v.q('[data-task="card:a1"]'), null);
  // an older read that fails or answers not allowed is not shown either
  await again();
  await again();
  reads[3].ok(ok([RUN]));
  await flush();
  reads[2].no(new Error('late'));
  await flush();
  assert.equal(v.q('[role=alert]'), null);
  assert.ok(v.q('[data-task="run:c1"]'));
  // a read still out when the tab closes changes nothing
  await again();
  await v.close();
  reads[4].ok(ok([CARD]));
  await flush();
});
