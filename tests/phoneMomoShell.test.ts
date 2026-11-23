// MoMo's shell on the classic phone (mobile/src/screens/MomoShell.tsx in Momo.tsx): the floating pill Chat · Tasks · Make (an icon over each word, as the design has it) is there for every account that has MoMo, whatever the Mac's page-shell flag says; Tasks is M0a's four tabs where the Mac serves them and one honest line where it does not, Make says honestly that nothing is listed yet, a task opens MoMo's page on its own page, a reply that came while the reader was away sits under a "New" divider, a tab changes in the 120 ms snap token (at once with Reduce Motion), and the words are in both catalogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const shellPath = '../mobile/src/screens/MomoShell';
const { SHELL_TABS, tasksServed, firstNewKey, PILL } = await import(shellPath);
const contractPath = '../mobile/src/momo/stateContract';
const { parseState } = await import(contractPath);
const motionPath = '../shared/momoMotion.mjs';
const { MOMO_DUR, MOMO_EASE } = await import(motionPath);
const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;

const NOW = new Date(2026, 10, 15, 12, 0).getTime();
const METHODS = [
  'momo.state.get',
  'momo.prefs.get',
  'momo.prefs.set',
  'momo.tasks.list',
  'momo.tasks.mark',
  'momo.routines.pause',
  'momo.routines.resume',
];
const row = (over: any) => ({
  id: 'x',
  kind: 'loop',
  tab: 'active',
  state: 'needs-you',
  title: 'T',
  detail: null,
  dueDay: null,
  ref: 'x',
  at: null,
  outcome: null,
  nextAt: null,
  paused: false,
  ...over,
});
const TASKS = [
  row({ id: 'card:a1', kind: 'card', title: 'Send the mail', detail: 'Mail', ref: 'a1' }),
  row({ id: 'run:c3', kind: 'run', state: 'review', title: 'Morning brief', ref: 'c3', at: NOW - 3_600_000 }),
];
const state = (extra: Record<string, unknown> = { shell: true, shellTasks: true }) => ({
  name: 'Mo',
  status: 'online',
  needsYou: 0,
  ...extra,
});

function page(
  opts: { state?: any; methods?: string[]; follow?: () => unknown; tasks?: () => unknown; handlers?: Record<string, any> } = {},
) {
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: false, methods: opts.methods ?? METHODS, permissionCeiling: 'auto-review' },
    }),
    'momo.chat.follow': opts.follow ?? (() => snapshotOf()),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => opts.state ?? state(),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.prefs.set': () => ({ paused: true }),
    'momo.tasks.list': opts.tasks ?? (() => ({ v: 2, tasks: TASKS, paused: false, now: NOW })),
    'momo.tasks.mark': () => ({ taskId: 'run:c3', mark: 'done', undoToken: 'tok-1' }),
    ...opts.handlers,
  });
}
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
const tabs = () => [...document.querySelectorAll('[role=tab]')].map((t) => t.getAttribute('aria-label'));
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);

test('the pill is Chat · Tasks · Make with an icon over each word, and the chat shows its footnote', async () => {
  const m = page();
  const view = await mountMomo(m);
  assert.deepEqual(tabs(), ['Chat', 'Tasks', 'Make']);
  assert.equal(label('MoMo views')!.getAttribute('role'), 'tablist');
  assert.match(view.text(), /MoMo can make mistakes\./);
  assert.deepEqual([PILL.width, PILL.minHeight], [324, 60]);
  const symbols = [...document.querySelectorAll('[role=tab] [data-symbol]')].map((n) => n.getAttribute('data-symbol'));
  assert.deepEqual(symbols, ['bubble.left', 'checklist', 'sparkles']);
  await view.unmount();
});

test('the pill is there whatever the Mac says of its shell: the flag off, an older Mac that says nothing, or one that never answered its state', async () => {
  for (const s of [state({}), state({ shell: false, shellTasks: true }), state({ shellTasks: true })]) {
    const view = await mountMomo(page({ state: s }));
    assert.deepEqual(tabs(), ['Chat', 'Tasks', 'Make'], JSON.stringify(s));
    assert.match(view.text(), /MoMo can make mistakes/);
    await view.unmount();
  }
  const noState = await mountMomo(page({ methods: METHODS.filter((x) => x !== 'momo.state.get') }));
  assert.deepEqual(tabs(), ['Chat', 'Tasks', 'Make']);
  await noState.unmount();
});

test('a Mac that cannot serve Tasks (panel off, or a method missing) gets one honest line on that tab, not a list that cannot load', async () => {
  for (const o of [
    { state: state({ shell: true }) },
    { methods: METHODS.filter((x) => x !== 'momo.tasks.mark') },
    { methods: METHODS.filter((x) => x !== 'momo.tasks.list') },
  ]) {
    const m = page(o);
    const view = await mountMomo(m);
    await click('Tasks');
    assert.match(view.text(), /Tasks are not available on this computer yet\./);
    assert.doesNotMatch(view.text(), /Couldn.t read your list/);
    assert.equal(calls(m, 'momo.tasks.list').length, 0, 'nothing is asked of a Mac that does not serve it');
    await view.unmount();
  }
});

test('the Tasks tab is the four-tab list; a card sends the reader to the chat, a run opens MoMo’s page on its own page', async () => {
  const m = page();
  const view = await mountMomo(m);
  await click('Tasks');
  assert.match(view.text(), /Needs you/);
  assert.match(view.text(), /Send the mailMailReview›/);
  assert.match(view.text(), /Ready for reviewMorning brief/);
  assert.equal(label('Tasks')!.getAttribute('aria-selected') ?? label('Tasks')!.getAttribute('data-selected'), 'true');
  await click('Morning brief');
  assert.match(view.text(), /Mark as done/, 'MoMo’s page opened on the run’s own page');
  await click('Mark as done');
  assert.deepEqual(calls(m, 'momo.tasks.mark'), [{ taskId: 'run:c3', mark: 'done' }]);
  assert.match(view.text(), /Tasks/);
  await click('Send the mail, Review');
  assert.match(view.text(), /MoMo can make mistakes\./, 'back on the chat');
  await view.unmount();
});

test('the Tasks tab draws MoMo’s suggestions under Up next, and a tap opens the suggestion’s own page in MoMo’s page', async () => {
  const sug = {
    id: 's1',
    title: 'Reply to Sam',
    source: 'Mail: Sam',
    why: 'He asked.',
    step: 'Draft a reply',
    status: 'new',
    score: { urgency: 1, cost: 1, confidence: 1, novelty: 1 },
  };
  const m = page({
    state: state({ shell: true, shellTasks: true, suggestions: true }),
    methods: [...METHODS, 'momo.suggestions.list', 'momo.suggestions.act'],
    handlers: {
      'momo.suggestions.list': () => ({ suggestions: [sug], shown: 6, now: NOW }),
      'momo.suggestions.act': (p: any) => ({ id: p.id, action: p.action, channel: 'main' }),
    },
  });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Up next');
  assert.match(view.text(), /From your sourcesReply to SamMail: Sam›/);
  await click('Reply to Sam');
  assert.match(view.text(), /He asked\.|Draft a reply/);
  await click('Add');
  assert.deepEqual(calls(m, 'momo.suggestions.act'), [{ id: 's1', action: 'add' }]);
  // the page shut behind Add leaves the Tasks tab where it was: on Up next
  await view.unmount();
});

test('a Mac that lists no suggestion method, or has its flag off, draws none in the Tasks tab', async () => {
  const m = page({ state: state({ shell: true, shellTasks: true, suggestions: true }) });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Up next');
  assert.doesNotMatch(view.text(), /From your sources/);
  assert.equal(m.count('momo.suggestions.list'), 0);
  await view.unmount();
});

test('closing the page the Tasks tab opened leaves the tab as it was; Pause all is MoMo’s pause', async () => {
  const m = page({
    tasks: () => ({
      v: 2,
      tasks: [row({ id: 'routine:r1', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Daily', ref: 'r1' })],
      paused: false,
      now: NOW,
    }),
  });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Scheduled');
  await click('Pause all');
  assert.deepEqual(calls(m, 'momo.prefs.set'), [{ paused: true }]);
  await view.unmount();
  const failing = page({
    tasks: () => ({
      v: 2,
      tasks: [row({ id: 'routine:r1', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Daily', ref: 'r1' })],
      paused: false,
      now: NOW,
    }),
    handlers: {
      'momo.prefs.set': () => {
        throw new Error('Mac said no');
      },
    },
  });
  const v2 = await mountMomo(failing);
  await click('Tasks');
  await click('Scheduled');
  await click('Pause all');
  assert.match(v2.text(), /Mac said no/);
  await v2.unmount();
});

test('a read that fails says so with Try again and keeps nothing; a classic answer is not the panel either', async () => {
  let ok = false;
  const m = page({ tasks: () => (ok ? { v: 2, tasks: TASKS, paused: false, now: NOW } : Promise.reject(new Error('down'))) });
  const view = await mountMomo(m);
  await click('Tasks');
  assert.match(view.text(), /Couldn’t read your tasks\.Try again/);
  ok = true;
  await click('Couldn’t read your tasks., Try again');
  assert.match(view.text(), /Send the mail/);
  await view.unmount();
  const classic = await mountMomo(page({ tasks: () => ({ tasks: [] }) }));
  await click('Tasks');
  assert.match(classic.text(), /Couldn’t read your tasks\./);
  await classic.unmount();
});

test('Make says what it is for, and the chat comes back with its place kept', async () => {
  const view = await mountMomo(page());
  await click('Make');
  assert.match(view.text(), /What MoMo makes shows here\./);
  await click('Chat');
  assert.doesNotMatch(view.text(), /What MoMo makes shows here\./);
  assert.match(view.text(), /MoMo can make mistakes\./);
  await view.unmount();
});

test('a reply that came while the reader was on another tab sits under New; the reader’s own lines never do', async () => {
  let n = 0;
  const m = page({
    follow: () => {
      n++;
      return {
        ...snapshotOf(
          [],
          [
            { role: 'assistant', text: 'Earlier reply' },
            ...(n > 1
              ? [
                  { role: 'user', text: 'My line' },
                  { role: 'assistant', text: 'Fresh reply' },
                ]
              : []),
          ],
        ),
        itemsShape: 'rows',
      };
    },
  });
  const view = await mountMomo(m);
  assert.doesNotMatch(view.text(), /New/, 'nothing is new before the reader has been away');
  await click('Make');
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'chat' }));
  await flush();
  await click('Chat');
  assert.match(view.text(), /Earlier reply.*New.*Fresh reply/);
  assert.doesNotMatch(view.text(), /NewMy line/);
  await view.unmount();
});

test('a tab changes in the 120 ms snap token, and at once with Reduce Motion', async () => {
  const g = globalThis as any;
  g.__phoneTimings = [];
  const view = await mountMomo(page());
  await click('Make');
  const slide = g.__phoneTimings.at(-1);
  assert.equal(slide.config.duration, MOMO_DUR.s);
  assert.equal(MOMO_DUR.s, 120);
  assert.deepEqual(slide.config.easing, { bezier: [...MOMO_EASE.snap] });
  g.__phoneTimings = [];
  g.__phoneReduceMotion = true;
  try {
    await click('Chat');
    await click('Tasks');
    assert.deepEqual(g.__phoneTimings, [], 'Reduce Motion: the capsule moves with no timing');
    assert.equal(document.querySelectorAll('[data-entering]').length, 0, 'and the page comes in with no fade');
  } finally {
    g.__phoneReduceMotion = false;
  }
  await view.unmount();
});

test('the pill has three tabs, Tasks is served only by a Mac with its panel on and both methods, and firstNewKey decides the divider', () => {
  const has =
    (...ms: string[]) =>
    (m: string) =>
      ms.includes(m);
  assert.deepEqual(SHELL_TABS, ['chat', 'tasks', 'make']);
  const both = has('momo.tasks.list', 'momo.tasks.mark');
  assert.equal(tasksServed(null, both), false);
  assert.equal(tasksServed({ shell: false, shellTasks: true }, both), false);
  assert.equal(tasksServed({ shell: true, shellTasks: false }, both), false);
  assert.equal(tasksServed({ shell: true, shellTasks: true }, has('momo.tasks.list')), false);
  assert.equal(tasksServed({ shell: true, shellTasks: true }, has('momo.tasks.mark')), false);
  assert.equal(tasksServed({ shell: true, shellTasks: true }, both), true);
  const rows: any[] = [
    { kind: 'day', key: 'day:a', label: 'Today' },
    { kind: 'message', key: 'a', row: { role: 'assistant', text: 'one' } },
    { kind: 'message', key: 'u', row: { role: 'user', text: 'mine' } },
    { kind: 'message', key: 'b', row: { role: 'assistant', text: 'two' } },
  ];
  assert.equal(firstNewKey(rows, null), null);
  assert.equal(firstNewKey(rows, new Set(['a', 'u', 'b'])), null);
  assert.equal(firstNewKey(rows, new Set(['a'])), 'b');
  assert.equal(firstNewKey(rows, new Set()), 'a');
});

test('the state carries the shell only as booleans, and Tasks only with the shell', () => {
  assert.deepEqual(parseState({ status: 'online', shell: true, shellTasks: true }), {
    name: 'MoMo',
    status: 'online',
    needsYou: 0,
    shell: true,
    shellTasks: true,
    suggestions: false,
  });
  assert.equal(parseState({ status: 'online', suggestions: true }).suggestions, true);
  assert.equal(parseState({ status: 'online', suggestions: 'yes' }).suggestions, false);
  assert.equal(parseState({ status: 'online', shellTasks: true }).shellTasks, false);
  assert.equal(parseState({ status: 'online', shell: 'yes' }).shell, false);
});

test('the shell’s words are in both catalogs, and the motion tokens are the design’s', () => {
  assert.deepEqual(Object.keys(en.momoShell), Object.keys(zh.momoShell));
  for (const [, v] of Object.entries<string>(zh.momoShell)) assert.ok(v.length > 0);
  assert.equal(en.momoShell.makeEmpty, 'What MoMo makes shows here.');
  assert.deepEqual(MOMO_DUR, { xs: 60, s: 120, m: 200, l: 300, xl: 450 });
});

test('a routine’s switch on the Tasks tab is the Mac’s own pause, one call at a time', async () => {
  const routine = [row({ id: 'routine:r1', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Daily', ref: 'r1' })];
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const m = page({
    tasks: () => ({ v: 2, tasks: routine, paused: false, now: NOW }),
    handlers: {
      'momo.routines.pause': () => hold.then(() => ({ routine: {} })),
      'momo.routines.resume': () => Promise.reject(new Error('Mac refused')),
    },
  });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Scheduled');
  await click('Daily on');
  await click('Pause all');
  assert.deepEqual(calls(m, 'momo.routines.pause'), [{ id: 'r1' }]);
  assert.deepEqual(calls(m, 'momo.prefs.set'), [], 'Pause all while the switch’s call is on its way does nothing');
  await act(async () => release());
  await flush();
  await view.unmount();
});

test('a refused switch on the Tasks tab says why and leaves the list as it was', async () => {
  const routine = [row({ id: 'routine:r1', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Daily', ref: 'r1' })];
  const m = page({
    tasks: () => ({ v: 2, tasks: routine, paused: false, now: NOW }),
    handlers: { 'momo.routines.pause': () => Promise.reject(new Error('Mac refused')) },
  });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Scheduled');
  await click('Daily on');
  assert.match(view.text(), /Mac refused/);
  assert.match(view.text(), /Daily/);
  await view.unmount();
});

test('a paused routine’s switch resumes it', async () => {
  const routine = [
    row({ id: 'routine:r1', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Daily', ref: 'r1', paused: true }),
  ];
  const m = page({
    tasks: () => ({ v: 2, tasks: routine, paused: false, now: NOW }),
    handlers: { 'momo.routines.resume': () => ({ routine: {} }) },
  });
  const view = await mountMomo(m);
  await click('Tasks');
  await click('Scheduled');
  await click('Daily off');
  assert.deepEqual(calls(m, 'momo.routines.resume'), [{ id: 'r1' }]);
  await view.unmount();
});
