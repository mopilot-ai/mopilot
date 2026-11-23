// The morning brief on the classic phone (mobile/src/screens/MomoBriefCard.tsx in MoMo's chat, MomoTaskTabs.tsx and MomoPage.tsx for the Scheduled row, A7): its lines are MoMo's lines and a suggestion is a card with its source and Hide and Start (the user's own presses, each a momo.suggestions.act on the Mac) that says what was done; the Scheduled row says its next time, that it is paused because the user was away for a week, or "Couldn't start" with its reason and a page with Try again (momo.brief.runNow); the words are in both languages.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;

const NOW = new Date(2026, 10, 16, 6, 0).getTime();
const CARD = { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam, Lease' };
const ROWS = [
  { role: 'note', text: 'Good morning, Mo.' },
  { role: 'note', text: 'I can move 1 thing forward:' },
  { role: 'note', text: 'Reply to Sam', suggestion: CARD },
  { role: 'note', text: 'Bad card', suggestion: { id: 'bad id', title: 'X' } },
];
const METHODS = [
  'momo.state.get',
  'momo.prefs.get',
  'momo.prefs.set',
  'momo.tasks.list',
  'momo.tasks.mark',
  'momo.suggestions.list',
  'momo.suggestions.act',
  'momo.brief.runNow',
];
const brief = (over: any) => ({
  id: 'brief:morning',
  kind: 'brief',
  tab: 'scheduled',
  state: 'scheduled',
  title: 'Morning brief',
  detail: null,
  dueDay: null,
  ref: 'momo.brief',
  at: null,
  outcome: null,
  nextAt: NOW + 3_600_000,
  paused: false,
  ...over,
});
/** The Mac's store as the phone reads it: the live suggestions and what was done to the others. */
function store(
  live: object[] = [{ id: 's1', title: 'Reply to Sam', source: 'Mail: Sam, Lease', status: 'new', score: {} }],
  done: Record<string, string> = {},
) {
  const s = { live, done };
  return {
    s,
    list: () => ({ suggestions: s.live, shown: 6, done: s.done, now: NOW }),
    act: (p: any) => {
      s.live = s.live.filter((x: any) => x.id !== p.id);
      s.done = { ...s.done, [p.id]: p.action };
      return { id: p.id, action: p.action, channel: 'main' };
    },
  };
}

function page(o: { row?: any; act?: (p: any) => any; run?: () => any; store?: ReturnType<typeof store>; methods?: string[] } = {}) {
  const mac = o.store ?? store();
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: false, methods: o.methods ?? METHODS, permissionCeiling: 'auto-review' },
    }),
    'momo.chat.follow': () => ({ ...snapshotOf([], ROWS), itemsShape: 'rows' }),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, suggestions: true }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.tasks.list': () => ({ v: 2, tasks: [o.row ?? brief({})], paused: false, now: NOW }),
    'momo.suggestions.list': mac.list,
    'momo.suggestions.act': o.act ?? mac.act,
    'momo.brief.runNow': o.run ?? (() => ({ ran: true })),
  });
}
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);
async function openScheduled() {
  await flush();
  await click('Mo, MoMo’s page');
  await click('Scheduled');
}

test('the brief’s lines are MoMo’s; its suggestion is a card with its source and Hide and Start, and a card with a bad id is only a line', async () => {
  const m = page();
  const view = await mountMomo(m);
  await flush();
  const text = view.text();
  assert.match(text, /Good morning, Mo\./);
  assert.match(text, /I can move 1 thing forward:/);
  assert.match(text, /Reply to SamMail: Sam, LeaseHideStart/);
  assert.match(text, /Bad card/);
  assert.equal((text.match(/Hide/g) ?? []).length, 1);
  assert.equal(m.count('momo.suggestions.act'), 0, 'showing it sends nothing');
  await view.unmount();
});

test('Start asks the Mac to send the first step and the card says Started; Hide says Hidden', async () => {
  for (const [name, said] of [
    ['Start', 'Started'],
    ['Hide', 'Hidden'],
  ]) {
    const m = page();
    const view = await mountMomo(m);
    await flush();
    await click(name);
    assert.deepEqual(calls(m, 'momo.suggestions.act'), [{ id: 's1', action: name.toLowerCase() }]);
    assert.match(view.text(), new RegExp(`Reply to SamMail: Sam, Lease.*${said}`));
    assert.doesNotMatch(view.text(), /HideStart/);
    await view.unmount();
  }
});

test('a card reads what became of its suggestion from the Mac, so it is the same when the chat is opened again; the buttons name it', async () => {
  const waiting = page();
  const w = await mountMomo(waiting);
  await flush();
  for (const name of ['Hide: Reply to Sam', 'Start: Reply to Sam']) assert.ok(document.querySelector(`[aria-label="${name}"]`), name);
  assert.ok(document.querySelector('[aria-label="Reply to Sam. Mail: Sam, Lease"]'), 'the title and its source are one element');
  await w.unmount();
  for (const [done, said] of [
    [{ s1: 'start' }, 'Started'],
    [{ s1: 'hide' }, 'Hidden'],
  ] as const) {
    const m = page({ store: store([], done) });
    const v = await mountMomo(m);
    await flush();
    assert.match(v.text(), new RegExp(`Reply to SamMail: Sam, Lease.*${said}`));
    assert.doesNotMatch(v.text(), /HideStart/);
    await v.unmount();
  }
  // not listed and nothing done: it expired or went
  const gone = page({ store: store([], {}) });
  const g = await mountMomo(gone);
  await flush();
  assert.match(g.text(), /Reply to SamMail: Sam, Lease.*Done/);
  await g.unmount();
  // a Mac that lists no suggestion method cannot be acted on: the card is only the brief's line, and nothing is read
  const older = page({ methods: METHODS.filter((m) => !m.startsWith('momo.suggestions.')) });
  const o = await mountMomo(older);
  await flush();
  assert.match(o.text(), /Reply to Sam/);
  assert.doesNotMatch(o.text(), /HideStart|Mail: Sam, Lease/);
  assert.equal(older.count('momo.suggestions.list'), 0);
  await o.unmount();
});

test('Scheduled: the next time, or why it is paused; no page and no Try again for a brief that is fine', async () => {
  const ok = page();
  const v = await mountMomo(ok);
  await openScheduled();
  assert.match(v.text(), /Morning briefNext 07:00/);
  assert.ok(document.querySelector('[aria-label="Morning brief, Next 07:00"]'), 'the row says its state after its name');
  await v.unmount();
  const away = page({ row: brief({ paused: true, nextAt: null, detail: 'Paused because you were away for a week.' }) });
  const w = await mountMomo(away);
  await openScheduled();
  assert.match(w.text(), /Morning briefPaused because you were away for a week\./);
  await w.unmount();
  const none = page({ row: brief({ nextAt: null }) });
  const n = await mountMomo(none);
  await openScheduled();
  assert.match(n.text(), /Morning brief(?!Next)/);
  await n.unmount();
});

test('a brief that could not start says so with its reason; its page has Try again, which asks the Mac to write it', async () => {
  const m = page({ row: brief({ state: 'failed', detail: 'MoMo’s brain is not signed in.' }) });
  const view = await mountMomo(m);
  await openScheduled();
  assert.match(view.text(), /Morning briefCouldn’t start · MoMo’s brain is not signed in\.›/);
  await click('Morning brief');
  assert.match(view.text(), /Couldn’t start · MoMo’s brain is not signed in\.Try again/);
  await click('Try again');
  assert.equal(m.count('momo.brief.runNow'), 1);
  await view.unmount();
});

test('a refusal of Try again says why on the page', async () => {
  const m = page({
    row: brief({ state: 'failed', detail: 'No brain.' }),
    run: () => {
      throw new Error('Nothing to tell you today.');
    },
  });
  const view = await mountMomo(m);
  await openScheduled();
  await click('Morning brief');
  await click('Try again');
  assert.match(view.text(), /Nothing to tell you today\./);
  await view.unmount();
});

test('every word is in both languages', () => {
  for (const k of ['started', 'hidden', 'done', 'couldNotStart', 'tryAgain', 'next'] as const) {
    assert.ok(en.momoBrief[k], `en ${k}`);
    assert.ok(zh.momoBrief[k], `zh ${k}`);
  }
  assert.match(en.momoBrief.next, /\{\{time\}\}/);
  assert.match(zh.momoBrief.next, /\{\{time\}\}/);
});
