import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUsageRefresher, mergeUsage, parseUsageText, usageFetchState, withoutExtraUsage } from '../src/harness/claudeUsage.ts';
import { defined } from './support/defined.ts';
import { deferred } from './support/async-scenarios.ts';

const { readUsage } = createRequire(import.meta.url)('../electron/harness/claude/usage.cjs');
const text = 'Current session: 12% used · resets 5pm (UTC)\nCurrent week (all models): 34% used · resets Oct 14 at 9am (UTC)';
const success = (text: string) => ({ state: 'success' as const, text });
const failure = (error = 'Network unavailable') => ({ state: 'error' as const, error });

// No store or CLI process is needed to exercise parsing and request ownership; `readings` stands in for the store.
function refresher(read: (account: string, reason: string) => Promise<any>) {
  const events: any[] = [];
  const readings: Record<string, any> = {};
  const refresh = createUsageRefresher({
    read,
    current: (id) => readings[id] ?? null,
    noteReading: (id, reading) => {
      readings[id] = { ...reading, fetchState: 'success' };
      events.push([id, 'success']);
    },
    noteFetch: (id, state, error) => {
      readings[id] = { windows: [], at: 0, ...readings[id], fetchState: state, fetchError: error ?? null };
      events.push([id, state, error]);
    },
  });
  return { refresh, events, readings };
}

test('usage parser retains compact session and weekly readings, reset labels and reset times', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 13, 10) });
  assert.deepEqual(parseUsageText(text)?.windows, [
    { label: '5h', usedPercent: 12, resetsAt: Date.UTC(2026, 9, 13, 17) / 1000, resetsText: '5pm' },
    { label: 'Weekly', usedPercent: 34, resetsAt: Date.UTC(2026, 9, 14, 9) / 1000, resetsText: 'Oct 14 at 9am' },
  ]);
});

test('usage parser accepts colored, indented CRLF headings, bars and decimals', (t) => {
  const output =
    '\x1b[32m  Current session\x1b[0m\r\n  ███░░ 12.5% used\r\n  Resets 5pm (UTC)\r\n\r\n Current week (Sonnet only)\r\n  █░░ 7.25 % used\r\n  Resets tomorrow (UTC)';
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 13, 18) });
  // 5pm had passed when it was printed: the next one; "tomorrow" is not a time the CLI prints
  assert.deepEqual(parseUsageText(output)?.windows, [
    { label: '5h', usedPercent: 12.5, resetsAt: Date.UTC(2026, 9, 14, 17) / 1000, resetsText: '5pm' },
    { label: 'Weekly Sonnet only', usedPercent: 7.25, resetsAt: null, resetsText: 'tomorrow' },
  ]);
});

test('usage parser rejects unknown output and invalid percentages instead of inventing a reading', () => {
  for (const output of [
    '',
    'Login required',
    'Current session: 101% used',
    'Current weekly summary: 8% used',
    'Extra usage: 20% used',
    'Current session: -1% used',
    'Current session: unavailable\nExtra usage: 20% used',
  ]) {
    assert.equal(parseUsageText(output), null);
  }
});

test('a missing session percentage cannot borrow the next week percentage', () => {
  const reading = parseUsageText('Current session: unavailable\nCurrent week: 20% used');
  assert.deepEqual(
    reading?.windows.map((w) => [w.label, w.usedPercent]),
    [['Weekly', 20]],
  );
});

test('a new reading clears a previous fetch error and retains other known windows', () => {
  const prev = { ...parseUsageText(text)!, fetchState: 'error' as const, fetchError: 'Offline' };
  const next = { ...parseUsageText('Current session: 15% used')!, at: prev.at + 1 };
  const merged = mergeUsage(prev, next)!;
  assert.deepEqual(
    merged.windows.map((w) => [w.label, w.usedPercent]),
    [
      ['5h', 15],
      ['Weekly', 34],
    ],
  );
  assert.equal(merged.fetchState, 'success');
  assert.equal(merged.fetchError, null);
  assert.equal(merged.at, next.at);
});

test('an empty live event cannot erase a known reading', () => {
  const prev = parseUsageText(text);
  assert.equal(mergeUsage(prev, { windows: [], at: Date.now() }), prev);
});

test('concurrent refreshes for the same account share one request', async () => {
  const response = deferred<ReturnType<typeof success>>();
  let calls = 0;
  const t = refresher(async () => {
    calls++;
    return response.promise;
  });
  const first = t.refresh('a');
  assert.equal(t.refresh('a'), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  response.resolve(success(text));
  await first;
  assert.deepEqual(
    t.events.map((e) => e.slice(0, 2)),
    [
      ['a', 'loading'],
      ['a', 'success'],
    ],
  );
  await t.refresh('a');
  assert.equal(calls, 2, 'settled requests must permit a manual refresh');
  // a later read keeps showing the last reading instead of going back to "Fetching usage…"
  assert.equal(t.events.filter((e) => e[1] === 'loading').length, 1);
});

test("the user asking waits for a timer's request in flight and then asks itself; a second ask shares the first", async () => {
  const reasons: string[] = [];
  let release!: () => void;
  const t = refresher((_id, reason) => {
    reasons.push(reason);
    return reason === 'background'
      ? new Promise((r) => (release = () => r({ ...success(text), cached: true })))
      : Promise.resolve(success(text));
  });
  const tick = t.refresh('a', 'background');
  await Promise.resolve();
  await Promise.resolve();
  const click = t.refresh('a', 'now');
  assert.equal(t.refresh('a', 'surface'), tick, 'a surface opening shares the tick');
  release();
  await click;
  assert.deepEqual(reasons, ['background', 'now']);
  // two clicks share one request
  const one = t.refresh('a', 'now');
  assert.equal(t.refresh('a', 'now'), one);
  await one;
});

test('each read asks main with its reason, a surface opening when none is given', async () => {
  const reasons: string[] = [];
  const t = refresher(async (_id, reason) => (reasons.push(reason), success(text)));
  await t.refresh('a', 'background');
  await t.refresh('a', 'now');
  await t.refresh('a');
  assert.deepEqual(reasons, ['background', 'now', 'surface']);
});

test("an answer this window already holds (main's last read, for another window or an earlier tick) changes nothing", async () => {
  const measuredAt = Date.now() - 3 * 60_000;
  const t = refresher(async () => ({ ...success(text), measuredAt, cached: true }));
  await t.refresh('a', 'background');
  const held = t.readings.a;
  await t.refresh('a', 'background');
  assert.equal(t.readings.a, held);
  assert.deepEqual(
    t.events.map((e) => e[1]),
    ['loading', 'success'],
  );
});

test('different accounts resolve independently and retain their own readings', async () => {
  const a = deferred<ReturnType<typeof success>>();
  const b = deferred<ReturnType<typeof success>>();
  const t = refresher((id) => (id === 'a' ? a.promise : b.promise));
  const first = t.refresh('a');
  const second = t.refresh('b');
  b.resolve(success('Current session: 70% used'));
  await second;
  assert.equal(t.readings.b.windows[0].usedPercent, 70);
  assert.equal(t.readings.a.fetchState, 'loading');
  a.resolve(success('Current session: 10% used'));
  await first;
  assert.equal(defined(t.readings.a).windows[0].usedPercent, 10);
  assert.equal(t.readings.b.windows[0].usedPercent, 70);
});

test('a failure is reported once without a retry here (main backs the login off) and a later read recovers', async () => {
  let calls = 0;
  const t = refresher(async () => (++calls === 1 ? failure() : success(text)));
  await t.refresh('a');
  assert.equal(calls, 1);
  assert.deepEqual(t.events.at(-1), ['a', 'error', 'Network unavailable']);
  await t.refresh('a');
  assert.equal(t.events.at(-1)[1], 'success');
});

test('IPC failures surface their reason, the same failure answered again changes nothing, and a new one is noted', async () => {
  let calls = 0;
  let message = 'IPC disconnected';
  const t = refresher(async () => {
    calls++;
    throw new Error(message);
  });
  await t.refresh('a');
  assert.deepEqual(t.events.at(-1), ['a', 'error', 'IPC disconnected']);
  const n = t.events.length;
  await t.refresh('a');
  assert.equal(calls, 2);
  assert.equal(t.events.length, n);
  message = 'Rate limited';
  await t.refresh('a');
  assert.deepEqual(t.events.at(-1), ['a', 'error', 'Rate limited']);
});

test('empty or unrecognized output is unavailable without pointless retries', async () => {
  for (const output of ['', 'Unsupported command: /usage']) {
    let calls = 0;
    const t = refresher(async () => {
      calls++;
      return success(output);
    });
    await t.refresh('a');
    assert.equal(calls, 1);
    assert.equal(t.events.at(-1)[1], 'unavailable');
    assert.match(t.events.at(-1)[2], output ? /unrecognized/ : /no usage/);
    assert.deepEqual(t.readings.a.windows, []);
    // answered again, it is not noted again
    const n = t.events.length;
    await t.refresh('a');
    assert.equal(t.events.length, n);
  }
});

function sdkWith(messages: any[], close: () => void, onQuery?: (args: any) => void) {
  return async () => ({
    query: (args: any) => {
      onQuery?.(args);
      const q = (async function* () {
        yield* messages;
      })();
      return Object.assign(q, { close });
    },
  });
}

test('CLI usage queries collect assistant text, preserve it on an empty result and close', async () => {
  let closes = 0;
  const options = { persistSession: false, maxTurns: 1 };
  const sdk = sdkWith(
    [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text },
            { type: 'tool_use', name: 'ignored' },
          ],
        },
      },
      { type: 'result', result: '' },
    ],
    () => closes++,
    (args) => assert.deepEqual(args, { prompt: '/usage', options }),
  );
  assert.equal(await readUsage(sdk, options), text);
  assert.equal(closes, 1);
});

test('CLI error results propagate a diagnostic and close the query', async () => {
  let closes = 0;
  await assert.rejects(
    readUsage(
      sdkWith([{ type: 'result', is_error: true, errors: ['Login expired'] }], () => closes++),
      {},
    ),
    /Login expired/,
  );
  assert.equal(closes, 1);
});

test('a stalled CLI query times out and closes without waiting for its iterator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const sdk = async () => ({
    query: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      close: () => closes++,
    }),
  });
  const read = readUsage(sdk, {});
  const rejected = assert.rejects(read, /Timed out reading Claude Code usage/);
  await Promise.resolve();
  t.mock.timers.tick(20000);
  await rejected;
  assert.equal(closes, 1);
});

test('SDK loading also times out and cannot start a late CLI process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loaded = deferred<any>();
  let queries = 0;
  const read = readUsage(() => loaded.promise, {});
  const rejected = assert.rejects(read, /Timed out/);
  t.mock.timers.tick(20000);
  await rejected;
  loaded.resolve({
    query: () => {
      queries++;
      throw new Error('Must not start');
    },
  });
  await Promise.resolve();
  assert.equal(queries, 0);
});

test('SDK startup rejection preserves the original error', async () => {
  await assert.rejects(
    readUsage(async () => {
      throw new Error('SDK failed to load');
    }, {}),
    /SDK failed to load/,
  );
});

test('fetch failure retains cached windows, status and the last successful timestamp', () => {
  const prev = { ...parseUsageText(text)!, status: 'allowed' };
  const loading = usageFetchState(prev, 'loading');
  const failed = usageFetchState(loading, 'error', 'Timed out');
  assert.equal(failed.windows, prev.windows);
  assert.equal(failed.at, prev.at);
  assert.equal(failed.status, prev.status);
  assert.equal(failed.fetchError, 'Timed out');
  const recovered = mergeUsage(failed, parseUsageText('Current session: 15% used'))!;
  assert.equal(recovered.fetchState, 'success');
  assert.equal(recovered.fetchError, null);
});

test('first fetch failure carries diagnostics without a fabricated successful timestamp', () => {
  const failed = usageFetchState(null, 'unavailable', 'No usage data');
  assert.deepEqual(failed.windows, []);
  assert.equal(failed.at, 0);
  assert.equal(failed.fetchState, 'unavailable');
  assert.equal(failed.fetchError, 'No usage data');
});

// The CLI answers /usage from its cache when its usage endpoint refuses (a 429 it remembers for minutes):
// that answer can predate a chat's live limits and must not overwrite them.
test('an older cached /usage answer does not overwrite newer live limits', () => {
  const now = Date.now();
  const live = {
    windows: [
      { label: '5h', usedPercent: 23, resetsAt: null },
      { label: 'Weekly', usedPercent: 6, resetsAt: null },
    ],
    status: 'allowed',
    at: now,
  };
  const cached = parseUsageText(
    'Current session: 0% used\nCurrent week (all models): 100% used\nCurrent week (Fable): 0% used',
    now - 47 * 60_000,
  );
  const merged = mergeUsage(live, cached)!;
  assert.deepEqual(
    merged.windows.map((w) => [w.label, w.usedPercent]),
    [
      ['5h', 23],
      ['Weekly', 6],
    ],
  );
  assert.equal(merged.at, now);
  assert.equal(merged.status, 'allowed');
  assert.equal(merged.fetchState, 'success');
});

test('an older cached answer cannot add a lifted limit the live reading lacks', () => {
  const now = Date.now();
  // a live event without per-window readings carries only its representative window
  const live = { windows: [{ label: '5h', usedPercent: 23, resetsAt: null }], status: 'allowed', at: now };
  const failed = usageFetchState(live, 'loading');
  const merged = mergeUsage(failed, parseUsageText('Current week (all models): 100% used', now - 47 * 60_000))!;
  assert.deepEqual(merged.windows, live.windows);
  assert.equal(merged.at, now);
  assert.equal(merged.status, 'allowed');
  assert.equal(merged.fetchState, 'success');
});

test('a /usage answer measured after the live limits replaces them', () => {
  const now = Date.now();
  const live = { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: null }], status: 'rejected', at: now - 60_000 };
  const merged = mergeUsage(live, parseUsageText('Current week (all models): 7% used', now))!;
  assert.deepEqual(
    merged.windows.map((w) => w.usedPercent),
    [7],
  );
  assert.equal(merged.at, now);
  assert.equal(merged.status, 'rejected');
});

test('a reading is dated by when the CLI fetched it, or now when the CLI does not say', async () => {
  const measuredAt = Date.now() - 47 * 60_000;
  const dated = refresher(async () => ({ ...success(text), measuredAt }));
  await dated.refresh('a');
  assert.equal(dated.readings.a.at, measuredAt);
  const before = Date.now();
  const undated = refresher(async () => ({ ...success(text), measuredAt: null }));
  await undated.refresh('a');
  assert.ok(undated.readings.a.at >= before);
});

test('a window only an older reading had keeps when it was measured, until a reading measures it again', () => {
  const now = Date.now();
  const cli = { windows: [{ label: 'Weekly Fable', usedPercent: 100, resetsAt: null }], status: null, at: now - 20 * 60_000 };
  const live = { windows: [{ label: '5h', usedPercent: 23, resetsAt: null }], status: 'allowed', at: now };
  const merged = mergeUsage(cli, live)!;
  assert.deepEqual(merged.windows, [
    { label: 'Weekly Fable', usedPercent: 100, resetsAt: null, at: now - 20 * 60_000 },
    { label: '5h', usedPercent: 23, resetsAt: null },
  ]);
  const again = mergeUsage(merged, { windows: [{ label: 'Weekly Fable', usedPercent: 2, resetsAt: null }], at: now + 1 })!;
  assert.deepEqual(again.windows[0], { label: 'Weekly Fable', usedPercent: 2, resetsAt: null });
});

test("an older answer's reset time is taken for the same window, never for one that has started over since", () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const held = { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: null }], status: null, at: now };
  const older = (resetsAt: number) => ({ windows: [{ label: 'Weekly', usedPercent: 100, resetsAt }], status: null, at: now - 60_000 });
  // resets after the held reading measured it: the same week
  assert.equal(mergeUsage(held, older(sec + 3600))!.windows[0].resetsAt, sec + 3600);
  // reset before it: the held 100% is a later week's, whose reset is not this one
  assert.equal(mergeUsage(held, older(sec - 30))!.windows[0].resetsAt, null);
  // a window that already knows its reset keeps it
  const known = { ...held, windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: sec + 60 }] };
  assert.equal(mergeUsage(known, older(sec + 3600))!.windows[0].resetsAt, sec + 60);
});

test('a reading saved with an extra-usage window loses it, and a merge does not carry it on', () => {
  const plan = { label: 'Weekly', usedPercent: 50, resetsAt: null };
  const saved = { windows: [plan, { label: 'seven_day_overage_included', usedPercent: 2, resetsAt: null }], status: null, at: 10 };
  assert.deepEqual(withoutExtraUsage(saved)!.windows, [plan]);
  assert.equal(withoutExtraUsage(null), null);
  const clean = { windows: [plan], status: null, at: 10 };
  assert.equal(withoutExtraUsage(clean), clean);
  const merged = mergeUsage(saved, { windows: [{ label: '5h', usedPercent: 1, resetsAt: null }], status: null, at: 20 })!;
  assert.deepEqual(
    merged.windows.map((w) => w.label),
    ['Weekly', '5h'],
  );
});
