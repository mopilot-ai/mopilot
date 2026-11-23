// MoMo as Claude's Dispatch: the status capsule the Mac reports (and Pause / "Tap to resume"), reminders with Snooze, Dismiss and Done, dotted day lines, the needs-you pill, and the events that refresh them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const momoPath = '../mobile/src/screens/Momo';
const rowsPath = '../mobile/src/momo/chatRows';
const contractPath = '../mobile/src/momo/stateContract';
const { statusWord, needsLine } = await import(momoPath);
const { dayLabel, momoRows } = await import(rowsPath);
const { parseState, parsePaused, nudgeOf } = await import(contractPath);

const NEW = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set', 'momo.loops.act'];
const NUDGE = {
  role: 'note',
  text: 'Remember the car registration',
  nudge: { loopId: 'L1', title: 'Car registration', quote: 'Renew it before Friday', why: 'Due in 3 days' },
};
const base = (extra: Record<string, any> = {}, methods: string[] = NEW) => ({
  'machine.hello': () => ({ v: 1, capabilities: { momo: true, methods } }),
  'momo.brain.get': () => ({ brain: null }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.sources.status': () => ({ calendar: true, reminders: true }),
  'momo.chat.follow': () => ({ ...snapshotOf([], [NUDGE, { role: 'assistant', text: 'Morning, Du.' }]), itemsShape: 'rows' }),
  'momo.chat.unfollow': () => ({}),
  'momo.state.get': () => ({ name: 'MoMo', color: 'orange', status: 'online', needsYou: 0 }),
  'momo.loops.act': () => ({ loop: {} }),
  ...extra,
});
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;

test('the capsule says what the Mac reports; an older Mac without a state falls back to the connection, never to a guess', () => {
  assert.deepEqual(statusWord('online', true), { text: 'Online', on: true });
  assert.deepEqual(statusWord('online', false), { text: 'Offline', on: false });
  assert.deepEqual(statusWord('offline', true), { text: 'Offline', on: false });
  assert.deepEqual(statusWord('paused', true), { text: 'Paused · Tap to resume', on: false });
  assert.deepEqual(statusWord(null, true), { text: 'Online', on: true });
  assert.deepEqual(statusWord(null, false), { text: 'Offline', on: false });
  assert.equal(needsLine(1), '1 needs you');
  assert.equal(needsLine(3), '3 need you');
});

test('the state, settings and reminder shapes are checked before a screen reads them', () => {
  assert.deepEqual(parseState({ name: 'Mo', status: 'paused', needsYou: 2 }), {
    name: 'Mo',
    status: 'paused',
    needsYou: 2,
    shell: false,
    shellTasks: false,
    suggestions: false,
  });
  assert.deepEqual(parseState({ status: 'online', needsYou: -1 }), {
    name: 'MoMo',
    status: 'online',
    needsYou: 0,
    shell: false,
    shellTasks: false,
    suggestions: false,
  });
  assert.throws(() => parseState({ status: 'asleep' }), /MoMo’s state/);
  assert.throws(() => parseState(null), /MoMo’s state/);
  assert.equal(parsePaused({ paused: true }), true);
  assert.throws(() => parsePaused({ paused: 'yes' }), /settings/);
  assert.deepEqual(nudgeOf(NUDGE), { loopId: 'L1', title: 'Car registration', quote: 'Renew it before Friday', why: 'Due in 3 days' });
  assert.deepEqual(nudgeOf({ nudge: { loopId: 'L2', title: 'T', trigger: 'Calendar' } }), {
    loopId: 'L2',
    title: 'T',
    quote: null,
    why: 'Calendar',
  });
  assert.equal(nudgeOf({ nudge: { loopId: 'L3' } }), null);
  assert.equal(nudgeOf({ role: 'assistant' }), null);
  assert.equal(nudgeOf(null), null);
});

test('a dotted day line heads each day the saved rows carry, and reminders become their own rows', () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  assert.equal(dayLabel(now - 3600_000, now), 'Today');
  assert.equal(dayLabel(now - 86_400_000, now), 'Yesterday');
  assert.match(dayLabel(now - 5 * 86_400_000, now), /Oct|29/);
  const thread = {
    rev: 1,
    session: {},
    shape: 'items',
    history: [
      { role: 'assistant', text: 'Old', at: now - 86_400_000 },
      { ...NUDGE, at: now - 3600_000 },
      { role: 'user', text: 'Thanks', at: now - 1800_000 },
      { role: 'assistant', text: 'No date' },
    ],
    items: [],
    feedSeq: 0,
    liveTurn: null,
    liveTurnStatus: null,
    historyStale: false,
    liveUnavailable: false,
  };
  const rows = momoRows(thread, now);
  assert.deepEqual(
    rows.map((r: any) => (r.kind === 'day' ? `day:${r.label}` : r.kind === 'nudge' ? `nudge:${r.nudge.loopId}` : r.row.text)),
    ['day:Yesterday', 'Old', 'day:Today', 'nudge:L1', 'Thanks', 'No date'],
  );
});

test('a reminder shows what to remember and why, and Snooze, Dismiss and Done answer its loop, then the chat is read again', async () => {
  for (const [button, action, shown] of [
    ['Snooze', { action: 'snooze', snooze: 'day' }, 'Snoozed'],
    ['Dismiss', { action: 'dismiss' }, 'Dismissed'],
    ['Done', { action: 'done' }, 'Done'],
  ] as const) {
    const m = momoRuntime(base());
    const view = await mountMomo(m);
    assert.match(view.text(), /Car registration“Renew it before Friday”Due in 3 days/);
    assert.match(view.text(), /Morning, Du\./);
    assert.match(view.text(), /1 needs you/);
    const follows = m.count('momo.chat.follow');
    await click(button);
    assert.deepEqual(
      m.calls.filter(([method]) => method === 'momo.loops.act').map(([, p]) => p),
      [{ loopId: 'L1', ...action }],
    );
    assert.ok(m.count('momo.chat.follow') > follows, 'the answered reminder is read back from the Mac');
    // what it was answered with replaces the buttons, and it no longer waits: the pill goes, and it cannot be answered twice
    assert.match(view.text(), new RegExp(`Car registration“Renew it before Friday”Due in 3 days✓${shown}`));
    assert.equal(label('Snooze'), null);
    assert.doesNotMatch(view.text(), /needs you/);
    await view.unmount();
  }
});

test('a refused reminder answer is shown, the Mac away disables the reminder, and the pill scrolls to what waits', async () => {
  const m = momoRuntime(base({ 'momo.loops.act': () => Promise.reject(new Error('MoMo is paused. Resume it first.')) }));
  const view = await mountMomo(m);
  await click('1 needs you');
  await click('Done');
  assert.match(view.text(), /MoMo is paused\. Resume it first\./);
  // with the Mac away nothing can be answered: the reminder is not offered as a button that works
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  const done = label('Done') as HTMLButtonElement | null;
  assert.ok(done === null || done.disabled);
  assert.ok(label('Offline'));
  await view.unmount();
});

test('Pause MoMo and the "Tap to resume" capsule set paused through the Mac, and the capsule follows its answer', async () => {
  let paused = false;
  const m = momoRuntime(
    base({
      'momo.state.get': () => ({ name: 'Mo', status: paused ? 'paused' : 'online', needsYou: 0 }),
      'momo.prefs.set': (p: any) => ((paused = p.paused), { paused }),
    }),
  );
  const view = await mountMomo(m);
  await flush();
  assert.match(view.text(), /^‹Mo/, 'the name the Mac gives');
  assert.ok(label('Online'));
  await click('More');
  await click('Pause MoMo');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.prefs.set')![1], { paused: true });
  await flush();
  assert.ok(label('Paused · Tap to resume'));
  await click('Paused · Tap to resume');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { paused: false });
  await flush();
  assert.ok(label('Online'));
  await click('More');
  assert.ok(label('Pause MoMo'));
  await view.unmount();
});

test('an older Mac without the new methods shows no Pause and asks for no state; the capsule is the connection', async () => {
  const m = momoRuntime(base({}, []));
  const view = await mountMomo(m);
  assert.ok(label('Online'));
  await click('More');
  assert.equal(label('Pause MoMo'), null);
  assert.equal(m.count('momo.state.get'), 0);
  await view.unmount();
});

test("a 'chat' change reads the chat again; 'prefs' and 'memory' read MoMo's state again; others leave both", async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  const [follows, states] = [m.count('momo.chat.follow'), m.count('momo.state.get')];
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'chat' }));
  await flush();
  assert.equal(m.count('momo.chat.follow'), follows + 1);
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'prefs' }));
  await flush();
  assert.equal(m.count('momo.state.get'), states + 1);
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'memory' }));
  await flush();
  assert.equal(m.count('momo.state.get'), states + 2);
  await act(async () => m.emit({ kind: 'event', ev: 'other', area: 'chat' }));
  await flush();
  assert.equal(m.count('momo.chat.follow'), follows + 1);
  await view.unmount();
});

/** Calls a view's onLayout as React Native would after laying it out, at `y`. */
async function layOut(el: Element, y: number) {
  const props = (el as any)[Object.keys(el).find((k) => k.startsWith('__reactProps'))!];
  await act(async () => props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 300, height: 80 } } }));
}

test('the transcript draws day lines and quiet step rows; the pill scrolls to the highest thing waiting once it is laid out', async () => {
  const now = Date.now();
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => ({
        ...snapshotOf(
          [{ id: 'k1', rev: 1, title: 'Send it?', choices: [{ key: 'ok', label: 'OK' }] }],
          [{ role: 'assistant', text: 'Earlier', at: now - 86_400_000 }, { role: 'step', text: 'Read the calendar', at: now }, NUDGE],
        ),
        itemsShape: 'rows',
      }),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /YesterdayEarlierTodayRead the calendar/);
  assert.match(view.text(), /2 need you/);
  // before anything is laid out the pill has nowhere to go
  await click('2 need you');
  assert.equal(((globalThis as any).__scrolledTo ?? []).length, 0);
  const placed = [...view.host.querySelectorAll('div')].filter((d) => {
    const key = Object.keys(d).find((k) => k.startsWith('__reactProps'));
    return key && typeof (d as any)[key].onLayout === 'function';
  });
  assert.equal(placed.length, 2, 'the reminder and the card report where they are');
  await layOut(placed[1], 400);
  await layOut(placed[0], 120);
  await layOut(placed[1], 400);
  await click('2 need you');
  assert.deepEqual((globalThis as any).__scrolledTo.at(-1), { y: 120, animated: true });
  delete (globalThis as any).__scrolledTo;
  await view.unmount();
});

test('a working turn without a progress line still says Working…', async () => {
  const chatPath = '../mobile/src/screens/MomoChat';
  const { MomoTranscript } = await import(chatPath);
  const { createElement, createRoot } = await import('./support/phone/component-kit');
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MomoTranscript, {
        rows: [],
        queued: null,
        cards: [],
        answeredOnMac: [],
        answer: async () => true,
        act: () => {},
        canAct: true,
        working: true,
        progress: '',
        empty: null,
        cardRef: () => {},
      }),
    ),
  );
  assert.match(host.textContent!, /Working…/);
  await act(async () => root.unmount());
});

test('an older Mac whose hello lists no methods shows no Pause; MoMo’s page shows the brain and closes with ✕', async () => {
  const m = momoRuntime({
    ...base(),
    'machine.hello': () => ({ v: 1, capabilities: { momo: true } }),
    'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm', modelLabel: 'Sage' } }),
  });
  const view = await mountMomo(m);
  await flush();
  await click('More');
  assert.equal(label('Pause MoMo'), null);
  await click('MoMo’s page');
  assert.match(view.text(), /BrainSage/);
  await click('Close');
  assert.doesNotMatch(view.text(), /BrainSage/);
  await view.unmount();
});

test('live insertion keeps each MoMo reminder and date on its own saved identity', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const thread = {
    ...snapshotOf([], []),
    shape: 'items',
    history: [
      { id: 'reply', role: 'assistant', text: 'Reply', at: now },
      { ...NUDGE, id: 'note' },
    ],
    items: [
      { id: 'u', rowId: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'First' }] },
      { id: 'r', rowId: 'reply', type: 'agentMessage', text: 'Reply' },
    ],
  };
  const rows = momoRows(thread as any, now);
  assert.deepEqual(
    rows.map((r: any) => (r.kind === 'message' ? r.row.text : r.kind)),
    ['First', 'day', 'Reply', 'nudge'],
  );
  assert.equal(rows.at(-1)?.kind === 'nudge' && (rows.at(-1) as any).nudge.loopId, 'L1');
});
