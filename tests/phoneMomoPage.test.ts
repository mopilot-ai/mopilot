// MoMo's page behind its name: the hero with Pause/Resume, Needs you, What MoMo knows (About you, Recently learned with Undo, Replaced), Sources, Proactivity, Quiet hours and the brain's Effort; each part only where the Mac lists its method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const contractPath = '../mobile/src/momo/pageContract';
const pagePath = '../mobile/src/screens/MomoPage';
const { parsePrefs, parseChanges, parsePast, parseBrainChoice, itemLine, levelLabel, effortLabel, brainName } = await import(contractPath);
const { quietLine } = await import(pagePath);

const ALL = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set', 'momo.memory.changes', 'momo.memory.writeDoc'];
const PREFS = {
  paused: false,
  proactivity: 'default',
  quietHours: null,
  levels: [{ id: 'off' }, { id: 'low' }, { id: 'default' }, { id: 'high' }],
};
const CHANGES = {
  changes: [
    { id: 'c1', op: 'save', by: 'pass', at: 1_700_000_000_000, items: [{ after: { id: 'f1', text: 'Likes tea' } }], undoable: true },
    {
      id: 'c2',
      op: 'forget',
      by: 'user',
      at: 1_700_000_000_000,
      items: [{ before: { id: 'f2', text: 'Old job' } }],
      undoable: false,
      undone: 1,
    },
  ],
};
function page(extra: Record<string, any> = {}, methods: string[] = ALL, brainSet = true) {
  let prefs = { ...PREFS };
  let brain: any = { harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus', effort: 'high' };
  const m = momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: brainSet, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf([{ id: 'k1', rev: 1, title: 'Send it?', choices: [{ key: 'ok', label: 'OK' }] }]),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain }),
    'momo.brain.set': (p: any) => ((brain = p.brain), { brain }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: false }),
    'momo.state.get': () => ({ name: 'Mo', status: prefs.paused ? 'paused' : 'online', needsYou: 1 }),
    'momo.prefs.get': () => prefs,
    'momo.prefs.set': (p: any) => ((prefs = { ...prefs, ...p }), prefs),
    'momo.memory.changes': () => CHANGES,
    'momo.memory.past': () => ({ facts: [{ id: 'f9', text: 'Lived in Boston' }] }),
    'momo.memory.undo': () => ({ change: {} }),
    'momo.memory.docs': () => ({ aboutYou: 'I like tea.', persona: 'Warm', unreadable: [] }),
    'momo.memory.writeDoc': () => ({ written: true }),
    'momo.memory.list': () => ({ facts: [{ id: 'f1', text: 'Likes tea' }], now: 1 }),
    'harnesses.list': () => ({ harnesses: [{ id: 'claude', label: 'Claude Code' }] }),
    'projects.list': () => ({ projects: [] }),
    'options.get': () => ({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
          ],
        },
      ],
      model: 'opus',
      permission: { rows: [], value: null },
    }),
    ...extra,
  });
  return m;
}
async function openPage() {
  await flush();
  await click('Mo, MoMo’s page');
}
/** The sheet's ‹, drawn after the screen's own Back. */
async function sheetBack() {
  const backs = [...document.querySelectorAll('button[aria-label="Back"]')];
  await act(async () => (backs.at(-1) as HTMLElement).click());
  await flush();
}
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement | null;

test('the page’s shapes are read with care: settings, changes, replaced facts, the brain, a change’s line', () => {
  assert.deepEqual(parsePrefs({ ...PREFS, quietHours: { start: '22:00', end: '07:00' } }), {
    paused: false,
    proactivity: 'default',
    quietHours: { start: '22:00', end: '07:00' },
    levels: ['off', 'low', 'default', 'high'],
  });
  assert.equal(parsePrefs({ paused: true, proactivity: 'low', quietHours: { start: '25:00', end: 'x' } }).quietHours, null);
  assert.deepEqual(parsePrefs({ paused: true, proactivity: 'low' }).levels, []);
  assert.throws(() => parsePrefs({ paused: 'no' }), /settings/);
  assert.throws(() => parsePrefs(null), /settings/);
  const changes = parseChanges({
    changes: [...CHANGES.changes, { id: 'c3', op: 'odd', by: { chatId: 'x', harness: 'codex' }, at: 1, items: [{}] }, { id: 'bad' }, null],
  });
  assert.deepEqual(
    changes.map((c: any) => [c.id, c.verb, c.by, c.lines, c.undoable, c.undone]),
    [
      ['c1', 'Added', 'MoMo', ['+ Likes tea'], true, false],
      ['c2', 'Deleted', 'You', ['− Old job'], false, true],
      ['c3', 'Changed', 'A chat', [], false, false],
    ],
  );
  assert.deepEqual(parseChanges({ changes: [{ id: 'c4', op: 'update', by: 'user', at: 2 }] })[0].lines, []);
  assert.throws(() => parseChanges({}), /what MoMo learned/);
  assert.equal(itemLine({ before: { text: 'a', invalidAt: undefined }, after: { text: 'b', invalidAt: 5 } }), 'Replaced: a');
  assert.equal(itemLine({ before: { text: 'a' }, after: { text: 'a' } }), 'a');
  assert.equal(itemLine({ before: { text: 'a' }, after: { text: 'b' } }), 'a → b');
  assert.equal(itemLine({ before: {}, after: {} }), '');
  assert.equal(itemLine({ before: null, after: {} }), '+ ');
  assert.equal(itemLine({ before: {} }), '− ');
  assert.equal(itemLine(null), null);
  assert.deepEqual(parsePast({ facts: [{ id: 'f', text: 'x' }, { id: 'y' }] }), [{ id: 'f', text: 'x' }]);
  assert.throws(() => parsePast({}), /past memories/);
  assert.deepEqual(parseBrainChoice({ brain: { harness: 'h', model: 'm' } }), {
    harness: 'h',
    account: null,
    model: 'm',
    modelLabel: null,
    effort: null,
  });
  assert.equal(parseBrainChoice({ brain: null }), null);
  assert.equal(levelLabel('high'), 'High');
  assert.deepEqual([effortLabel(null), effortLabel('xhigh'), effortLabel('ultra')], ['Default', 'Extra high', 'ultra']);
  assert.equal(levelLabel('turbo'), 'turbo');
  assert.equal(quietLine(null), 'Off');
  assert.equal(quietLine({ start: '22:00', end: '07:00' }), '22:00–07:00');
});

test('MoMo’s name opens its page: hero, Needs you that closes the page onto the waiting card, sources, settings and Pause', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  assert.match(view.text(), /MoOnlinePause/);
  assert.match(view.text(), /Needs you1 waiting for you/);
  assert.match(view.text(), /What MoMo knowsAbout you›Memories›Recently learned›/);
  assert.match(view.text(), /SourcesCalendarConnectedRemindersNot connectedConnect them on your Mac\./);
  assert.match(view.text(), /SettingsProactivityDefault›Quiet hoursOff›BrainOpus›/);
  await click('1 waiting for you');
  assert.equal(label('Dismiss'), null, 'the page closed onto the chat');
  await openPage();
  await click('Pause');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { paused: true });
  await view.unmount();
});

test('Proactivity and Quiet hours are set one at a time and read back', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Proactivity, Default');
  assert.match(view.text(), /OffLowDefault✓High/);
  await click('High');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { proactivity: 'high' });
  await flush();
  await sheetBack();
  await click('Quiet hours, Off');
  await inputText('From (22:00)', '23:00');
  await inputText('Until (07:00)', '23:00');
  assert.equal((label('Save') as HTMLButtonElement).disabled, true, 'start and end must differ');
  await inputText('Until (07:00)', '06:30');
  await click('Save');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { quietHours: { start: '23:00', end: '06:30' } });
  await flush();
  await click('Turn off');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { quietHours: null });
  await view.unmount();
});

test('About you is saved through writeDoc; Recently learned undoes a change and shows a refusal; Replaced lists past facts', async () => {
  let refuse = false;
  const m = page({ 'momo.memory.undo': () => (refuse ? Promise.reject(new Error('That fact changed since.')) : { change: {} }) });
  const view = await mountMomo(m);
  await openPage();
  await click('About you');
  assert.equal((label('Save') as HTMLButtonElement).disabled, true);
  await inputText('What MoMo should know about you', 'I like green tea.');
  await click('Save');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.memory.writeDoc')![1], { doc: 'aboutYou', text: 'I like green tea.' });
  await flush();
  assert.equal((label('Save') as HTMLButtonElement).disabled, true, 'saved: nothing to save now');
  await sheetBack();
  await click('Recently learned');
  assert.match(view.text(), /Added: \+ Likes teaMoMo ·.*Deleted: − Old jobYou ·.*· Undone.*ReplacedLived in Boston/);
  await click('Undo');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.memory.undo')![1], { changeId: 'c1' });
  refuse = true;
  await flush();
  await click('Undo');
  assert.match(view.text(), /That fact changed since\./);
  await view.unmount();
});

test('the brain’s effort is picked from what its model offers where the Mac allows brain changes, and is only shown where it does not', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Brain, Opus');
  assert.match(view.text(), /ModelOpusEffortHigh/);
  await click('Effort, High');
  assert.match(view.text(), /LowHigh/);
  await click('Low');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.brain.set')![1], {
    brain: { harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus', effort: 'low' },
  });
  // ‹ from Effort goes back to the brain, then to the page
  await sheetBack();
  assert.match(view.text(), /ModelOpus/);
  await view.unmount();

  const locked = page({}, ALL, false);
  const second = await mountMomo(locked);
  await openPage();
  await click('Brain, Opus');
  const effort = label('Effort, High');
  assert.equal(effort, null, 'shown as a row, not a button');
  assert.match(second.text(), /EffortHigh/);
  assert.equal(label('Use this brain'), null);
  await second.unmount();
});

test('an effort list that fails says why, and a model with none says so', async () => {
  const failing = page({ 'options.get': () => Promise.reject(new Error('No models on this Mac')) });
  const a = await mountMomo(failing);
  await openPage();
  await click('Brain, Opus');
  await click('Effort, High');
  assert.match(a.text(), /No models on this Mac/);
  await a.unmount();
  const none = page({
    'options.get': () => ({ models: [{ id: 'opus', label: 'Opus', efforts: [] }], model: 'opus', permission: { rows: [], value: null } }),
  });
  const b = await mountMomo(none);
  await openPage();
  await click('Brain, Opus');
  await click('Effort, High');
  assert.match(b.text(), /This model has no effort setting\./);
  await b.unmount();
});

test('an older Mac shows only what it offers: no About you, no Recently learned, no settings, no Pause', async () => {
  const m = page({}, []);
  const view = await mountMomo(m);
  await flush();
  await click('MoMo, MoMo’s page');
  assert.match(view.text(), /What MoMo knowsMemories›/);
  assert.doesNotMatch(view.text(), /About you|Recently learned|Proactivity|Quiet hours|Pause/);
  assert.equal(m.count('momo.prefs.get'), 0);
  assert.equal(m.count('momo.memory.changes'), 0);
  // the brain the Mac reports still shows
  assert.match(view.text(), /BrainOpus/);
  await click('Close');
  await view.unmount();
});

test('a paused MoMo says so on its page and resumes from it; ⋯ also opens the page', async () => {
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await click('More');
  await click('Pause MoMo');
  await flush();
  await click('More');
  await click('MoMo’s page');
  assert.match(view.text(), /MoPausedResume/);
  await click('Resume');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.prefs.set').at(-1)![1], { paused: false });
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'prefs' }));
  await flush();
  await view.unmount();
});

test('the leftovers of what the Mac sends read sensibly: odd levels, a change without its texts, a brain without a model name', () => {
  assert.deepEqual(parsePrefs({ paused: false, proactivity: 'low', levels: [{ id: 'low' }, {}, 'x'] }).levels, ['low']);
  assert.equal(itemLine({ before: {}, after: { invalidAt: 3 } }), 'Replaced: ');
  assert.equal(itemLine({ before: { text: 'a' }, after: {} }), 'a → ');
  assert.equal(itemLine({ before: {}, after: { text: 'b' } }), ' → b');
  assert.deepEqual(
    [
      brainName({ harness: 'h', account: null, model: 'm', modelLabel: 'M', effort: null }),
      brainName({ harness: 'h', account: null, model: 'm', modelLabel: null, effort: null }),
      brainName({ harness: 'h', account: null, model: null, modelLabel: null, effort: null }),
    ],
    ['M', 'm', 'h'],
  );
});

test('Needs you scrolls to the waiting card once it is laid out; a Calendar that is not connected says so', async () => {
  const m = page({ 'momo.sources.status': () => ({ calendar: false, reminders: true }) });
  const view = await mountMomo(m);
  await openPage();
  assert.match(view.text(), /CalendarNot connectedRemindersConnected/);
  await click('Close');
  const placed = [...view.host.querySelectorAll('div')].filter((d) => {
    const key = Object.keys(d).find((k) => k.startsWith('__reactProps'));
    return key && typeof (d as any)[key].onLayout === 'function';
  });
  const props = (placed[0] as any)[Object.keys(placed[0]).find((k) => k.startsWith('__reactProps'))!];
  await act(async () => props.onLayout({ nativeEvent: { layout: { x: 0, y: 240, width: 300, height: 80 } } }));
  await openPage();
  await click('1 waiting for you');
  assert.deepEqual((globalThis as any).__scrolledTo.at(-1), { y: 240, animated: true });
  delete (globalThis as any).__scrolledTo;
  await view.unmount();
});

test('About you that cannot be read says why; an effort list for a model the Mac no longer lists is empty; a refusal that is plain text is shown', async () => {
  const m = page({
    'momo.memory.docs': () => Promise.reject('Memory is locked'),
    'options.get': () => ({
      models: [{ id: 'other', label: 'Other', efforts: [] }],
      model: 'other',
      permission: { rows: [], value: null },
    }),
  });
  const view = await mountMomo(m);
  await openPage();
  await click('About you');
  assert.match(view.text(), /Memory is locked/);
  await sheetBack();
  await click('Brain, Opus');
  await click('Effort, High');
  assert.match(view.text(), /This model has no effort setting\./);
  await view.unmount();
});

test('Recently learned with nothing says so, and a change with no fact lines is just its verb', async () => {
  const m = page({ 'momo.memory.changes': () => ({ changes: [] }), 'momo.memory.past': () => ({ facts: [] }) });
  const view = await mountMomo(m);
  await openPage();
  await click('Recently learned');
  assert.match(view.text(), /Nothing learned lately\./);
  await view.unmount();
  const bare = page({
    'momo.memory.changes': () => ({ changes: [{ id: 'c9', op: 'pass', by: 'pass', at: 1, items: [], undoable: false }] }),
  });
  const second = await mountMomo(bare);
  await openPage();
  await click('Recently learned');
  assert.match(second.text(), /UpdatedMoMo ·/);
  assert.doesNotMatch(second.text(), /Updated:/);
  await second.unmount();
});

test('a paused MoMo keeps every routine edit open and only Run waits, saying why', async () => {
  const routine = { id: 'r1', name: 'Morning brief', schedule: 'Weekdays 8:30', paused: false, prompt: 'Brief me' };
  const m = page({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: true, methods: [...ALL, 'momo.routines.edit', 'momo.routines.delete'] },
    }),
    'momo.state.get': () => ({ name: 'Mo', status: 'paused', needsYou: 0 }),
    'momo.routines.list': () => ({ proposals: [], routines: [routine] }),
    'momo.routines.pause': () => undefined,
  });
  const view = await mountMomo(m);
  await openPage();
  await click('Morning brief, On');
  assert.match(view.text(), /Run nowResume MoMo to run it/);
  assert.equal(label('Run now'), null, 'not a button while paused');
  assert.ok(label('Pause'));
  assert.ok(label('Delete routine'));
  assert.ok(document.querySelector('input[placeholder="Name"]'));
  await click('Pause');
  assert.ok(m.calls.some(([method]) => method === 'momo.routines.pause'));
  await view.unmount();
});
