// Scheduled: "Runs on" in the task dialog (src/components/pages/scheduled/RunsOnField.tsx): this Mac or one of the user's machines, a folder picked on the machine, the agents it has, how a run there signs in, and the machine shown on the task.
import { test } from 'node:test';
import {
  assert,
  fx,
  act,
  calls,
  store,
  both,
  dialog,
  pick,
  sel,
  savedTask,
  render,
  click,
  byText,
  maybeText,
  flush,
  task,
} from './support/scheduled-page.ts';

const box = (o: any = {}) => ({
  id: 'box',
  name: 'build-box',
  status: 'online',
  note: '',
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'codex', label: 'Codex', state: 'ready', reason: '', lent: true },
    { id: 'kimi', label: 'Kimi Code', state: 'signin', reason: 'Sign in on build-box' },
  ],
  ...o,
});
const credential = (d: HTMLElement) => d.querySelector('[data-testid="sched-machine-credential"]');

async function editTask(t: any) {
  fx.list = [t];
  const v = await render(both());
  await flush();
  await click(byText(v.host, t.name, '.sched-row'));
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  return v;
}

test('with no machines there is no Runs on, and a task saves for this Mac as before', async () => {
  fx.machines = [];
  const v = await editTask(task('m0'));
  const d = dialog(v.host)!;
  assert.equal(d.querySelector('[aria-label="Runs on"]'), null);
  await click(byText(d, 'Save'));
  assert.equal(savedTask().host_id, undefined);
  assert.deepEqual(savedTask().cwds, ['/w/proj']);
  await v.unmount();
});

test('a task moved to a machine needs a folder there, says how it signs in, and saves the machine, its folder and its project', async () => {
  fx.machines = [box(), box({ id: 'off', name: 'old-mini', status: 'offline' })];
  store.setState({ prefs: { hostFolders: {} } });
  const v = await editTask(task('m1', { harness: 'claude' }));
  const d = dialog(v.host)!;
  assert.equal(sel(d, 'Runs on'), 'This Mac');
  await pick(d, 'Runs on', 'build-box');
  assert.equal(sel(d, 'Folder on the machine'), 'Choose…');
  assert.equal((byText(d, 'Save') as HTMLButtonElement).disabled, true);
  assert.equal(credential(d)!.textContent, 'Signed in on build-box');
  assert.ok(maybeText(d, 'build-box runs it on schedule, even while this Mac is off.', '.sched-where-note'));
  // a machine runs in its folder: no worktree toggle, and the harness note is the machine's
  await click(byText(d, 'Advanced'));
  assert.equal(d.querySelector('[aria-label="Run on this computer"]'), null);
  await click(d.querySelector('[aria-label="Run with"]'));
  assert.deepEqual(
    [...d.querySelectorAll('[role=menuitem]')].map((e) => e.firstChild?.textContent),
    ['Claude Code', 'Codex', 'Kimi Code'],
  );
  await click(byText(d, 'Codex', '[role=menuitem]'));
  assert.equal(credential(d)!.textContent, "Uses this Mac's key · needs this Mac online");
  assert.ok(maybeText(d, 'This Mac starts each run on build-box, so it needs this Mac on.', '.sched-where-note'));
  await pick(d, 'Run with', 'Kimi Code');
  assert.equal(credential(d)!.className.includes('warn'), true);
  assert.equal(credential(d)!.textContent, 'Sign in to Kimi Code on build-box');
  // the folder picker: closed without a pick changes nothing, a pick fills it
  await click(d.querySelector('[aria-label="Folder on the machine"]'));
  await click(byText(d, 'Close picker'));
  assert.equal(d.querySelector('[data-testid="host-folder-picker"]'), null);
  await click(d.querySelector('[aria-label="Folder on the machine"]'));
  await click(byText(d, 'Use folder'));
  assert.equal(sel(d, 'Folder on the machine'), 'box');
  calls.length = 0;
  await click(byText(d, 'Save'));
  const saved = savedTask();
  assert.equal(saved.host_id, 'box');
  assert.deepEqual(saved.cwds, ['/srv/box']);
  assert.equal(saved.project_id, 'p-proj');
  assert.equal(saved.execution_environment, 'local');
  assert.equal(saved.harness, 'acp:kimi');
  await v.unmount();
});

test('picking a machine starts in the folder last used there, and an agent it lacks gives way to one it has', async () => {
  fx.machines = [
    box({ agents: [{ id: 'codex', label: 'Codex', state: 'ready', reason: '' }] }),
    box({ id: 'empty', name: 'empty', agents: [] }),
  ];
  store.setState({ prefs: { hostFolders: { box: '/home/me/app/' } } });
  const v = await editTask(task('m2', { harness: 'claude' }));
  const d = dialog(v.host)!;
  await pick(d, 'Runs on', 'build-box');
  assert.equal(sel(d, 'Folder on the machine'), 'app');
  await click(byText(d, 'Advanced'));
  assert.equal(sel(d, 'Run with'), 'Codex');
  // a machine with no agent keeps the harness the task had
  await pick(d, 'Runs on', 'empty');
  assert.equal(sel(d, 'Run with'), 'Codex');
  assert.equal(credential(d)!.textContent, "Codex isn't installed on empty");
  // back to this Mac: no machine fields, and the folder the task had here
  await pick(d, 'Runs on', 'This Mac');
  assert.equal(d.querySelector('[aria-label="Folder on the machine"]'), null);
  assert.ok(d.querySelector('[aria-label="Run on this computer"]'));
  calls.length = 0;
  await click(byText(d, 'Save'));
  assert.equal(savedTask().host_id, undefined);
  assert.deepEqual(savedTask().cwds, ['/w/proj']);
  store.setState({ prefs: {} });
  await v.unmount();
});

test('a machine task shows its machine; one that left the list stays the task’s, named by its id, until another is picked', async () => {
  fx.machines = [box()];
  const on = task('m3', { harness: 'claude', host_id: 'box', cwds: ['/srv/app'], project_id: 'p9', fired_by: 'machine' });
  // a run the machine fired while this Mac was away names the machine; one of a machine that left the list, its id
  fx.runs.m3 = [
    { taskId: 'm3', scheduledFor: 2000, status: 'started', by: { machine: 'box' } },
    { taskId: 'm3', scheduledFor: 1000, status: 'started', by: { machine: 'gone-box' } },
  ];
  const v = await editTask(on);
  await flush();
  assert.deepEqual(
    [...v.host.querySelectorAll('.sched-run-source')].map((e) => e.textContent),
    ['build-box', 'gone-box'],
  );
  assert.equal(v.host.querySelector('[data-testid="task-machine"]')!.textContent, 'On build-box');
  // its machine fires it: the card says so instead of naming this Mac's apps
  assert.match(v.host.querySelector('.task-detail')!.textContent!, /build-boxRuns this task on schedule, even while this Mac is off/);
  let d = dialog(v.host)!;
  assert.equal(sel(d, 'Runs on'), 'build-box');
  assert.equal(sel(d, 'Folder on the machine'), 'app');
  calls.length = 0;
  await click(byText(d, 'Save'));
  // its project stays the one it was saved with
  assert.equal(savedTask().project_id, 'p9');
  await v.unmount();

  // back to this Mac: it runs in its project's folder here
  const fromBox = await editTask(task('m5', { harness: 'claude', host_id: 'box', cwds: ['/srv/app'], project_id: 'p-proj' }));
  const back = dialog(fromBox.host)!;
  await pick(back, 'Runs on', 'This Mac');
  calls.length = 0;
  await click(byText(back, 'Save'));
  assert.deepEqual(savedTask().cwds, ['/w/proj']);
  assert.equal(savedTask().project_id, undefined);
  await fromBox.unmount();

  fx.machines = [];
  const gone = await editTask(task('m4', { host_id: 'lost', cwds: [] }));
  assert.equal(gone.host.querySelector('[data-testid="task-machine"]')!.textContent, 'On lost');
  d = dialog(gone.host)!;
  assert.equal(sel(d, 'Runs on'), 'lost');
  assert.equal((d.querySelector('[aria-label="Folder on the machine"]') as HTMLButtonElement).disabled, true);
  assert.equal(credential(d)!.textContent, "This machine isn't in your list");
  await click(d.querySelector('[aria-label="Runs on"]'));
  assert.deepEqual(
    [...d.querySelectorAll('[role=menuitem]')].map((e) => e.firstChild?.textContent),
    ['This Mac', 'lost'],
  );
  await click(byText(d, 'This Mac', '[role=menuitem]'));
  calls.length = 0;
  await click(byText(d, 'Save'));
  // a task that was on a machine has no folder of this Mac: it runs in the home folder
  assert.equal(savedTask().host_id, undefined);
  assert.equal(savedTask().cwds, undefined);
  await act(async () => gone.unmount());
});
