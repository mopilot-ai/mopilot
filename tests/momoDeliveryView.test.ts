// The brief settings, notification permission and delivery problems in the view contract's shape (shared/momoDeliveryView.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { momoDeliveryView, momoSettingsView } from '../shared/momoDeliveryView.mjs';

test('settings read as the page draws them: defaults, what the owner set, and quiet hours turned off', () => {
  assert.deepEqual(momoSettingsView(undefined), {
    brief: { on: false, time: '08:00' },
    quietHours: { from: '22:00', to: '08:00' },
    dailyCap: 6,
    previews: false,
  });
  assert.deepEqual(
    momoSettingsView({
      momo: {
        brief: { on: true, time: '7:30' },
        routines: { quietHours: { start: '23:00', end: '6:30' } },
        notify: { previews: true, tellNowMax: 3 },
      },
    }),
    { brief: { on: true, time: '07:30' }, quietHours: { from: '23:00', to: '06:30' }, dailyCap: 3, previews: true },
  );
  assert.deepEqual(momoSettingsView({ momo: { routines: { quietHours: null } } }).quietHours, { from: '00:00', to: '00:00' });
  // values that are not valid read as the defaults
  assert.deepEqual(momoSettingsView({ momo: { brief: { time: '99:00' }, notify: { tellNowMax: 0 } } }), {
    brief: { on: false, time: '08:00' },
    quietHours: { from: '22:00', to: '08:00' },
    dailyCap: 6,
    previews: false,
  });
});

test('notification permission is denied when a phone says so, allowed once a push reached one, else unknown; every problem has its cause and fix', () => {
  const off = {
    pairId: 'p1',
    code: 'notifications_off',
    since: 9,
    id: 'open_settings',
    label: 'Open Settings',
    cause: 'Notifications are off. MoMo keeps things in Chat.',
  };
  const none = momoDeliveryView({ prefs: {}, day: null, pushProblems: [], reachedAPhone: false });
  assert.deepEqual([none.notifications, none.problems], ['unknown', []]);
  assert.equal(momoDeliveryView({ prefs: {}, day: undefined, pushProblems: [], reachedAPhone: true }).notifications, 'allowed');
  const denied = momoDeliveryView({ prefs: {}, day: { failure: null }, pushProblems: [off], reachedAPhone: true });
  assert.equal(denied.notifications, 'denied');
  assert.deepEqual(denied.problems, [
    { id: 'push:p1', code: 'notifications_off', cause: off.cause, fix: { id: 'open_settings', label: 'Open Settings' }, since: 9 },
  ]);
  const lost = momoDeliveryView({
    prefs: {},
    day: null,
    pushProblems: [{ ...off, code: 'token_invalid', id: 'pair_again', label: 'Pair again' }],
    reachedAPhone: true,
  });
  assert.equal(lost.notifications, 'allowed');
  const brief = momoDeliveryView({
    prefs: {},
    day: { failure: { code: 'brief_missed_asleep' } },
    pushProblems: [off],
    reachedAPhone: false,
  });
  assert.deepEqual(
    brief.problems.map((p: any) => [p.id, p.fix.id]),
    [
      ['day:brief_missed_asleep', 'show_brief_now'],
      ['push:p1', 'open_settings'],
    ],
  );
  assert.match(brief.problems[0].cause, /asleep/);
  assert.equal(
    momoDeliveryView({ prefs: {}, day: { failure: { code: 'brief_failed' } }, pushProblems: [], reachedAPhone: false }).problems[0].cause,
    "Couldn't start your brief.",
  );
  // a failure code this view does not know is left out rather than invented
  assert.deepEqual(
    momoDeliveryView({ prefs: {}, day: { failure: { code: 'new_code' } }, pushProblems: [], reachedAPhone: false }).problems,
    [],
  );
});
