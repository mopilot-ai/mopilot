// MoMo's phone work view models (Tasks, Notes, Rules, Settings, notifications) over the shared view contract: the design's words and one-tap fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const vmPath = '../mobile/src/momoPhone/workModels';
const vmHomePath = '../mobile/src/momoPhone/viewModels';
const fxPath = '../mobile/src/momoPhone/fixtures';
const vm = { ...(await import(vmHomePath)), ...(await import(vmPath)) };
const { fixtureView, fixtureShared } = await import(fxPath);

const at = (h: number, m: number, d = 24) => new Date(2026, 10, d, h, m).getTime();
// a view with the shared part edited in place
const make = (f: (v: any) => void = () => undefined, over: object = {}) => {
  const view = fixtureShared();
  f(view);
  return fixtureView({ view, ...over });
};
const homeIs = (state: string, extra: object = {}) => make((v) => Object.assign(v.home, { state, stateSince: at(13, 12), ...extra }));
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

const taskOf = (extra: object) => ({ ...fixtureShared().tasks[0], ...extra });

test('tasks group in the contract’s order, or say Nothing running', () => {
  const t = (id: string, state: string) => taskOf({ id, state });
  const { sections, empty } = vm.taskSections([
    t('a', 'needs_you'),
    t('d', 'working'),
    t('e', 'watching'),
    t('f', 'done'),
    t('g', 'failed'),
    t('h', 'stopped'),
  ]);
  assert.equal(empty, null);
  assert.deepEqual(
    sections.map((s: { title: string; tasks: unknown[] }) => [s.title, s.tasks.length]),
    [
      ['Needs you', 1],
      ['Working', 1],
      ['Watching', 1],
      ['Done today', 3],
    ],
  );
  const none = vm.taskSections([]);
  assert.deepEqual([none.sections, none.empty.title, none.empty.cta], [[], 'Nothing running.', 'Ask MoMo']);
});

test('a working task shows Stop; a result offers Open and Attach; a watched one Check now, Snooze, Stop watching', () => {
  const view = fixtureView();
  const working = vm.taskDetail(view, view.view.tasks[0]);
  assert.deepEqual(working.facts, [
    { label: 'Done means', value: 'Sheet has 200 seats at $48k and opens without errors' },
    { label: 'Runs on', value: 'Codex · Mac mini' },
    { label: 'Started', value: '6 min ago' },
  ]);
  assert.deepEqual([working.step, working.status, working.awayNote], ['Filling the pricing table', 'Working', null]);
  assert.deepEqual(labels(working.actions), ['Open the session', 'Stop']);
  const done = vm.taskDetail(
    view,
    taskOf({
      state: 'done',
      result: { summary: '200 seats, $48k, valid to Nov 30.', files: ['Acme-quote.xlsx'], evidence: 'opens, totals match.' },
    }),
  );
  assert.deepEqual(done.result, {
    headline: 'Ready: Acme-quote.xlsx',
    summary: '200 seats, $48k, valid to Nov 30.',
    checked: 'Checked: opens, totals match.',
  });
  assert.deepEqual(labels(done.actions), ['Open', 'Attach to the reply', 'Open the session']);
  assert.equal(vm.taskDetail(view, taskOf({ state: 'done' })).actions.length, 0);
  const watch = vm.taskDetail(view, view.view.tasks[1]);
  assert.deepEqual(
    watch.facts.map((f: { label: string }) => f.label),
    ['Done means', 'Runs on', 'Started', 'Why', 'Next check', 'Told you'],
  );
  assert.equal(watch.facts[4].value, '4:00 PM');
  assert.equal(watch.step, null);
  assert.equal(vm.taskDetail(view, taskOf({ state: 'watching', step: null, nextCheck: null })).facts.length, 3);
  assert.deepEqual(labels(watch.actions), ['Check now', 'Snooze', 'Stop watching']);
  assert.equal(vm.taskDetail(view, taskOf({ state: 'needs_you', doneMeans: '' })).facts.length, 2);
  assert.equal(vm.taskDetail(view, taskOf({ state: 'mystery' })).status, 'mystery');
  assert.equal(vm.taskDetail(view, taskOf({ state: 'stopped' })).status, 'Stopped');
  const asleep = vm.taskDetail(homeIs('asleep'), taskOf({}));
  assert.equal(asleep.awayNote, 'Studio is asleep. This keeps running on Mac mini. The result shows when Studio is back.');
  assert.equal(
    vm.taskDetail(homeIs('asleep'), taskOf({ where: { machine: { machineId: 'studio', name: 'Studio' }, agent: 'Codex' } })).awayNote,
    null,
  );
  const sheet = vm.stopSheet(view.view.tasks[0]);
  assert.deepEqual(
    [sheet.title, sheet.cancel, sheet.body],
    ['Stop this task?', 'Keep working', 'Build the Acme quote sheet. The session stops. Files already made are kept.'],
  );
  assert.deepEqual(sheet.confirm.intent, { kind: 'task-stop', taskId: 't1' });
});

test('a task failure names the real cause and the one-tap fix', () => {
  const view = fixtureView();
  const of = (failure: object | null) => vm.taskDetail(view, taskOf({ state: 'failed', failure })).problem;
  const mini = { machineId: 'mini', name: 'Mac mini' };
  const f = (code: string, extra: object = {}) => ({
    code,
    message: 'Mac mini is out of disk space',
    machine: mini,
    agent: 'Codex',
    fix: null,
    ...extra,
  });
  assert.equal(of(null), null);
  const missing = of(f('agent-missing'));
  assert.equal(missing.title, "Codex isn't installed on Mac mini");
  assert.deepEqual(missing.actions[0].intent, { kind: 'install-agent', agent: 'codex', machineId: 'mini' });
  assert.deepEqual(
    [missing.actions[1].label, missing.actions[1].intent],
    ['Run on Studio', { kind: 'task-retry', taskId: 't1', machineId: 'studio' }],
  );
  const homeFix = { id: 'fx1', label: 'Install Codex' };
  assert.deepEqual(of(f('agent-missing', { fix: homeFix })).actions[0], {
    label: 'Install Codex',
    intent: { kind: 'fix', id: 'fx1' },
    strong: true,
  });
  const out = of(f('agent-signed-out', { agent: 'Claude Code' }));
  assert.equal(out.title, 'Claude Code is signed out on Mac mini');
  assert.deepEqual(out.actions[0].intent, { kind: 'sign-in-agent', agent: 'claude', machineId: 'mini' });
  assert.equal(of(f('agent-signed-out', { fix: homeFix })).actions[0].label, 'Install Codex');
  const fallback = of(f('agent-signed-out', { machine: null, agent: null }));
  assert.equal(fallback.title, 'Codex is signed out on Mac mini');
  const cut = of(f('restarted'));
  assert.equal(cut.title, 'Mac mini restarted while this ran. It may have partly finished.');
  assert.deepEqual(labels(cut.actions), ['Open the session', 'Start again']);
  const other = of(f('session-error'));
  assert.deepEqual([other.title, other.body], ["Couldn't finish: Mac mini is out of disk space", 'Attempt 1 of 3']);
  assert.deepEqual(labels(other.actions), ['Retry', 'Run on another machine']);
  assert.deepEqual(other.actions[1].intent, { kind: 'pick-machine', taskId: 't1' });
  assert.deepEqual(of(f('session-error', { fix: homeFix })).actions[0].intent, { kind: 'fix', id: 'fx1' });
});

test('notes: empty, read-only while the home sleeps, rows, and the why behind a line', () => {
  const view = fixtureView();
  assert.deepEqual([vm.notesState(view).readOnly, vm.notesState(view).empty], [false, null]);
  const sleeping = vm.notesState(homeIs('asleep'));
  assert.equal(sleeping.readOnly, true);
  const empty = vm.notesState(make((v) => (v.notes = [])));
  assert.deepEqual([empty.empty.title, empty.empty.actions], ['Nothing here yet.', ['Connect Gmail and Calendar', 'Write your own note']]);
  const note = view.view.notes[0];
  assert.deepEqual(vm.noteRow(note), { id: 'n1', title: 'Acme', detail: 'Nov 24 · Gmail · Re: Acme renewal' });
  assert.equal(vm.noteRow({ ...note, lines: [] }).detail, 'Nov 24');
  assert.equal(vm.lineBadge(note.lines[0]), 'Learned');
  assert.equal(vm.lineBadge({ status: 'mystery' }), 'Learned');
  for (const [status, text] of [
    ['mentioned-once', 'Mentioned once'],
    ['confirmed', 'Confirmed'],
    ['let-go', 'Let go'],
  ]) {
    assert.equal(vm.lineBadge({ status }), text);
  }
  const why = vm.whyLine(note.lines[0]);
  assert.deepEqual(why, {
    quote: '“the $48k price holds if we start Dec 1”',
    from: 'Gmail · Re: Acme renewal · Nov 24',
    gone: null,
    open: { label: 'Open message', intent: { kind: 'open-source', sourceId: 's1' } },
    moreLine: '1 more source: Calendar · Acme sync',
  });
  const src = (kind: string, gone = false) => ({ id: 's', kind, label: 'L', at: at(9, 0), gone });
  assert.equal(vm.whyLine({ quote: null, sources: [src('event')] }).open, null);
  assert.equal(vm.whyLine({ quote: null, sources: [src('event')] }).quote, null);
  assert.match(vm.whyLine({ quote: 'q', sources: [src('mail', true)] }).gone, /gone from Gmail/);
  assert.equal(vm.whyLine({ quote: 'q', sources: [src('mail', true)] }).open, null);
  assert.equal(vm.whyLine({ quote: 'q', sources: [] }).from, null);
  assert.match(vm.whyLine({ quote: 'q', sources: [src('mail'), src('mail'), src('mail')] }).moreLine, /^2 more sources:/);
  assert.equal(vm.whyLine({ quote: null, sources: [] }), null);
  assert.deepEqual(vm.historyRows(note)[0], {
    id: 'h1',
    when: 'Nov 24',
    what: 'Summary rewritten after the price was confirmed',
    undoable: true,
  });
  assert.equal(vm.editNote(), 'Your edit becomes Confirmed. The old text stays in History.');
});

test('rules rows and the empty state', () => {
  assert.deepEqual(vm.ruleRows(fixtureView()), [
    { id: 'r1', words: 'Delivery notices → stay quiet', on: true, detail: 'Learned · Used 7 times' },
  ]);
  const mixed = vm.ruleRows(
    make((v) => v.rules.push({ ...v.rules[0], id: 'r2', origin: 'yours', state: 'off' }, { ...v.rules[0], id: 'r3', origin: 'built-in' })),
  );
  assert.deepEqual(
    mixed.map((r: { detail: string; on: boolean }) => [r.detail.split(' ')[0], r.on]),
    [
      ['Learned', true],
      ['Yours', false],
      ['Built', true],
    ],
  );
  assert.equal(vm.rulesEmpty().title, 'No rules yet.');
  assert.equal(vm.ruleRows(make((v) => (v.rules[0].origin = 'mystery')))[0].detail, 'Learned · Used 7 times');
});

test('notification permission, previews and brief settings say the design words', () => {
  const ask = vm.permissionView(make((v) => (v.setup.notifications = 'unknown')));
  assert.equal(ask.title, 'Let MoMo reach you');
  assert.equal(
    ask.body,
    "MoMo notifies you when something can't wait, like a client reply or a due invoice. At most 6 a day. Quiet from 10:00 PM to 8:00 AM.",
  );
  assert.deepEqual(labels(ask.actions), ['Allow notifications', 'Not now']);
  assert.deepEqual(ask.actions[0].intent, { kind: 'prefs', patch: { notifications: 'allowed' } });
  const noQuiet = make((v) => (v.settings.quietHours = { from: '00:00', to: '00:00' }));
  assert.equal(vm.permissionView(noQuiet).body.endsWith('At most 6 a day.'), true);
  assert.equal(vm.briefView(noQuiet.view.settings).rows[1].value, 'Off');
  const denied = vm.permissionView(make((v) => (v.setup.notifications = 'denied')));
  assert.deepEqual(
    [denied.title, denied.body, denied.actions[0].label],
    ['Notifications are off.', 'MoMo keeps things in Chat.', 'Open Settings'],
  );
  const s = fixtureShared().settings;
  const sample = vm.previewSample(fixtureView());
  assert.equal(sample, 'The quote sheet is ready. Want me to attach it to Dana’s reply?');
  assert.equal(vm.previewSample(make((v) => (v.chat = []))), null);
  const off = vm.previewView(s, sample);
  assert.deepEqual([off.on, off.title], [false, 'MoMo needs you']);
  assert.deepEqual(off.toggle.intent, { kind: 'prefs', patch: { previews: true } });
  const on = vm.previewView({ ...s, previews: true }, sample);
  assert.equal(on.title, sample);
  assert.equal(vm.previewView({ ...s, previews: true }, null).title, 'MoMo needs you');
  const brief = vm.briefView(s);
  assert.deepEqual(brief.rows, [
    { id: 'time', label: 'Time', value: '8:00 AM' },
    { id: 'quiet', label: 'Quiet hours', value: '10:00 PM to 8:00 AM' },
    { id: 'cap', label: 'Tell me now at most', value: '6 a day' },
  ]);
  assert.deepEqual(
    [brief.toggle.intent, brief.note],
    [{ kind: 'prefs', patch: { brief: false } }, 'A quiet day means no brief and no push.'],
  );
  assert.deepEqual([vm.clampCap(0), vm.clampCap(5.4), vm.clampCap(99)], [1, 5, 12]);
});

test('a notification button is a typed intent, and a refused one keeps its cause and fix', () => {
  assert.deepEqual(vm.noticeIntent('draft-reply', 'n1'), { kind: 'notice-draft-reply', noticeId: 'n1' });
  assert.deepEqual(vm.noticeIntent('remind-at-4', 'n1'), { kind: 'notice-remind', noticeId: 'n1', at: '16:00' });
  assert.deepEqual(vm.noticeIntent('not-needed', 'n1'), { kind: 'notice-not-needed', noticeId: 'n1' });
  const fix = { kind: 'wake' };
  assert.deepEqual(vm.failureView({ ok: false, cause: 'Studio is asleep.', fix, fixLabel: 'Wake Studio' }), {
    cause: 'Studio is asleep.',
    fix: { label: 'Wake Studio', intent: fix },
  });
  assert.deepEqual(vm.failureView({ ok: false, cause: 'No.' }), { cause: 'No.', fix: null });
});

test('a source that needs the person says so with its fix; a first look shows its progress; the machine picker lists online machines', () => {
  const src = (over: object) =>
    make((v) => v.home.sources.splice(0, 2, { id: 'gmail', account: 'a', access: 'read-only', status: 'ok', progress: null, ...over }));
  assert.deepEqual(vm.sourceProblems(fixtureView()), []);
  const out = vm.sourceProblems(src({ status: 'needs-reconnect' }));
  assert.deepEqual(out, [
    {
      id: 'gmail',
      title: 'Gmail needs you to sign in again',
      body: 'Google ended the sign-in. MoMo is not reading new mail. Your notes are kept.',
      action: { label: 'Reconnect', intent: { kind: 'google', intent: 'reconnect' } },
    },
  ]);
  const first = vm.sourceProblems(src({ status: 'catching-up', progress: { done: 3, total: 10 } }));
  assert.deepEqual([first[0].title, first[0].body, first[0].action], ['Looking at your Gmail', '3 of 10', null]);
  const odd = vm.sourceProblems(src({ status: 'mystery' }))[0];
  assert.deepEqual([odd.title, odd.action.label], ['Gmail needs you to sign in again', 'Reconnect']);
  assert.equal(vm.sourceProblems(src({ status: 'catching-up' }))[0].body, '');
  const cal = vm.sourceProblems(src({ id: 'calendar', status: 'needs-reconnect' }));
  assert.equal(cal[0].title, 'Google Calendar needs you to sign in again');
  assert.equal(vm.sourceProblems(src({ id: 'drive', status: 'needs-reconnect' }))[0].title, 'drive needs you to sign in again');
  assert.deepEqual(
    vm.pickRows(fixtureView(), 't1').map((r: { name: string }) => r.name),
    ['Studio', 'This Mac'],
  );
  assert.deepEqual(vm.pickRows(fixtureView(), 't1')[1], {
    id: 'mac',
    name: 'This Mac',
    detail: 'Claude Code signed in',
    intent: { kind: 'task-retry', taskId: 't1', machineId: 'mac' },
  });
  assert.equal(
    vm.pickRows(
      make((v) => (v.home.machines[1].agentsSignedIn = [])),
      't1',
    )[1].detail,
    'No agent signed in',
  );
});

test('a decision with nothing to say shows nothing: an unsorted one has no line, a notice with neither reason nor record has an empty reason', () => {
  const base = { id: 'd', outcome: 'unsorted', reason: '', kind: null, rule: null, checks: [], matter: null, at: 1 };
  assert.deepEqual(vm.decisionView({ whyTold: null, decision: base }), { reason: '', lines: [], checks: [], editRule: null });
  assert.equal(vm.decisionView({ whyTold: null }).reason, '');
  assert.equal(vm.decisionView({ whyTold: 'kept', decision: null }).reason, 'kept');
  assert.deepEqual(vm.decisionView({ whyTold: null, decision: { ...base, outcome: 'tell_now' } }).lines, []);
});

test('a rule that is saved but not applied yet is drawn as off with its own line, never as active', () => {
  const [row] = vm.ruleRows(make((v) => (v.rules[0].state = 'saved')));
  assert.deepEqual([row.on, row.detail], [false, 'Saved. Not applied yet']);
});
