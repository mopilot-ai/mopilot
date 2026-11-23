import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click, byText, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
// every file the page rendered, in order
const rendered: string[] = [];
const store = fakeStore<any>({ cloudTasks: [] });
let cwd: string | null = '/repo';
let statusText: any = 'status: running';
let diffResult: any = { ok: true, diff: '' };
let applyResult: any = { ok: true, output: '' };

stubStore({
  useStore: store.useStore,
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
  currentCwdForNewChat: () => cwd,
  loadCloudTasks: () => calls.push(['loadCloudTasks']),
});
installNativeStub({
  cloud: {
    status: async (id: string) => (calls.push(['status', id]), typeof statusText === 'string' ? { text: statusText } : statusText),
    diff: async (id: string) => (calls.push(['diff', id]), diffResult),
    apply: async (id: string, dir: string) => (calls.push(['apply', id, dir]), applyResult),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
mock.module('../src/components/diff/DiffView.tsx', {
  namedExports: {
    parseUnifiedDiff: (d: string) => d.split(',').map((path) => ({ path })),
    InlineDiff: ({ file }: any) => (rendered.push(file.path), h('div', { 'data-file': file.path })),
  },
});
const { CloudTask } = await import('../src/components/pages/CloudTask.tsx');

const meta = (host: HTMLElement) => host.querySelector('.cloud-meta')!.textContent!.trim();

test('loads status and diff, shows the state from the status text, and renders each changed file', async () => {
  store.setState({ cloudTasks: [] });
  statusText = 'status: in_progress';
  diffResult = { ok: true, diff: '' };
  calls.length = 0;
  const v = await render(h(CloudTask, { id: 't1' }));
  await flush();
  assert.deepEqual(calls, [['status', 't1'], ['diff', 't1'], ['loadCloudTasks']]);
  assert.equal(v.host.querySelector('.cloud-title')!.textContent, 'Cloud task');
  assert.equal(meta(v.host), 'In progress');
  assert.ok(v.host.querySelector('.cloud-state.running'));
  assert.equal(v.host.querySelector('.cloud-status')!.textContent, 'status: in_progress');
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'Codex is working in the cloud…');
  assert.ok((byText(v.host, 'Apply locally') as HTMLButtonElement).disabled);

  statusText = 'status: completed';
  diffResult = { ok: true, diff: 'a.ts,b.ts' };
  await click(v.host.querySelector('[title=Refresh]'));
  assert.equal(meta(v.host), 'Completed');
  assert.ok(!v.host.querySelector('.cloud-state.running'));
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
    ['a.ts', 'b.ts'],
  );
  assert.equal(v.host.querySelector('.empty-state'), null);
  await v.unmount();
});

test('the store task wins for title, environment, state and link; a failed diff shows its error', async () => {
  store.setState({ cloudTasks: [{ id: 't2', title: 'Fix bug', environment_label: 'env-a', status: 'ready', url: 'https://x/t2' }] });
  statusText = '';
  diffResult = { ok: false, error: 'no diff yet' };
  const v = await render(h(CloudTask, { id: 't2' }));
  await flush();
  assert.equal(v.host.querySelector('.cloud-title')!.textContent, 'Fix bug');
  assert.match(meta(v.host), /env-a\s*Ready/);
  assert.equal(v.host.querySelector('.cloud-status'), null);
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'no diff yet');
  calls.length = 0;
  await click(byText(v.host, 'Open in ChatGPT'));
  assert.deepEqual(calls, [['open', 'https://x/t2']]);
  await v.unmount();
});

test('with no state at all it waits for the diff, and an empty diff of a finished task says no changes', async () => {
  store.setState({ cloudTasks: [] });
  statusText = 'nothing to parse';
  let release!: (v: any) => void;
  diffResult = new Promise((r) => (release = r));
  const v = await render(h(CloudTask, { id: 't3' }));
  assert.ok(v.host.querySelector('.center-pad'), 'spinner while the diff loads');
  await act(async () => release({ ok: true, diff: '' }));
  await flush();
  assert.equal(meta(v.host), '');
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'Codex is working in the cloud…');
  calls.length = 0;
  await click(byText(v.host, 'Open in ChatGPT'));
  assert.deepEqual(calls, [['open', 'https://chatgpt.com/codex/tasks/t3']]);

  statusText = 'Error: task failed';
  diffResult = { ok: true, diff: '' };
  await click(v.host.querySelector('[title=Refresh]'));
  assert.equal(v.host.querySelector('.empty-state'), null, 'an error status says it all');

  store.setState({ cloudTasks: [{ id: 't3', status: 'COMPLETED' }] });
  statusText = 'done';
  await click(v.host.querySelector('[title=Refresh]'));
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'No changes');
  await v.unmount();
});

test('apply needs a project, then reports success or the last line of the failure', async () => {
  store.setState({ cloudTasks: [{ id: 't4', status: 'completed' }] });
  statusText = 'ok';
  diffResult = { ok: true, diff: 'a.ts' };
  const v = await render(h(CloudTask, { id: 't4' }));
  await flush();
  const apply = byText(v.host, 'Apply locally');
  cwd = null;
  calls.length = 0;
  await click(apply);
  assert.deepEqual(calls, [['toast', 'Choose a project to apply the changes to', 'error']]);

  cwd = '/repo';
  calls.length = 0;
  let finish!: (r: any) => void;
  applyResult = new Promise((r) => (finish = r));
  await click(apply);
  assert.ok((apply as HTMLButtonElement).disabled, 'disabled while applying');
  await act(async () => finish({ ok: true, output: '' }));
  assert.deepEqual(calls, [
    ['apply', 't4', '/repo'],
    ['toast', 'Applied changes locally', 'success'],
  ]);

  for (const [output, text] of [
    ['first\nconflict in a.ts', 'conflict in a.ts'],
    ['', 'Apply failed'],
  ]) {
    applyResult = { ok: false, output };
    calls.length = 0;
    await click(apply);
    assert.deepEqual(calls.at(-1), ['toast', text, 'error']);
  }
  // a request that fails says why, and the button comes back
  applyResult = Promise.reject(new Error('bridge gone'));
  applyResult.catch(() => {});
  calls.length = 0;
  await click(apply);
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't apply the changes: bridge gone", 'error']);
  assert.ok(!(apply as HTMLButtonElement).disabled);
  await v.unmount();
});

test('a read that fails says why instead of loading forever, and keeps the last diff it read', async () => {
  store.setState({ cloudTasks: [{ id: 't6', status: 'completed' }] });
  statusText = Promise.reject(new Error("Error invoking remote method 'cloud:status': Error: offline"));
  statusText.catch(() => {});
  diffResult = { ok: true, diff: '' };
  const v = await render(h(CloudTask, { id: 't6' }));
  await flush();
  assert.equal(v.host.querySelector('.center-pad'), null, 'no endless spinner');
  assert.equal(v.host.querySelector('.empty-state')!.textContent, "Couldn't read the task: offline");
  statusText = 'ok';
  diffResult = { ok: true, diff: 'a.ts' };
  await click(v.host.querySelector('[title=Refresh]'));
  await flush();
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
    ['a.ts'],
  );
  statusText = Promise.reject(new Error('offline'));
  statusText.catch(() => {});
  await click(v.host.querySelector('[title=Refresh]'));
  await flush();
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
    ['a.ts'],
  );
  await v.unmount();
});

test('an answer for a task the page has moved past is dropped, whether it read or failed', async () => {
  store.setState({ cloudTasks: [] });
  for (const late of ['answer', 'failure'] as const) {
    let release!: (v: any) => void;
    let fail!: (e: any) => void;
    diffResult = new Promise((resolve, reject) => ((release = resolve), (fail = reject)));
    statusText = 'status: running';
    const v = await render(h(CloudTask, { id: 'old' }));
    diffResult = { ok: true, diff: 'new.ts' };
    await v.rerender(h(CloudTask, { id: 'new' }));
    await flush();
    calls.length = 0;
    await act(async () => (late === 'answer' ? release({ ok: true, diff: 'old.ts' }) : fail(new Error('old task gone'))));
    await flush();
    assert.deepEqual(
      [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
      ['new.ts'],
    );
    assert.equal(v.host.querySelector('.empty-state'), null);
    assert.deepEqual(calls, [], 'nothing follows a dropped answer');
    await v.unmount();
  }
});

test("another task never renders the last one's diff, and is the one read and polled", async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let v: Awaited<ReturnType<typeof render>> | undefined;
  try {
    store.setState({ cloudTasks: [] });
    statusText = 'status: completed';
    diffResult = { ok: true, diff: 'a.ts' };
    v = await render(h(CloudTask, { id: 'a' }));
    await flush();
    assert.ok(v.host.querySelector('[data-file="a.ts"]'));
    rendered.length = 0;
    calls.length = 0;
    // the next task's diff is still being read
    diffResult = new Promise(() => {});
    await v.rerender(h(CloudTask, { id: 'b' }));
    assert.deepEqual(rendered, [], 'no frame of task b shows a.ts');
    assert.equal(v.host.querySelector('[data-file]'), null);
    await act(async () => mock.timers.tick(15000));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'status'),
      [
        ['status', 'b'],
        ['status', 'b'],
      ],
    );
  } finally {
    await v?.unmount();
    mock.timers.reset();
  }
});

test('a slow read of the same task that Refresh overtook never puts back its older status or diff', async (t) => {
  store.setState({ cloudTasks: [] });
  for (const late of ['answer', 'failure'] as const) {
    let release!: (v: any) => void;
    let fail!: (e: any) => void;
    statusText = 'status: running';
    diffResult = new Promise((resolve, reject) => ((release = resolve), (fail = reject)));
    const v = await render(h(CloudTask, { id: 'same' }));
    t.after(() => v.unmount());
    statusText = 'status: completed';
    diffResult = { ok: true, diff: 'new.ts' };
    await click(v.host.querySelector('[title=Refresh]'));
    await flush();
    await act(async () => (late === 'answer' ? release({ ok: true, diff: 'old.ts' }) : fail(new Error('slow read failed'))));
    await flush();
    assert.deepEqual(
      [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
      ['new.ts'],
    );
    assert.match(meta(v.host), /completed/i);
    assert.equal(v.host.querySelector('.empty-state'), null);
  }
});

test('polls every 15 seconds and stops when unmounted', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    store.setState({ cloudTasks: [] });
    diffResult = { ok: true, diff: '' };
    calls.length = 0;
    const v = await render(h(CloudTask, { id: 't5' }));
    const polls = () => calls.filter((c) => c[0] === 'status').length;
    assert.equal(polls(), 1);
    await act(async () => mock.timers.tick(15000));
    assert.equal(polls(), 2);
    await v.unmount();
    await act(async () => mock.timers.tick(30000));
    assert.equal(polls(), 2);
  } finally {
    mock.timers.reset();
  }
});

test('a task heading retires when the Cloud list belongs to a different account', async () => {
  const account = (email: string) => ({ type: 'chatgpt', email, planType: 'pro' });
  store.setState({
    account: account('first@example.test'),
    cloudSidebar: { account: '[null,"first@example.test"]', environments: [] },
    cloudTasks: [{ id: 'task_old', title: 'Earlier account task' }],
  });
  statusText = '';
  diffResult = { ok: true, diff: '' };
  const view = await render(h(CloudTask, { id: 'task_old' }));
  try {
    assert.equal(view.host.querySelector('.cloud-title')?.textContent, 'Earlier account task');
    await act(async () => store.setState({ account: account('second@example.test') }));
    assert.equal(view.host.querySelector('.cloud-title')?.textContent, 'Cloud task');
  } finally {
    await view.unmount();
    store.setState({ cloudSidebar: undefined, account: null });
  }
});
