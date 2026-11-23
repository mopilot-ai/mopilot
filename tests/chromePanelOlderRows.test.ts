// The page of older rows a phone pages back to (chromePanelLive.cjs olderRowsOf): the rows before a named row, inside the frame budget, starting at a row that can be named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowsOf, recentRowsOf, olderRowsOf, MAX_ROWS, MAX_TOTAL } = require('../electron/capabilities/browser/chromePanelLive.cjs');

test('older rows: the page just before a row, newest page first, without screenshots; a row that is gone gives null', () => {
  const turns = [
    {
      id: 't1',
      items: [
        { id: 'a', type: 'userMessage', content: [{ type: 'text', text: 'one' }] },
        { id: 'b', type: 'agentMessage', text: 'two' },
        { id: 'c', type: 'userMessage', content: [{ type: 'text', text: 'three' }] },
        { id: 'd', type: 'agentMessage', text: 'four' },
      ],
    },
  ];
  const all = rowsOf(turns).rows;
  assert.equal(all.length, 4);
  const before = (n: number) => all[n].id;
  assert.deepEqual(olderRowsOf(turns, before(3), 2), { rows: [all[1], all[2]], more: true });
  assert.deepEqual(olderRowsOf(turns, before(3), 10), { rows: [all[0], all[1], all[2]], more: false });
  assert.deepEqual(olderRowsOf(turns, before(0), 5), { rows: [], more: false });
  assert.equal(olderRowsOf(turns, 'no such row', 5), null);
  // rows past the recent end that rowsOf clips are reachable page by page
  const many = [
    { id: 'm', items: Array.from({ length: MAX_ROWS + 30 }, (_, i) => ({ id: `i${i}`, type: 'agentMessage', text: `r${i}` })) },
  ];
  assert.equal(rowsOf(many).clipped, true);
  const last = (olderRowsOf(many, rowsOf(many).rows[0].id, 25) as any).rows;
  assert.equal(last.length, 25);
  assert.equal(last.at(-1).text, `r${29}`);
  // a screenshot belongs to the live end
  const shot = [
    {
      id: 's',
      items: [
        { id: 'x', type: 'agentMessage', text: 'hi' },
        { id: 'y', type: 'agentMessage', text: 'end' },
      ],
    },
  ];
  const rows = rowsOf(shot).rows;
  (rows[0] as any).thumbnail = 'data';
  assert.equal((olderRowsOf(shot, rows[1].id, 5) as any).rows[0].thumbnail, undefined);
});

test('older rows: a page stays inside the frame budget, starts at a row that can be named, and always holds a row', () => {
  const big = 'x'.repeat(19_000);
  const turns = [{ id: 'b', items: Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, type: 'agentMessage', text: `${i}${big}` })) }];
  const last = rowsOf(turns).rows.at(-1) as any;
  assert.equal(last.text.startsWith('29'), true);
  const page = olderRowsOf(turns, last.id, 100) as any;
  assert.ok(page.rows.length >= 1 && page.rows.length < 12, `${page.rows.length} long rows`);
  assert.ok(JSON.stringify(page.rows).length < 200_000, 'well inside one 256 KB frame');
  assert.equal(page.more, true);
  assert.equal(page.rows.at(-1).text.startsWith('28'), true, 'the page ends just before the row asked');
  const one = [
    {
      id: 'o',
      items: [
        { id: 'a', type: 'agentMessage', text: 'y'.repeat(19_000) },
        { id: 'b', type: 'agentMessage', text: 'z' },
      ],
    },
  ];
  assert.equal((olderRowsOf(one, rowsOf(one).rows[1].id, 5) as any).rows.length, 1, 'a single row bigger than the budget is still sent');
  // rows with no id cannot start a page: it reaches back to one that has an id
  const mixed = [
    {
      id: 't',
      items: [
        { id: 'p', type: 'agentMessage', text: 'one' },
        { type: 'agentMessage', text: 'two' },
        { type: 'agentMessage', text: 'three' },
        { id: 'q', type: 'agentMessage', text: 'four' },
      ],
    },
  ];
  const rows = (rowsOf(mixed).rows as any[]).filter((r) => r.id !== undefined || true);
  const idOfFour = rows.find((r) => r.text === 'four').id;
  const m = olderRowsOf(mixed, idOfFour, 2) as any;
  assert.equal(m.rows[0].id !== undefined, true, 'the first row of the page has an id');
  assert.deepEqual(
    m.rows.map((r: any) => r.text),
    ['one', 'two', 'three'],
  );
  assert.equal(m.more, false);
  const noIdAtAll = [
    {
      id: 't',
      items: [
        { type: 'agentMessage', text: 'a' },
        { id: 'k', type: 'agentMessage', text: 'b' },
      ],
    },
  ];
  assert.deepEqual(
    (olderRowsOf(noIdAtAll, rowsOf(noIdAtAll).rows[1].id, 5) as any).rows.map((r: any) => r.text),
    ['a'],
  );
});

test('the older op: a chat with no saved record has no rows to page, an unreachable chat is gone, and notes ride along', async () => {
  const { createPanelOlder } = require('../electron/app/chromePanelOlder.cjs');
  const records = new Map<string, any>();
  const older = createPanelOlder({
    live: { chats: { records } },
    reachable: (id: string) => id !== 'nobody',
    historyOf: async () => ({
      turns: [
        {
          id: 't',
          items: [
            { id: 'a', type: 'agentMessage', text: 'one' },
            { id: 'b', type: 'agentMessage', text: 'two' },
          ],
        },
      ],
    }),
  });
  assert.equal(await older('native-only', 'any', 10), null, 'nothing saved here: the row asked for is not there');
  await assert.rejects(older('nobody', 'any', 10), /isn't in MoPilot|not in/i);
  records.set('c', { meta: { notes: 'not a list' } });
  const second = (
    rowsOf([
      {
        id: 't',
        items: [
          { id: 'a', type: 'agentMessage', text: 'one' },
          { id: 'b', type: 'agentMessage', text: 'two' },
        ],
      },
    ]).rows[1] as any
  ).id;
  assert.deepEqual(await older('c', second, 10), {
    rows: [
      {
        role: 'assistant',
        text: 'one',
        id: JSON.stringify([undefined, 't', 'a']),
        // #4201 preserves the panel cursor while also carrying the shared phone identity.
        phoneId: JSON.stringify([null, 't', 'agentMessage', 'a']),
      },
    ],
    more: false,
    omitted: false,
  });
});

test('recent rows say when a limit ended the scan, so that the rows are the same whatever earlier history there is; rowsOf keeps its own result', () => {
  const turn = (n: number, text = (i: number) => `r${i}`) => [
    { id: 't', items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, type: 'agentMessage', text: text(i) })) },
  ];
  const few = recentRowsOf(turn(5), {});
  assert.deepEqual([few.rows.length, few.clipped, few.limited], [5, false, false]);
  const many = recentRowsOf(turn(MAX_ROWS + 30), {});
  assert.deepEqual([many.rows.length, many.clipped, many.limited], [MAX_ROWS, true, true], 'too many blocks');
  // long rows reach the character limit with only a few of them
  const long = recentRowsOf(
    turn(40, () => 'x'.repeat(19_000)),
    {},
  );
  assert.ok(long.rows.length < 40 && long.rows.length * 19_000 <= MAX_TOTAL, `${long.rows.length} long rows`);
  assert.deepEqual([long.clipped, long.limited], [true, true]);
  assert.deepEqual(Object.keys(rowsOf(turn(5))).sort(), ['clipped', 'rows'], 'rowsOf has no new field');
  assert.deepEqual(rowsOf(turn(MAX_ROWS + 30)), { rows: many.rows, clipped: true });
  // steps over their own limit are skipped, which is clipped but not a limit that ended the scan
  const steps = Array.from({ length: 2100 }, (_, i) => ({
    id: `s${i}`,
    type: 'commandExecution',
    command: `c${i}`,
    status: 'completed',
    aggregatedOutput: '',
  }));
  const skipped = recentRowsOf([{ id: 's', items: [{ id: 'm', type: 'agentMessage', text: 'first' }, ...steps] }], {});
  assert.deepEqual([skipped.clipped, skipped.limited], [true, false]);
});
