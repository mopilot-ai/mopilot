// The scheduled list (electron/app/scheduledList.cjs) takes its rule clock from its caller, so its order never depends on the wall clock or the day of the week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scheduledList } = require('../electron/app/scheduledList.cjs');

test('the scheduled list orders by the caller’s own clock of rules, whatever the day of the week', async () => {
  // a weekly rule can fall before an hourly one in the last minutes of a week; the caller's rule clock decides, not the wall clock
  const tasks = [
    { id: 'weekly', status: 'ACTIVE', rrule: 'FREQ=WEEKLY' },
    { id: 'hourly', status: 'ACTIVE', rrule: 'FREQ=HOURLY' },
    { id: 'none', status: 'ACTIVE', rrule: 'NEVER' },
  ];
  const seen: Array<[string, number]> = [];
  const from = new Date(5);
  const list = await scheduledList(
    { list: async () => ({ tasks }) },
    undefined,
    () => from,
    (rule: string, at: Date) => (seen.push([rule, at.getTime()]), rule === 'NEVER' ? null : new Date(rule === 'FREQ=HOURLY' ? 1000 : 2000)),
  );
  assert.deepEqual(
    list.map((t: any) => [t.id, t.next]),
    [
      ['hourly', 1000],
      ['weekly', 2000],
      ['none', null],
    ],
  );
  assert.deepEqual(seen, [
    ['FREQ=WEEKLY', 5],
    ['FREQ=HOURLY', 5],
    ['NEVER', 5],
  ]);
});
