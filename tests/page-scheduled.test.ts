// Scheduled task list, dialog, editing and run-ledger behavior.
import { test, mock } from 'node:test';
import {
  assert,
  fx,
  h,
  act,
  calls,
  store,
  sessions,
  next,
  changedListeners,
  changed,
  Scheduled,
  ScheduledNav,
  task,
  both,
  navNames,
  dialog,
  pick,
  sel,
  savedTask,
  render,
  click,
  byText,
  maybeText,
  type,
  flush,
} from './support/scheduled-page.ts';
test('the list loads, filters by status and search, and sorts by the next run', async () => {
  const today = new Date();
  today.setHours(23, 59, 0, 0);
  const later = new Date(Date.now() + 3 * 86400_000);
  next['R-a'] = later;
  next['R-b'] = today;
  fx.list = [
    task('a', { name: 'Alpha' }),
    task('b', { name: 'Beta' }),
    task('c', { name: 'Gamma', status: 'PAUSED' }),
    task('d', { name: 'Delta' }),
  ];
  let release!: () => void;
  fx.listGate = new Promise<void>((r) => (release = r));
  const all = fx.list;
  fx.list = [];
  const v = await render(h(ScheduledNav));
  assert.match(v.host.textContent!, /Loading…/);
  await act(async () => release());
  await flush();
  fx.listGate = null;
  assert.match(v.host.textContent!, /No scheduled tasks/);
  await v.unmount();
  fx.list = all;

  const w = await render(both());
  await flush();
  assert.deepEqual(navNames(w.host), ['Beta', 'Alpha', 'Gamma', 'Delta']);
  const whens = [...w.host.querySelectorAll('.sched-when')].map((e) => e.textContent);
  assert.equal(whens[0], today.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.equal(whens[1], later.toLocaleDateString([], { weekday: 'short' }));
  assert.deepEqual(whens.slice(2), ['Paused', 'No next run'], 'active with no next time is not paused (#1862)');
  await pick(w.host, 'Filter', 'Paused');
  assert.deepEqual(navNames(w.host), ['Gamma']);
  await pick(w.host, 'Filter', 'Active');
  assert.deepEqual(navNames(w.host), ['Beta', 'Alpha', 'Delta']);
  await pick(w.host, 'Filter', 'All tasks');
  await click(w.host.querySelector('[aria-label=Search]'));
  await type(w.host.querySelector('input[placeholder="Search tasks"]'), 'ALP');
  assert.deepEqual(navNames(w.host), ['Alpha']);
  await type(w.host.querySelector('input[placeholder="Search tasks"]'), 'nope');
  assert.match(w.host.textContent!, /No scheduled tasks/);
  await type(w.host.querySelector('input[placeholder="Search tasks"]'), '');
  await click(w.host.querySelector('[aria-label=Search]'));
  assert.equal(w.host.querySelector('input[placeholder="Search tasks"]'), null);
  await w.unmount();
});

test('the empty page offers templates and the scheduler switch, which is on unless turned off', async () => {
  fx.list = [];
  store.setState({ prefs: {} });
  const v = await render(h(Scheduled));
  assert.match(v.host.textContent!, /Schedule a task/);
  assert.match(v.host.textContent!, /Codex, Claude Code or another harness/);
  assert.match(v.host.querySelector('.sched-notice')!.textContent!, /Each time runs once/);
  calls.length = 0;
  await click(byText(v.host.querySelector('.sched-notice')!, 'Turn off'));
  assert.deepEqual(calls, [['prefs', { schedulerOff: true }]]);
  assert.match(
    v.host.querySelector('.sched-notice')!.textContent!,
    /The scheduler is off\. Tasks run only while the Codex app or Claude Desktop is open/,
  );
  await click(byText(v.host.querySelector('.sched-notice')!, 'Turn on'));
  assert.deepEqual(calls.at(-1), ['prefs', { schedulerOff: false }]);
  await v.unmount();
});

test('a template opens a filled-in dialog; creating saves it and selects the id main gave it', async () => {
  fx.list = [];
  fx.usable = { codex: true, claude: true };
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Email monitor', '.sched-template'));
  const d = dialog(v.host)!;
  assert.equal(d.querySelector('.sched-dialog-head span')!.textContent, 'Schedule a task');
  assert.equal(
    (d.querySelector('textarea') as HTMLTextAreaElement).value,
    'Scan my recent email and tell me about anything that needs my attention or a reply, most urgent first.',
  );
  assert.equal(sel(d, 'Repeat schedule'), 'Daily');
  assert.match(sel(d, 'Time')!, /^9:00 AM/);
  calls.length = 0;
  await click(byText(d, 'Create'));
  const saved = savedTask();
  assert.equal(saved.id, '', 'main names it');
  assert.equal(saved.rrule, 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
  assert.equal(saved.kind, 'heartbeat', 'a new task keeps its chat');
  assert.equal(saved.execution_environment, 'local');
  assert.equal(saved.harness, 'codex');
  assert.equal(saved.model, 'gpt-5');
  assert.equal(saved.reasoning_effort, 'high');
  assert.equal(saved.computer_control, false);
  assert.equal(saved.on_approval, 'wait');
  assert.deepEqual(saved.cwds, ['/work/app']);
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === 'Scheduled task saved'));
  assert.equal(dialog(v.host), null);
  assert.equal(v.host.querySelector('.page-title')!.textContent, 'Email monitor');
  assert.equal(fx.list[0].id, 'made-email-monitor');
  await v.unmount();
});

test('a save main refuses says why and keeps the dialog open', async () => {
  fx.list = [];
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'News updates', '.sched-template'));
  for (const [err, text] of [
    [new Error('disk full'), 'disk full'],
    ['plain', 'plain'],
  ] as const) {
    fx.saveFail = err;
    calls.length = 0;
    await click(byText(dialog(v.host)!, 'Create'));
    assert.deepEqual(calls.at(-1), ['toast', `Couldn't save the task: ${text}`, 'error']);
    assert.ok(dialog(v.host));
  }
  fx.saveFail = null;
  await click(byText(dialog(v.host)!, 'Cancel'));
  await v.unmount();
});

test('new task: only Claude Code installed runs with it; the name comes from the prompt', async () => {
  fx.list = [];
  fx.usable = { codex: false, claude: true };
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'New task'));
  const d = dialog(v.host)!;
  assert.ok((byText(d, 'Create') as HTMLButtonElement).disabled);
  await type(d.querySelector('textarea'), 'Check the build\nand report');
  await click(byText(d, 'Advanced'));
  assert.equal(sel(d, 'Run with'), 'Claude Code');
  assert.equal(sel(d, 'Model'), 'Opus');
  assert.equal(sel(d, 'Reasoning'), 'E:max');
  await click(d.querySelector('[role=switch][aria-label="Run on this computer"]'));
  calls.length = 0;
  await click(byText(d, 'Create'));
  assert.equal(savedTask().execution_environment, 'worktree');
  assert.equal(savedTask().name, 'Check the build');
  assert.equal(savedTask().harness, 'claude');

  fx.usable = { codex: false, claude: false };
  await click(byText(v.host, 'New task'));
  await type(dialog(v.host)!.querySelector('textarea'), '!!!');
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(savedTask().harness, 'acp:opencode', 'as a new chat would: with neither usable, a basic harness that can run');
  fx.usable = { codex: true, claude: true };

  // a new task's folder name, numbered past the ones taken, is main's (tests/automationStore.test.ts)
  await v.unmount();
});

test('a new-scheduled-task event opens a heartbeat task for that chat', async () => {
  fx.list = [];
  const v = await render(h(Scheduled));
  await act(async () =>
    window.dispatchEvent(
      new (window as any).CustomEvent('new-scheduled-task', { detail: { name: 'Follow up', cwd: '/w/x', threadId: 'th1' } }),
    ),
  );
  let d = dialog(v.host)!;
  await type(d.querySelector('textarea'), 'check again');
  calls.length = 0;
  await click(byText(d, 'Create'));
  assert.equal(savedTask().kind, 'heartbeat');
  assert.equal(savedTask().target_thread_id, 'th1');
  assert.deepEqual(savedTask().cwds, ['/w/x']);
  assert.equal(savedTask().name, 'Follow up');
  await act(async () => window.dispatchEvent(new (window as any).CustomEvent('new-scheduled-task', { detail: { cwd: '/w/y' } })));
  d = dialog(v.host)!;
  await type(d.querySelector('textarea'), 'p'.repeat(59) + '🙂tail');
  await click(byText(d, 'Create'));
  assert.equal(savedTask().name, 'p'.repeat(59) + '🙂');
  await v.unmount();
  calls.length = 0;
  window.dispatchEvent(new (window as any).CustomEvent('new-scheduled-task', { detail: { cwd: '/w/z' } }));
  assert.deepEqual(calls, [], 'no listener after unmount');
});

test('a task saved before the list has loaded is named by main, never by a stale list', async () => {
  // The shared page state starts with no list; no navigation has loaded it yet.
  const { useSched } = await import('../src/components/pages/scheduled/state.ts');
  await act(async () => useSched.setState({ list: null, selected: null, editing: null }));
  fx.list = [];
  let release!: () => void;
  fx.listGate = new Promise<void>((r) => (release = r));
  const v = await render(h(Scheduled));
  await act(async () =>
    window.dispatchEvent(new (window as any).CustomEvent('new-scheduled-task', { detail: { name: 'Early bird', cwd: '/w/x' } })),
  );
  await type(dialog(v.host)!.querySelector('textarea'), 'check');
  calls.length = 0;
  await click(byText(dialog(v.host)!, 'Create'));
  // the page sends no id: main numbers it past every task it has, loaded here or not
  assert.equal(savedTask().id, '');
  assert.ok(fx.list.some((x) => x.id === 'made-early-bird'));
  await act(async () => release());
  await flush();
  fx.listGate = null;
  await v.unmount();
});

test('the dialog closes on Close, Cancel, Escape (not while a menu is open) and a click on the backdrop only', async () => {
  fx.list = [];
  const v = await render(both());
  await flush();
  const open = () => byText(v.host, 'News updates', '.sched-template').click();
  await act(async () => open());
  await click(v.host.querySelector('[aria-label="Close dialog"]'));
  assert.equal(dialog(v.host), null);
  await act(async () => open());
  await click(byText(dialog(v.host)!, 'Cancel'));
  assert.equal(dialog(v.host), null);
  await act(async () => open());
  const layer = document.createElement('div');
  layer.className = 'popover-layer';
  document.body.append(layer);
  await act(async () => window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape' })));
  assert.ok(dialog(v.host), 'a menu takes the Escape');
  layer.remove();
  await act(async () => window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'a' })));
  assert.ok(dialog(v.host));
  await act(async () => window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(dialog(v.host), null);
  await act(async () => open());
  const mouse = (el: Element) => act(async () => el.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true })));
  await mouse(dialog(v.host)!);
  assert.ok(dialog(v.host), 'inside the dialog it stays');
  await mouse(v.host.querySelector('.sched-dialog-backdrop')!);
  assert.equal(dialog(v.host), null);
  await v.unmount();
});

test('repeat and time controls build the rule for each kind of schedule', async () => {
  fx.list = [];
  const v = await render(both());
  await flush();
  const open = async () => {
    await click(byText(v.host, 'New task'));
    await type(dialog(v.host)!.querySelector('textarea'), 'do it');
  };
  await open();
  const d = dialog(v.host)!;
  const rule = async () => {
    calls.length = 0;
    await click(byText(dialog(v.host)!, 'Create'));
    const r = savedTask().rrule;
    await open();
    return r;
  };
  assert.match(sel(d, 'Time')!, /^9:00 AM /);
  await pick(d, 'Time', '1:15 PM');
  assert.equal(await rule(), 'FREQ=DAILY;BYHOUR=13;BYMINUTE=15');
  const d2 = dialog(v.host)!;
  await pick(d2, 'Repeat schedule', 'Weekdays');
  await pick(d2, 'Time', '12:00 AM');
  assert.equal(await rule(), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=0;BYMINUTE=0');
  const d3 = dialog(v.host)!;
  await pick(d3, 'Repeat schedule', 'Weekly');
  assert.equal(sel(d3, 'Day'), 'Monday');
  await pick(d3, 'Day', 'Friday');
  assert.equal(await rule(), 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0');
  const d4 = dialog(v.host)!;
  await pick(d4, 'Repeat schedule', 'Interval');
  assert.equal(sel(d4, 'Unit'), 'hours');
  const every = d4.querySelector('input[type=number]')!;
  await type(every, '0');
  assert.equal((every as HTMLInputElement).value, '1');
  await type(every, '-3');
  await pick(d4, 'Unit', 'minutes');
  assert.equal(await rule(), 'FREQ=MINUTELY;INTERVAL=1');
  const d5 = dialog(v.host)!;
  await pick(d5, 'Repeat schedule', 'Interval');
  await type(d5.querySelector('input[type=number]'), '6');
  assert.equal(await rule(), 'FREQ=HOURLY;INTERVAL=6');
  const d6 = dialog(v.host)!;
  await pick(d6, 'Repeat schedule', 'Custom');
  const custom = d6.querySelector('input.mono') as HTMLInputElement;
  assert.equal(custom.value, 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
  await type(custom, 'FREQ=MONTHLY;BYMONTHDAY=1');
  assert.equal(await rule(), 'FREQ=MONTHLY;BYMONTHDAY=1');
  await click(byText(dialog(v.host)!, 'Cancel'));
  await v.unmount();
});

test('editing reads every kind of rule back into the controls', async () => {
  const cases: [string, string, string][] = [
    ['FREQ=HOURLY;INTERVAL=2', 'Interval', 'hours'],
    ['FREQ=MINUTELY', 'Interval', 'minutes'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Weekdays', '9:00 AM'],
    ['FREQ=WEEKLY;BYDAY=SA;BYHOUR=7;BYMINUTE=30', 'Weekly', '7:30 AM'],
    ['FREQ=WEEKLY;BYDAY=SA,SU', 'Custom', ''],
    ['FREQ=YEARLY', 'Custom', ''],
  ];
  for (const [rrule, repeat, detail] of cases) {
    fx.list = [task('e', { rrule })];
    const v = await render(both());
    await flush();
    await click(byText(v.host, 'Task e', '.sched-row'));
    await click(v.host.querySelector('[aria-label="Task actions"]'));
    await click(byText(v.host, 'Edit', '[role=menuitem]'));
    const d = dialog(v.host)!;
    assert.equal(d.querySelector('.sched-dialog-head span')!.textContent, 'Edit task');
    assert.equal(sel(d, 'Repeat schedule'), repeat, rrule);
    if (repeat === 'Interval') assert.equal(sel(d, 'Unit'), detail);
    else if (repeat !== 'Custom') assert.match(sel(d, 'Time')!, new RegExp(`^${detail}`));
    if (rrule === 'FREQ=HOURLY;INTERVAL=2') assert.equal((d.querySelector('input[type=number]') as HTMLInputElement).value, '2');
    if (rrule === 'FREQ=MINUTELY') assert.equal((d.querySelector('input[type=number]') as HTMLInputElement).value, '1');
    if (rrule.includes('SA;')) assert.equal(sel(d, 'Day'), 'Saturday');
    await click(byText(d, 'Cancel'));
    await v.unmount();
  }
});

test('advanced: run with, environment, new chat, model, effort, computer control and approval are saved', async () => {
  fx.list = [
    task('x', {
      kind: 'cron',
      execution_environment: 'worktree',
      model: 'gpt-4',
      reasoning_effort: 'low',
      harness: 'codex',
      computer_control: true,
      on_approval: 'skip',
    }),
  ];
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task x', '.sched-row'));
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d = dialog(v.host)!;
  await click(byText(d, 'Advanced'));
  const sw = (label: string) => d.querySelector(`[role=switch][aria-label="${label}"]`)!;
  assert.equal(sw('Run on this computer').getAttribute('aria-checked'), 'false');
  assert.equal(sw('Start each run in new chat').getAttribute('aria-checked'), 'true');
  assert.equal(sw('Allow computer control').getAttribute('aria-checked'), 'true');
  assert.equal(sel(d, 'Model'), 'M:GPT-4');
  assert.equal(sel(d, 'Reasoning'), 'low', 'an effort the model does not list shows as is');
  assert.equal(sel(d, 'When approval is needed'), 'Skip this run');
  await pick(d, 'Model', 'M:GPT-5');
  await pick(d, 'Reasoning', 'E:high');
  await click(sw('Run on this computer'));
  await click(sw('Start each run in new chat'));
  await click(sw('Allow computer control'));
  await pick(d, 'When approval is needed', 'Wait and notify');
  calls.length = 0;
  await click(byText(d, 'Save'));
  const s = savedTask();
  assert.deepEqual(
    [s.id, s.name, s.execution_environment, s.kind, s.model, s.reasoning_effort, s.computer_control, s.on_approval],
    ['x', 'Task x', 'local', 'heartbeat', 'gpt-5', 'high', false, 'wait'],
  );

  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d2 = dialog(v.host)!;
  await click(byText(d2, 'Advanced'));
  await pick(d2, 'Run with', 'Claude Code');
  assert.equal(sel(d2, 'Model'), 'Opus');
  assert.equal(sel(d2, 'Reasoning'), 'E:max');
  await click(byText(d2, 'Advanced'));
  assert.equal(d2.querySelector('.sched-adv'), null);
  await click(byText(d2, 'Save'));
  assert.equal(savedTask().harness, 'claude');

  // a basic harness that passed admission: no model or effort to pick
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d3 = dialog(v.host)!;
  await click(byText(d3, 'Advanced'));
  await click(d3.querySelector('[aria-label="Run with"]'));
  assert.deepEqual(
    [...v.host.querySelectorAll('[role=menuitem]')].map((e) => e.firstChild?.textContent),
    ['Codex', 'Claude Code', 'opencode', 'Kimi Code'],
    'an installed harness that needs a sign-in is listed too (disabled, with why)',
  );
  assert.match(d3.querySelector('.sched-where-note')!.textContent!, /MoPilot or Claude Desktop is open/);
  await click(byText(v.host, 'opencode', '[role=menuitem]'));
  assert.equal(d3.querySelector('[aria-label="Model"]'), null);
  assert.equal(d3.querySelector('[aria-label="Reasoning"]'), null);
  assert.match(d3.querySelector('.sched-field-note')!.textContent!, /Uses the model set in opencode/);
  assert.match(d3.querySelector('.sched-where-note')!.textContent!, /only while MoPilot is open: opencode has no scheduler/);
  await click(byText(d3, 'Save'));
  assert.deepEqual([savedTask().harness, savedTask().model, savedTask().reasoning_effort], ['acp:opencode', undefined, undefined]);
  await v.unmount();
});

test('a codex task with no models known starts with no model or effort', async () => {
  store.setState({ models: [], config: null });
  fx.list = [task('m')];
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task m', '.sched-row'));
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d = dialog(v.host)!;
  await click(byText(d, 'Advanced'));
  calls.length = 0;
  await click(byText(d, 'Save'));
  assert.equal(savedTask().model, undefined, 'no model is left out');
  assert.equal(savedTask().reasoning_effort, 'medium');
  store.setState({ claude: { models: [] } });
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  await click(byText(dialog(v.host)!, 'Advanced'));
  await pick(dialog(v.host)!, 'Run with', 'Claude Code');
  await click(byText(dialog(v.host)!, 'Save'));
  assert.equal(savedTask().reasoning_effort, undefined, 'no effort is left out');
  store.setState({
    models: [
      { model: 'gpt-5', displayName: 'GPT-5', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    ],
    claude: { models: [{ id: 'opus', label: 'Opus', efforts: ['max'], isDefault: true, defaultEffort: 'max' }] },
    config: { model: 'gpt-5', model_reasoning_effort: 'high' },
  });
  await v.unmount();
});

test('task detail: meta, where it runs, recent runs from the ledger with attention, run now, pause/resume and delete', async (t) => {
  const errors = mock.method(console, 'error');
  t.after(() => errors.mock.restore());
  const when = new Date(2026, 0, 5, 9, 30);
  next['R-t'] = when;
  fx.list = [
    task('t', { model: 'gpt-5', target_thread_id: 'th2', created_by_chat: 'th1', runs_in: { apps: ['mopilot', 'codex-app'] } }),
    task('p', { status: 'PAUSED', cwds: [], harness: 'acp:kimi', runs_in: { apps: ['mopilot'], desktop: 'pending' } }),
    task('n', { rrule: 'R-none', created_by_chat: 'gone' }),
    task('d', { rrule: '', cron: '0 9 1 * *', harness: 'claude', runs_in: { apps: ['claude-desktop'] } }),
    task('e', { rrule: '', harness: 'claude' }),
  ];
  fx.runs = {
    t: [
      { scheduledFor: 10, status: 'started', chatId: 'th2', by: 'codex-app' },
      { scheduledFor: 9, status: 'started', chatId: 'th2', by: { pid: 1 } },
      { scheduledFor: 9, status: 'started', chatId: 'th2', by: { pid: 1 }, manual: true },
    ],
    p: [
      { scheduledFor: 40, status: 'started', chatId: 'th4', catchUp: true },
      { scheduledFor: 30, status: 'skipped', reason: 'previous-running' },
      { scheduledFor: 20, status: 'skipped', reason: 'missed' },
      { scheduledFor: 15, status: 'failed', reason: 'no window' },
      { scheduledFor: 8, status: 'started', chatId: 'gone' },
    ],
  };
  store.setState({
    threads: {
      th1: { id: 'th1', title: 'Other', updatedAt: 5 },
      th2: { id: 'th2', title: 'Run A', updatedAt: 10 },
      th4: { id: 'th4', title: 'Later', updatedAt: 40 },
    },
  });
  await act(async () =>
    sessions.setState({
      sessions: { th4: { scheduled: { needsAttention: true } }, th3: {}, th9: { scheduled: { needsAttention: false } } },
    }),
  );
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task t', '.sched-row'));
  await flush();
  const meta = () => [...v.host.querySelectorAll('.auto-meta > *')].map((e) => e.textContent!.trim());
  assert.deepEqual(meta(), [
    'rule(R-t)',
    'Codex',
    'proj',
    'M:gpt-5',
    `Next ${when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
  ]);
  // the list says where each task runs
  const chips = (name: string) =>
    [...byText(v.host, name, '.sched-row').closest('.sched-row')!.querySelectorAll('.sched-app')].map((e) => e.textContent);
  // each row names the harness it runs with, colored by family
  const dot = (name: string) => byText(v.host, name, '.sched-row').closest('.sched-row')!.querySelector('.sched-harness-dot')!.className;
  assert.deepEqual(chips('Task t'), ['Codex']);
  assert.deepEqual(chips('Task d'), ['Claude Code']);
  assert.deepEqual(chips('Task p'), ['Kimi Code']);
  assert.deepEqual(
    [dot('Task t'), dot('Task d'), dot('Task p')],
    ['sched-harness-dot codex', 'sched-harness-dot claude', 'sched-harness-dot basic'],
  );
  // the Codex app is open: it runs the task, MoPilot waits
  const where = () => [...v.host.querySelectorAll('.sched-where-row')].map((e) => e.textContent);
  assert.deepEqual(where(), ['MoPilotWaiting: the Codex app is open and runs this task', 'Codex appOpen now: runs this task itself']);
  assert.equal(v.host.querySelector('.sched-off'), null);
  const rows = () =>
    [...v.host.querySelectorAll('.sched-run')].map((e) => [
      e.querySelector('.sched-run-status')!.textContent,
      e.querySelector('.sched-run-detail')!.textContent,
      e.querySelector('.sched-run-source')!.textContent,
      // relativeTime takes seconds; the ledger's times are in ms
      e.querySelector('.task-run-time')!.textContent,
      e.querySelector('.status-pill')?.textContent ?? null,
      !!e.querySelector('.sched-run-open'),
    ]);
  assert.deepEqual(rows(), [
    ['Ran', 'Run A', 'Codex app', 't0.01', null, true],
    ['Ran', 'Run A', 'MoPilot', 't0.009', null, true],
    ['Ran', 'Run A', 'MoPilot', 't0.009', null, true],
  ]);
  assert.equal(
    errors.mock.calls.some((c) => /same key/.test(String(c.arguments[0]))),
    false,
    'manual and scheduled runs at the same time have distinct identities',
  );
  assert.equal(v.host.querySelector('.task-prompt')!.textContent, 'prompt t');
  calls.length = 0;
  await click(byText(v.host, 'Set up in the chat “Other”', '.task-run'));
  await click(v.host.querySelector('.sched-run-open'));
  assert.deepEqual(calls, [
    ['navigate', { name: 'thread', id: 'th1' }],
    ['navigate', { name: 'thread', id: 'th2' }],
  ]);
  // main says the task changed: its runs and the apps load again
  calls.length = 0;
  fx.runs.t = [{ scheduledFor: 11, status: 'started', chatId: 'th2', catchUp: true }, ...fx.runs.t];
  fx.appsState = { ...fx.appsState, codexApp: { installed: true, running: false } };
  await changed();
  await flush();
  assert.ok(calls.some((c) => c[0] === 'runs' && c[1] === 't'));
  assert.ok(calls.some((c) => c[0] === 'apps'));
  assert.equal(rows()[0][0], 'Catch-up');
  assert.match(where()[0]!, /Runs this task while the Codex app is closed/);
  // the window comes back to the front: the apps are asked again
  calls.length = 0;
  await act(async () => window.dispatchEvent(new (window as any).Event('focus')));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'apps'),
    [['apps']],
  );

  // the scheduler is off: the page says so, and turns it on
  await act(async () => store.setState({ prefs: { schedulerOff: true } }));
  assert.match(v.host.querySelector('.sched-off')!.textContent!, /won't run this task\. The Codex app still runs it/);
  assert.match(where()[0]!, /Off in Settings/);
  calls.length = 0;
  await click(byText(v.host.querySelector('.sched-off')!, 'Turn on'));
  assert.deepEqual(calls, [['prefs', { schedulerOff: false }]]);
  assert.equal(v.host.querySelector('.sched-off'), null);

  calls.length = 0;
  await click(byText(v.host, 'Run now'));
  assert.deepEqual(calls, [
    ['run', 't'],
    ['navigate', { name: 'thread', id: 'run-1' }],
  ]);
  for (const [err, text] of [
    [new Error('busy'), 'busy'],
    [{ toString: () => 'odd' }, 'odd'],
  ] as const) {
    fx.runResult = err;
    calls.length = 0;
    await click(byText(v.host, 'Run now'));
    assert.deepEqual(calls, [
      ['run', 't'],
      ['toast', text, 'error'],
    ]);
  }
  fx.runResult = 'run-1';

  calls.length = 0;
  await click(byText(v.host.querySelector('.task-actions')!, 'Pause'));
  assert.equal(savedTask().status, 'PAUSED');
  await flush();
  assert.ok(byText(v.host, 'Resume'));
  assert.equal(v.host.querySelector('.auto-meta .status-pill')!.textContent, 'Paused');
  for (const [err, text] of [
    [new Error('read-only'), 'read-only'],
    ['plain', 'plain'],
  ] as const) {
    fx.saveFail = err;
    calls.length = 0;
    await click(byText(v.host.querySelector('.task-actions')!, 'Resume'));
    assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === `Couldn't save the task: ${text}`));
  }
  fx.saveFail = null;
  await click(byText(v.host.querySelector('.task-actions')!, 'Resume'));
  assert.equal(savedTask().status, 'ACTIVE');

  await act(async () => store.setState({ prefs: { schedulerOff: true } }));
  await click(byText(v.host, 'Task p', '.sched-row'));
  await flush();
  assert.deepEqual(meta(), ['rule(R-p)', 'Kimi Code', 'Paused']);
  // the scheduler being off and no native app: nothing else runs it
  assert.match(v.host.querySelector('.sched-off')!.textContent!, /won't run this task\.Turn on$/);
  await act(async () => store.setState({ prefs: {} }));
  assert.deepEqual(where(), ['MoPilotRuns from MoPilot; it joins Claude Desktop once Claude Desktop is closed']);
  assert.deepEqual(rows(), [
    ['Catch-up', 'Later', 'MoPilot', 't0.04', 'Needs attention', true],
    ['Skipped', 'The previous run was still going', 'MoPilot', 't0.03', null, false],
    ['Missed', 'Nothing was open, and a later time ran instead', '', 't0.02', null, false],
    ['Didn’t start', 'no window', 'MoPilot', 't0.015', null, false],
    ['Ran', '', 'MoPilot', 't0.008', null, false],
  ]);

  // a schedule MoPilot can't read shows Desktop's own cron
  await click(byText(v.host, 'Task d', '.sched-row'));
  await flush();
  assert.equal(meta()[0], '0 9 1 * *');
  assert.equal(meta()[1], 'Claude Code');
  assert.deepEqual(where(), ['Claude DesktopClosed: won’t run a time MoPilot already ran']);
  await act(async () => store.setState({ prefs: { schedulerOff: true } }));
  assert.match(v.host.querySelector('.sched-off')!.textContent!, /Claude Desktop still runs it while it's open/);
  await act(async () => store.setState({ prefs: {} }));
  await click(byText(v.host, 'Task e', '.sched-row'));
  await flush();
  assert.equal(meta()[0], '');

  fx.runsFail = true;
  await click(byText(v.host, 'Task n', '.sched-row'));
  await flush();
  fx.runsFail = false;
  assert.ok(byText(v.host.querySelector('.task-actions')!, 'Pause') && meta().at(-1) === 'No next run', 'pill agrees with Pause (#1862)');
  assert.match(v.host.textContent!, /No runs yet/);
  assert.equal(maybeText(v.host, 'Set up in', '.task-run'), null, 'a chat that is gone is not linked');

  fx.confirmAnswer = false;
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  calls.length = 0;
  await click(byText(v.host, 'Delete', '[role=menuitem]'));
  assert.deepEqual(calls, [['confirm', 'Delete "Task n"?']]);
  fx.confirmAnswer = true;
  for (const [error, message] of [
    [new Error('permission denied'), 'permission denied'],
    ['offline', 'offline'],
  ] as const) {
    fx.deleteError = error;
    await click(v.host.querySelector('[aria-label="Task actions"]'));
    calls.length = 0;
    await click(byText(v.host, 'Delete', '[role=menuitem]'));
    assert.deepEqual(calls, [
      ['confirm', 'Delete "Task n"?'],
      ['delete', 'n'],
      ['toast', `Couldn't delete the task: ${message}`, 'error'],
    ]);
    assert.ok(v.host.querySelector('.task-detail'));
    assert.ok(byText(v.host, 'Task n', '.sched-row'));
  }
  fx.deleteError = null;
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  calls.length = 0;
  await click(byText(v.host, 'Delete', '[role=menuitem]'));
  assert.deepEqual(calls.slice(0, 2), [
    ['confirm', 'Delete "Task n"?'],
    ['delete', 'n'],
  ]);
  assert.equal(v.host.querySelector('.task-detail'), null);
  assert.deepEqual(navNames(v.host), ['Task t', 'Task p', 'Task d', 'Task e']);
  assert.equal(maybeText(v.host, 'Task n', '.sched-row'), null);
  await v.unmount();
  assert.equal(changedListeners.size, 0, 'listeners go with the page');
  fx.appsState = { scheduler: true, codexApp: { installed: true, running: true }, claudeDesktop: { installed: true, running: false } };
});

test('a chat’s card opens the page on its task, before the page opens or while it is open', async () => {
  const { showScheduledTask } = await import('../src/session/scheduledFocus.ts');
  fx.list = [task('a'), task('b')];
  calls.length = 0;
  showScheduledTask('b');
  assert.deepEqual(calls[0], ['navigate', { name: 'scheduled' }]);
  const v = await render(both());
  await flush();
  assert.equal(v.host.querySelector('.page-title')!.textContent, 'Task b');
  await act(async () => showScheduledTask('a'));
  assert.equal(v.host.querySelector('.page-title')!.textContent, 'Task a');
  await v.unmount();
});

test('main not answering about the apps leaves where it fx.runs as it was', async () => {
  const real = fx.appsState;
  fx.list = [task('z', { runs_in: { apps: ['mopilot', 'codex-app'] } })];
  fx.appsState = Promise.reject(new Error('no main'));
  (fx.appsState as Promise<unknown>).catch(() => {});
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task z', '.sched-row'));
  await flush();
  assert.match(v.host.querySelector('.sched-where-row')!.textContent!, /while the Codex app is closed/);
  await v.unmount();
  fx.appsState = real;
});

for (const outcome of ['success', 'failure'] as const) {
  test(`run history ignores an obsolete ${outcome} after a newer change`, async () => {
    const id = `race-${outcome}`;
    fx.list = [task(id)];
    let resolve!: (value: any[]) => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<any[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    fx.runs = { [id]: gate } as any;
    const v = await render(both());
    try {
      await flush();
      await click(byText(v.host, `Task ${id}`, '.sched-row'));
      fx.runs = { [id]: [{ scheduledFor: 2000, status: 'started' }] };
      await changed();
      assert.equal(v.host.querySelector('.task-run-time')?.textContent, 't2');
      await act(async () => {
        if (outcome === 'success') resolve([{ scheduledFor: 1000, status: 'started' }]);
        else reject(new Error('obsolete ledger failure'));
      });
      assert.equal(v.host.querySelector('.task-run-time')?.textContent, 't2');
    } finally {
      await v.unmount();
      fx.runs = {};
    }
  });
}

test('selecting another task clears its predecessor ledger while the new ledger loads', async () => {
  fx.list = [task('before'), task('after')];
  let resolve!: (value: any[]) => void;
  const gate = new Promise<any[]>((yes) => {
    resolve = yes;
  });
  fx.runs = { before: [{ scheduledFor: 1000, status: 'started' }], after: gate } as any;
  const v = await render(both());
  try {
    await flush();
    await click(byText(v.host, 'Task before', '.sched-row'));
    assert.equal(v.host.querySelector('.task-run-time')?.textContent, 't1');
    await click(byText(v.host, 'Task after', '.sched-row'));
    assert.equal(v.host.querySelectorAll('.sched-run').length, 0);
    await act(async () => resolve([{ scheduledFor: 2000, status: 'started' }]));
    assert.equal(v.host.querySelector('.task-run-time')?.textContent, 't2');
  } finally {
    resolve([]);
    await v.unmount();
    fx.runs = {};
  }
});

test('a task that changes while its fx.runs load shows nothing stale', async () => {
  fx.list = [task('s')];
  let release!: (r: any[]) => void;
  fx.runs = {};
  const v = await render(both());
  await flush();
  const gate = new Promise<any[]>((r) => (release = r));
  const realRuns = fx.runs;
  fx.runs = new Proxy(realRuns, { get: () => gate as any }) as any;
  await click(byText(v.host, 'Task s', '.sched-row'));
  await v.unmount();
  await act(async () => release([{ scheduledFor: 1, status: 'started' }]));
  fx.runs = {};
});

test('the time shows without a zone name when the platform gives none', async () => {
  const Real = Intl.DateTimeFormat;
  (Intl as any).DateTimeFormat = function () {
    return { formatToParts: () => [{ type: 'hour', value: '9' }] };
  };
  try {
    fx.list = [];
    const v = await render(both());
    await flush();
    await click(byText(v.host, 'New task'));
    assert.equal(sel(dialog(v.host)!, 'Time'), '9:00 AM ');
    await click(byText(dialog(v.host)!, 'Cancel'));
    await v.unmount();
  } finally {
    (Intl as any).DateTimeFormat = Real;
  }
});
