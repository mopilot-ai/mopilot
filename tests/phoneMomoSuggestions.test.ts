// MoMo's suggestions in the classic phone's Up next (mobile/src/screens/MomoSuggestions.tsx over MomoTaskTabs.tsx and MomoPage.tsx, A7), where the Mac lists momo.suggestions.list and .act with the four-tab panel: "From your sources" with each one's title and source line, "Added by you", "Show n more" past the Mac's `shown`; a suggestion's page has the reason, the first step and what the ranking used, with Start, Add and Hide, each a request the Mac takes as the user's own; Start closes the sheet; a Mac without the methods shows none; words are in both languages.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';
import { parseSuggestions } from '../mobile/src/momo/suggestionsContract';

const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;

const NOW = new Date(2026, 10, 16, 9, 0).getTime();
const BASE = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set', 'momo.tasks.list', 'momo.tasks.mark'];
const WITH = [...BASE, 'momo.suggestions.list', 'momo.suggestions.act'];
const sug = (n: number, over: any = {}) => ({
  id: `s${n}`,
  title: `Reply to person ${n}`,
  why: `Person ${n} asked on Monday.`,
  source: `Mail: person ${n}`,
  step: `Draft a reply to person ${n}`,
  status: 'new',
  score: { urgency: 1, cost: 0.9, confidence: 0.9, novelty: 0.5, total: 0.4 },
  ...over,
});
const loop = {
  id: 'loop:L2',
  kind: 'loop',
  tab: 'next',
  state: 'queued',
  title: 'Plan the offsite',
  detail: 'someday',
  dueDay: null,
  ref: 'L2',
  at: null,
  outcome: null,
  nextAt: null,
  paused: false,
};
function page(o: { methods?: string[]; list?: () => any; extra?: Record<string, any>; tasks?: any[] } = {}) {
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: false, methods: o.methods ?? WITH, permissionCeiling: 'auto-review' },
    }),
    'momo.chat.follow': () => snapshotOf([]),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, suggestions: true }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.tasks.list': () => ({ v: 2, tasks: o.tasks ?? [loop], paused: false, now: NOW }),
    'momo.suggestions.list': o.list ?? (() => ({ suggestions: [sug(1), sug(2, { status: 'added' })], shown: 6, now: NOW })),
    'momo.suggestions.act': (p: any) => ({ id: p.id, action: p.action, channel: 'main' }),
    ...o.extra,
  });
}
async function openUpNext() {
  await flush();
  await click('Mo, MoMo’s page');
  await click('Up next');
}
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;

test('Up next lists the suggestions with their source line, then what the user added, and the user’s own promises after them', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openUpNext();
  assert.match(view.text(), /From your sourcesReply to person 1Mail: person 1›/);
  assert.match(view.text(), /Added by youReply to person 2Mail: person 2›/);
  assert.match(view.text(), /Plan the offsitesomeday›/);
  assert.doesNotMatch(view.text(), /Nothing queued/);
  assert.equal(m.count('momo.suggestions.act'), 0, 'showing a suggestion sends nothing');
  await view.unmount();
});

test('a list row reads its title and then its source line; the page reads them as one element', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openUpNext();
  assert.ok(document.querySelector('[aria-label="Reply to person 1, Mail: person 1"]'), 'the list row');
  await click('Reply to person 1');
  assert.ok(document.querySelector('[aria-label="Reply to person 1. Mail: person 1"]'), 'the page’s title and source line');
  await view.unmount();
});

test('a suggestion’s page has the reason, the first step and the ranking; Start asks the Mac and closes the sheet', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openUpNext();
  await click('Reply to person 1');
  assert.match(view.text(), /Mail: person 1/);
  assert.match(view.text(), /Why\?Person 1 asked on Monday\./);
  assert.match(view.text(), /First stepDraft a reply to person 1/);
  assert.match(view.text(), /Ranked on: soon 1, cost 0.9, sure 0.9, new 0.5\./);
  assert.equal(m.count('momo.suggestions.act'), 0);
  await click('Start');
  assert.deepEqual(calls(m, 'momo.suggestions.act'), [{ id: 's1', action: 'start' }]);
  assert.equal(label('Mo, MoMo’s page') !== null, true, 'the sheet is closed: the chat shows');
  assert.doesNotMatch(view.text(), /Ranked on/);
  await view.unmount();
});

test('Add and Hide ask the Mac and come back to the page; an added one has no Add', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openUpNext();
  await click('Reply to person 1');
  await click('Add');
  assert.deepEqual(calls(m, 'momo.suggestions.act'), [{ id: 's1', action: 'add' }]);
  // back on the page, still on Up next: Add does not jump to Active (the row is under "Added by you" until the task entity exists)
  assert.match(view.text(), /From your sourcesReply to person 1.*Added by youReply to person 2/);
  assert.match(view.text(), /Reply to person 2/);
  await click('Reply to person 2');
  assert.doesNotMatch(view.text(), /\bAdd\b/);
  assert.match(view.text(), /StartHide/);
  await click('Hide');
  assert.deepEqual(calls(m, 'momo.suggestions.act').at(-1), { id: 's2', action: 'hide' });
  await view.unmount();
});

test('the page’s buttons name the suggestion they act on, in both languages', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openUpNext();
  await click('Reply to person 1');
  for (const name of ['Start: Reply to person 1', 'Add: Reply to person 1', 'Hide: Reply to person 1'])
    assert.ok(document.querySelector(`[aria-label="${name}"]`), name);
  assert.match(zh.momoTasks.startNamed, /\{\{title\}\}/);
  assert.match(zh.momoTasks.addNamed, /\{\{title\}\}/);
  assert.match(zh.momoTasks.hideNamed, /\{\{title\}\}/);
  await view.unmount();
});

test('the Mac’s record of what was done to a suggestion is read as start or hide, and nothing else', () => {
  const read = parseSuggestions({ suggestions: [], done: { a: 'start', b: 'hide', c: 'add', d: 5 } });
  assert.deepEqual(read.done, { a: 'start', b: 'hide' });
  assert.deepEqual(parseSuggestions({ suggestions: [] }).done, {});
  assert.deepEqual(parseSuggestions({ suggestions: [], done: [] }).done, {});
});

test('a refused act says why on the page and leaves the suggestion; the page does not act twice while it waits', async () => {
  const m = page({
    extra: {
      'momo.suggestions.act': () => {
        throw new Error('MoMo is paused. Resume it first.');
      },
    },
  });
  const view = await mountMomo(m);
  await openUpNext();
  await click('Reply to person 1');
  await click('Start');
  assert.match(view.text(), /MoMo is paused\. Resume it first\./);
  assert.match(view.text(), /Ranked on/, 'still on the suggestion’s page');
  await view.unmount();
});

test('only the Mac’s `shown` new ones are listed, and Show n more lists the rest', async () => {
  const m = page({ list: () => ({ suggestions: [1, 2, 3, 4].map((n) => sug(n)), shown: 2, now: NOW }) });
  const view = await mountMomo(m);
  await openUpNext();
  assert.match(view.text(), /Reply to person 2/);
  assert.doesNotMatch(view.text(), /Reply to person 3/);
  await click('Show 2 more');
  assert.match(view.text(), /Reply to person 4/);
  assert.doesNotMatch(view.text(), /Show 2 more/);
  await view.unmount();
});

test('only suggestions and no promise: Up next has no empty line; none at all: it has', async () => {
  const only = await mountMomo(page({ tasks: [] }));
  await openUpNext();
  assert.doesNotMatch(only.text(), /Nothing queued/);
  assert.match(only.text(), /Reply to person 1/);
  await only.unmount();
  const none = await mountMomo(page({ tasks: [], list: () => ({ suggestions: [], shown: 6, now: NOW }) }));
  await openUpNext();
  assert.match(none.text(), /Nothing queued\. Suggestions from your sources show here\./);
  await none.unmount();
});

test('a Mac that lists no suggestion method shows none and never asks; a read that fails leaves Up next as it was', async () => {
  for (const methods of [BASE, [...BASE, 'momo.suggestions.list'], [...BASE, 'momo.suggestions.act']]) {
    const m = page({ methods });
    const view = await mountMomo(m);
    await openUpNext();
    assert.match(view.text(), /Plan the offsite/);
    assert.doesNotMatch(view.text(), /From your sources|Reply to person/);
    assert.equal(m.count('momo.suggestions.list'), 0);
    await view.unmount();
  }
  const failing = page({
    list: () => {
      throw new Error('no');
    },
  });
  const view = await mountMomo(failing);
  await openUpNext();
  assert.match(view.text(), /Plan the offsite/);
  assert.doesNotMatch(view.text(), /Reply to person/);
  await view.unmount();
});

test('every word is in both languages', () => {
  const keys = ['fromSources', 'addedByYou', 'showMore', 'start', 'add', 'hide', 'why', 'firstStep', 'ranked'] as const;
  for (const k of keys) {
    assert.ok(en.momoTasks[k], `en ${k}`);
    assert.ok(zh.momoTasks[k], `zh ${k}`);
  }
  assert.match(en.momoTasks.showMore, /\{\{n\}\}/);
  assert.match(zh.momoTasks.showMore, /\{\{n\}\}/);
  for (const part of ['urgency', 'cost', 'confidence', 'novelty']) assert.match(zh.momoTasks.ranked, new RegExp(`\\{\\{${part}\\}\\}`));
});
