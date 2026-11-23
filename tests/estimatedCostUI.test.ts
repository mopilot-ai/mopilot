// Settings → Accounts & billing → Estimated cost (src/components/pages/settings/EstimatedCost.tsx, src/lib/costView.ts) and the
// request log's cost column (src/lib/requestLog.ts costText): the range's total at list price, plan chats said to be included,
// requests with no list price counted apart, history that could not be read said so, and only the newest read landing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  flush,
  act,
  setValue,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { EstimatedCost, harnessLabel } = await import('../src/components/pages/settings/EstimatedCost.tsx');
const cv = await import('../src/lib/costView.ts');
const { costText } = await import('../src/lib/requestLog.ts');

const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();
const now = () => NOW;
const row = (o: any) => ({
  day: '2026-11-22',
  harness: 'claude',
  model: 'claude-opus-4-8',
  pay: 'plan',
  requests: 1,
  in: 1000,
  out: 100,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 1,
  ...o,
});
const summary = (rows: any[], o: any = {}) => ({ rows, rollup: 'ok', unread: [], ...o });
const reads = () => calls.filter((c) => c[0] === 'ledger.summary').map((c) => c[1]);

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  responses['ledger.summary'] = summary([
    row({ requests: 3, usd: 4.5 }),
    row({ harness: 'codex', model: 'gpt-5.5', pay: 'key', day: '2026-11-20', usd: 2 }),
    row({ harness: 'gemini', model: 'gemini-3-pro', pay: 'unknown', usd: null, requests: 2 }),
  ]);
});

test('the total is at list price, with plan chats said to be included and unpriced requests counted apart', async () => {
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  assert.deepEqual(reads(), [{ from: '2026-10-24', to: '2026-11-22' }], 'the last 30 days by default');
  assert.equal(
    text(host.querySelector('[data-testid=estimated-cost-total]')),
    'About $6.50 for 4 priced requests, $4.50 of it in chats on a plan.',
  );
  assert.match(text(host), /Left out: 2 requests to a model with no known list price\./);
  const rows = [...host.querySelectorAll('[data-testid=estimated-cost-row]')].map((r) =>
    [...r.querySelectorAll('td')].map((td) => text(td)),
  );
  assert.deepEqual(rows.slice(0, 3), [
    ['Claude Code', '3', '1.1k', '$4.50'],
    ['Codex', '1', '1.1k', '$2.00'],
    ['Gemini', '2', '1.1k', 'No list price'],
  ]);
  assert.equal(host.querySelectorAll('.estimated-cost-day').length, 30);
  assert.equal(
    host.querySelector('.estimated-cost-day:last-child')?.getAttribute('aria-label'),
    '2026-11-22: $4.50',
    'each bar says its day',
  );
  await unmount();
});

test('a range is asked for when picked, and only the newest answer lands', async () => {
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  let release: (v: any) => void = () => {};
  responses['ledger.summary'] = () => new Promise((r) => (release = r));
  await setValue(host.querySelector('select[aria-label=Range]') as HTMLSelectElement, '7', 'change');
  const slow = release;
  responses['ledger.summary'] = summary([row({ usd: 9 })]);
  await click(button(host, 'Refresh'));
  await flush();
  slow(summary([row({ usd: 100 })]));
  await flush();
  assert.match(text(host.querySelector('[data-testid=estimated-cost-total]')), /About \$9\.00/);
  assert.deepEqual(reads().slice(-2), [
    { from: '2026-11-16', to: '2026-11-22' },
    { from: '2026-11-16', to: '2026-11-22' },
  ]);
  assert.equal(host.querySelectorAll('.estimated-cost-day').length, 7);
  await setValue(host.querySelector('select[aria-label=Range]') as HTMLSelectElement, 'all', 'change');
  await flush();
  assert.deepEqual(reads().at(-1), { to: '2026-11-22' });
  assert.equal(host.querySelectorAll('.estimated-cost-day').length, 0, 'no bars for all recorded');
  await unmount();
});

test('a failed read, an empty range, unread history and the request log being off are each said', async () => {
  responses['ledger.summary'] = () => Promise.reject(new Error('denied'));
  const failed = await render(h(EstimatedCost, { now }));
  await flush();
  assert.equal(text(failed.host.querySelector('[role=alert]')), "Couldn't read the request log: Denied.");
  let reject: (e: any) => void = () => {};
  responses['ledger.summary'] = () => new Promise((_r, j) => (reject = j));
  await click(button(failed.host, 'Refresh'));
  const late = reject;
  responses['ledger.summary'] = summary([]);
  await click(button(failed.host, 'Refresh'));
  await flush();
  late(new Error('too late'));
  await flush();
  assert.equal(failed.host.querySelector('[role=alert]'), null, 'an older failure does not replace the newer answer');
  assert.ok(failed.host.querySelector('[data-testid=estimated-cost-empty]'));
  await failed.unmount();
  for (const s of [summary([row({})], { rollup: 'unreadable' }), summary([row({})], { unread: ['2026-11-01'] })]) {
    responses['ledger.summary'] = s;
    const r = await render(h(EstimatedCost, { now }));
    await flush();
    assert.match(text(r.host.querySelector('[role=status]')), /may be low/);
    await r.unmount();
  }
  useStore.setState({ prefs: { ...useStore.getState().prefs, requestLog: false } });
  responses['ledger.summary'] = summary([row({ requests: 1, usd: 0.001 })]);
  const off = await render(h(EstimatedCost, { now }));
  await flush();
  assert.match(text(off.host), /The request log is off/);
  assert.equal(
    text(off.host.querySelector('[data-testid=estimated-cost-total]')),
    'About <$0.01 for 1 priced request, <$0.01 of it in chats on a plan.',
  );
  await off.unmount();
});

test('the view helpers: day stems, ranges, dollars, labels, totals and bars', () => {
  assert.equal(cv.dayStem(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  assert.deepEqual(cv.rangeDays('7', new Date(2026, 2, 3).getTime()), { from: '2026-02-25', to: '2026-03-03' }, 'across a month end');
  assert.equal(cv.usdText(0), '$0.00');
  assert.equal(cv.usdText(0.004), '<$0.01');
  assert.equal(cv.usdText(12.345), '$12.35');
  assert.equal(harnessLabel('codex'), 'Codex');
  assert.equal(harnessLabel('no-such-agent'), 'no-such-agent');
  assert.equal(cv.totalsBy([row({})], 'harness')[0].label, 'claude', 'named by id without a registry');
  const totals = cv.totalsBy([row({ model: null, usd: null }), row({ model: 'b', usd: 1 }), row({ model: 'a', usd: 1 })], 'model');
  assert.deepEqual(
    totals.map((t) => [t.label, t.usd, t.unpriced]),
    [
      ['a', 1, 0],
      ['b', 1, 0],
      ['Unknown model', 0, 1],
    ],
  );
  const bars = cv.dayBars([row({ day: '2026-11-21', usd: 2 }), row({ day: '2026-11-22', usd: 1 }), row({ usd: null })], '7', NOW);
  assert.equal(bars.length, 7);
  assert.deepEqual(bars.slice(-2), [
    { day: '2026-11-21', usd: 2, share: 1 },
    { day: '2026-11-22', usd: 1, share: 0.5 },
  ]);
  assert.ok(cv.dayBars([], '30', NOW).every((b) => b.share === 0));
  assert.deepEqual(cv.overviewOf({ rows: [], rollup: 'ok' } as any), { usd: 0, requests: 0, unpriced: 0, planUsd: 0, incomplete: false });
});

test('a request log line shows its cost at list price, a dash with no usage, and says when its model has no price', () => {
  const l = (o: any) => ({ v: 1, t: '2026-11-22T10:00:00Z', harness: 'codex', outcome: 'ok', ...o });
  assert.equal(costText(l({ served: 'gpt-5.5', in: 1_000_000 })), '$5.00');
  assert.equal(costText(l({ served: 'gpt-5.5', in: 1000 })), '$0.0050');
  assert.equal(costText(l({ served: 'gpt-5.5', in: 1 })), '<$0.0001');
  assert.equal(costText(l({ served: 'gpt-5.5' })), '—');
  assert.equal(costText(l({ served: 'house', in: 10 })), 'No price');
});

test('searching Settings for cost, spend or price finds Accounts & billing', async () => {
  const { searchSettings } = await import('../src/lib/settingsSearch.ts');
  const items = [{ id: 'accounts', label: 'Accounts & billing', group: 'Account' }];
  for (const q of ['cost', 'spend', 'price']) assert.equal(searchSettings(items, q)[0]?.item.id, 'accounts', q);
});

test('a range picked while its answer is on the way shows none of the old range’s numbers', async () => {
  responses['ledger.summary'] = summary([row({ usd: 50, day: '2026-10-25' }), row({ usd: 1 })]);
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  assert.match(text(host.querySelector('[data-testid=estimated-cost-total]')), /About \$51\.00/);
  let release: (v: any) => void = () => {};
  responses['ledger.summary'] = () => new Promise((r) => (release = r));
  await setValue(host.querySelector('select[aria-label=Range]') as HTMLSelectElement, '7', 'change');
  await flush();
  assert.equal(host.querySelector('[data-testid=estimated-cost-total]'), null, 'the 30-day total is not shown under Last 7 days');
  assert.match(text(host), /Reading the request log/);
  release(summary([row({ usd: 1 })]));
  await flush();
  assert.match(text(host.querySelector('[data-testid=estimated-cost-total]')), /About \$1\.00/);
  await unmount();
});

test('a harness with priced and unpriced requests says both', async () => {
  responses['ledger.summary'] = summary([
    row({ harness: 'opencode', model: 'a', usd: 2 }),
    row({ harness: 'opencode', model: 'b', usd: null }),
  ]);
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  const first = host.querySelector('[data-testid=estimated-cost-row]');
  assert.match(text(first), /\$2\.00 \+ 1 unpriced$/);
  await unmount();
});

test('a table names the eight costliest and counts the rest', async () => {
  responses['ledger.summary'] = summary(Array.from({ length: 10 }, (_, i) => row({ model: `m${i}`, usd: 10 - i })));
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  const byModel = [...host.querySelectorAll('table')].find((t) => text(t.querySelector('caption')) === 'By model')!;
  assert.equal(byModel.querySelectorAll('[data-testid=estimated-cost-row]').length, 8);
  assert.match(text(byModel), /and 2 more$/);
  await unmount();
});

test('Include sessions run outside MoPilot imports them, says what it found, and reads the total again', async () => {
  const { importText } = await import('../src/components/pages/settings/EstimatedCost.tsx');
  let finish = (_: unknown) => {};
  responses['ledger.importOutside'] = () => new Promise((resolve) => (finish = resolve));
  const { host, unmount } = await render(h(EstimatedCost, { now }));
  await flush();
  const before = reads().length;
  await click(button(host, 'Include sessions run outside MoPilot'));
  await flush();
  const busy = button(host, 'Reading Claude Code and Codex sessions…') as HTMLButtonElement;
  assert.equal(busy.disabled, true, 'one import at a time');
  await act(() => finish({ claude: { files: 12, read: 3, failed: 0 }, codex: { files: 40, read: 1, failed: 0 } }));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'ledger.importOutside').length, 1);
  assert.equal(
    text(host.querySelector('[data-testid=estimated-cost-imported]')),
    'Read 3 new or changed Claude Code transcripts of 12 and 1 new or changed Codex session file of 40. Sessions run outside MoPilot are included as of now: press again to add later ones.',
  );
  assert.equal(reads().length, before + 1, 'the total is read again');
  responses['ledger.importOutside'] = () => Promise.reject(new Error('rollup unreadable'));
  await click(button(host, 'Include sessions run outside MoPilot'));
  await flush();
  assert.match(
    text(host.querySelector('[data-testid=estimated-cost-imported]')),
    /^Couldn't read Claude Code's and Codex's own sessions: /,
  );
  await unmount();
  assert.equal(
    importText({ claude: { files: 2, read: 0, failed: 1 }, codex: { files: 3, read: 2, failed: 1 } }),
    "Read 0 new or changed Claude Code transcripts of 2 and 2 new or changed Codex session files of 3. 2 files couldn't be read; any earlier import of them is kept. Sessions run outside MoPilot are included as of now: press again to add later ones.",
  );
  assert.equal(importText({ refused: 'off' }), 'The request log is off (Settings → Privacy), so nothing was imported.');
  assert.equal(importText({ refused: 'not-started' }), 'The request log has not started yet.');
  useStore.setState({ prefs: { ...useStore.getState().prefs, requestLog: false } });
  const off = await render(h(EstimatedCost, { now }));
  await flush();
  assert.equal((button(off.host, 'Include sessions run outside MoPilot') as HTMLButtonElement).disabled, true);
  await off.unmount();
});

test('an import that cannot be read says the total may be low', () => {
  assert.equal(cv.overviewOf({ rows: [], rollup: 'ok', unread: [], imported: 'unreadable' } as any).incomplete, true);
});
