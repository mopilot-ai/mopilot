// What the classic phone draws for all eight combinations of the Mac's Tasks panel, suggestions and brief flags: a brief's suggestion is a card (with Hide and Start) in MoMo's chat only where the Mac says suggestions are on, else only its line; the brief's Scheduled row is drawn only where the Mac sends it (the panel's list, with the brief on); Up next's suggestions only with the panel and suggestions on. With all three off the phone is as it was.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const NOW = new Date(2026, 10, 16, 6, 0).getTime();
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
const CARD = { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam' };
const ROWS = [
  { role: 'note', text: 'Good morning, Mo.' },
  { role: 'note', text: 'Reply to Sam', suggestion: CARD },
];
const BRIEF = {
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
};
const flags = [false, true].flatMap((panel) =>
  [false, true].flatMap((suggestions) => [false, true].map((brief) => ({ panel, suggestions, brief }))),
);

function page(f: { panel: boolean; suggestions: boolean; brief: boolean }) {
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, momoBrainSet: false, methods: METHODS, permissionCeiling: 'auto-review' },
    }),
    'momo.chat.follow': () => ({ ...snapshotOf([], ROWS), itemsShape: 'rows' }),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, ...(f.suggestions ? { suggestions: true } : {}) }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.tasks.list': () => (f.panel ? { v: 2, tasks: f.brief ? [BRIEF] : [], paused: false, now: NOW } : { tasks: [], now: NOW }),
    'momo.suggestions.list': () => ({
      suggestions: [{ ...CARD, why: 'W', step: 'S', status: 'new', score: {} }],
      shown: 6,
      done: {},
      now: NOW,
    }),
    'momo.suggestions.act': (p: any) => ({ id: p.id, action: p.action, channel: 'main' }),
    'momo.brief.runNow': () => ({ ran: true }),
  });
}

for (const f of flags) {
  test(`Tasks panel ${f.panel ? 'on' : 'off'}, suggestions ${f.suggestions ? 'on' : 'off'}, brief ${f.brief ? 'on' : 'off'}: each part is drawn only where its flag says`, async () => {
    const m = page(f);
    const view = await mountMomo(m);
    await flush();
    // MoMo's chat: the greeting always, the suggestion a card only with suggestions on
    const chat = view.text();
    assert.match(chat, /Good morning, Mo\./);
    assert.equal(!!document.querySelector('[aria-label="Start: Reply to Sam"]'), f.suggestions, 'the card’s buttons');
    assert.match(chat, /Reply to Sam/, 'the line or the card says what it is');
    await click('Mo, MoMo’s page');
    await flush();
    if (f.panel) {
      await click('Scheduled');
      assert.equal(/Morning brief/.test(view.text()), f.brief, 'the Scheduled row');
      await click('Up next');
      assert.equal(/From your sources/.test(view.text()), f.suggestions, 'Up next’s suggestions');
    } else {
      assert.doesNotMatch(view.text(), /From your sources|Morning brief/);
    }
    await view.unmount();
  });
}
