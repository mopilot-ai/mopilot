// What the classic phone draws for every combination of the Mac's Tasks panel (`momo.tasksPanel`: v2 tasks or the classic list) and suggestions (`momo.suggestions`: said by momo.state.get, with the methods listed either way): Up next's suggestions only with the suggestions flag on (and the panel there to show them), never with it off, whatever the panel; the classic Tasks list when the panel is off. (The brief's flag joins this table in tests/phoneMomoBriefFlags.test.ts.)
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const NOW = new Date(2026, 10, 16, 9, 0).getTime();
const METHODS = [
  'momo.state.get',
  'momo.prefs.get',
  'momo.prefs.set',
  'momo.tasks.list',
  'momo.tasks.mark',
  'momo.suggestions.list',
  'momo.suggestions.act',
];
const SUG = { id: 's1', title: 'Reply to Sam', why: 'He asked.', source: 'Mail: Sam', step: 'Draft', status: 'new', score: {} };
const LOOP = {
  id: 'L2',
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

function page(o: { panel: boolean; suggestions: boolean }) {
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: false, methods: METHODS, permissionCeiling: 'auto-review' },
    }),
    'momo.chat.follow': () => snapshotOf([]),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, ...(o.suggestions ? { suggestions: true } : {}) }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.tasks.list': () => (o.panel ? { v: 2, tasks: [LOOP], paused: false, now: NOW } : { tasks: [], now: NOW }),
    'momo.suggestions.list': () => ({ suggestions: [SUG], shown: 6, done: {}, now: NOW }),
    'momo.suggestions.act': (p: any) => ({ id: p.id, action: p.action, channel: 'main' }),
  });
}

for (const panel of [false, true]) {
  for (const suggestions of [false, true]) {
    test(`Tasks panel ${panel ? 'on' : 'off'}, suggestions ${suggestions ? 'on' : 'off'}: suggestions are drawn only with their flag and the panel; the list is the panel's or the classic one`, async () => {
      const m = page({ panel, suggestions });
      const view = await mountMomo(m);
      await flush();
      await click('Mo, MoMo’s page');
      await flush();
      if (panel) {
        await click('Up next');
        assert.match(view.text(), /Plan the offsite/);
      }
      const text = view.text();
      // a suggestion is drawn only where the panel is and the Mac's flag says so
      assert.equal(/Reply to Sam/.test(text), panel && suggestions, 'a suggestion row');
      assert.equal(/From your sources/.test(text), panel && suggestions, 'its group');
      assert.equal(/Active|Up next|Scheduled|Resolved/.test(text.replace(/Up next$/, '')), panel, 'the four tabs, or the classic list');
      // with the flag off nothing is even read (with it on, the read is the panel's Up next's, or a brief's cards')
      if (!suggestions) assert.equal(m.count('momo.suggestions.list'), 0, 'nothing is read with the flag off');
      await view.unmount();
    });
  }
}

test('all flags off is MoMo as it was: the classic Tasks list, no suggestion read or row', async () => {
  const m = page({ panel: false, suggestions: false });
  const view = await mountMomo(m);
  await flush();
  await click('Mo, MoMo’s page');
  assert.doesNotMatch(view.text(), /From your sources|Reply to Sam/);
  assert.equal(m.count('momo.suggestions.list'), 0);
  assert.equal(m.count('momo.suggestions.act'), 0);
  await view.unmount();
});
