// The request ledger's cost readiness (shared/costSummary.mjs, electron/ledger/{line,rollup,store}.cjs and the taps): each line says
// which request it is and how it is paid for, usage sums by day, harness, model and payment at list price, and a day's usage is
// folded into the rollup before its raw file is deleted, so cost history outlives the raw retention without counting a day twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { countsUsage, isUsageRow, lineUsd, mergeRows, modelOfLine, pricedRows, usageRows } from '../shared/costSummary.mjs';

const require = createRequire(import.meta.url);
const { ledgerLine } = require('../electron/ledger/line.cjs');
const { RequestLedger, dayOf } = require('../electron/ledger/store.cjs');
const { LedgerRollup, RollupUnreadable } = require('../electron/ledger/rollup.cjs');
const { CodexLedgerTap } = require('../electron/ledger/codexTap.cjs');
const { ClaudeLedgerTap } = require('../electron/ledger/claudeTap.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cost-'));
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const DAY = 86_400_000;
const M = 1_000_000;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const d = console.debug;
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.debug = d;
  }
};
const line = (o: any) => ({ v: 1, t: '2026-10-17T10:00:00.000Z', harness: 'claude', outcome: 'ok', ...o });
const write = (dir: string, day: string, lines: any[]) =>
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));

test('a line keeps its request key and how it is paid for; anything else in those fields is dropped', () => {
  const at = (r: any) => JSON.parse(ledgerLine({ harness: 'claude', outcome: 'ok', ...r }, T0));
  assert.equal(at({ key: 'msg_1' }).key, 'msg_1');
  for (const pay of ['plan', 'key', 'gateway', 'cloud', 'unknown']) assert.equal(at({ pay }).pay, pay);
  for (const pay of ['free', '', 3, null, '__proto__']) assert.equal('pay' in at({ pay }), false, String(pay));
  assert.equal('key' in at({ key: 'x'.repeat(201) }), false);
  // the account's own billing mark is written as the line's `pay`, never inside the account
  assert.deepEqual(at({ account: { id: 'a', pay: 'plan' }, pay: 'plan' }).account, { id: 'a' });
});

test('Codex names each request by its thread and running total, and says how its login pays', () => {
  const out: any[] = [];
  const tap = new CodexLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (id: string) => `chat-of-${id}`,
    accountOf: () => ({ id: 'k', email: null, verified: true, pay: 'key' }),
  });
  tap.message({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'tu' } } });
  const update = (total: number) => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'th', turnId: 'tu', tokenUsage: { last: { inputTokens: 10, outputTokens: 2 }, total: { totalTokens: total } } },
  });
  tap.message(update(12));
  tap.message(update(40));
  assert.deepEqual(
    out.map((r) => [r.key, r.pay]),
    [
      ['th:12', 'key'],
      ['th:40', 'key'],
    ],
  );
});

test('Claude names each request by its message id and pays as its account bills', () => {
  const out: any[] = [];
  const tap = new ClaudeLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (key: string) => `chat-of-${key}`,
    accountOf: () => ({ id: 'apiKey', pay: 'key' }),
  });
  const send = (msg: any) => tap.event({ key: 'claude:s1', kind: 'message', msg, login: false });
  send({ type: 'assistant', message: { id: 'msg_a', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 1 } } });
  send({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(
    out.map((r) => [r.key, r.pay, r.served]),
    [['msg_a', 'key', 'claude-opus-4-8']],
  );
});

test('usage sums by day, harness, model and payment; only requests that reported tokens count', () => {
  const lines = [
    line({ served: 'claude-opus-4-8', req: 'opus', pay: 'plan', in: 10, out: 5, cacheRead: 100, cacheWrite: 7 }),
    line({ served: 'claude-opus-4-8', pay: 'plan', in: 1, out: 1 }),
    line({ harness: 'codex', req: 'gpt-5.5', in: 4 }), // Codex names the model that answered only when it reroutes
    line({ served: 'claude-opus-4-8', pay: 'key', in: 2 }),
    line({ outcome: 'error', served: 'claude-opus-4-8' }), // no usage
    line({ kind: 'computerAccess', device: 'phone', tool: 'click', in: 99 }),
    { v: 1, t: '2026-10-17T10:00:00.000Z', capped: true },
    line({ in: -5, out: Number.NaN }),
    null,
    line({ harness: 3, in: 1 }),
  ];
  assert.deepEqual(usageRows(lines, '2026-10-17'), [
    {
      day: '2026-10-17',
      harness: 'claude',
      model: 'claude-opus-4-8',
      pay: 'plan',
      requests: 2,
      in: 11,
      out: 6,
      cacheRead: 100,
      cacheWrite: 7,
    },
    { day: '2026-10-17', harness: 'codex', model: 'gpt-5.5', pay: 'unknown', requests: 1, in: 4, out: 0, cacheRead: 0, cacheWrite: 0 },
    { day: '2026-10-17', harness: 'claude', model: 'claude-opus-4-8', pay: 'key', requests: 1, in: 2, out: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.equal(usageRows([line({ in: 1 })], (l: any) => l.t.slice(0, 7))[0].day, '2026-10');
  assert.equal(modelOfLine(line({ served: '', req: 'r' })), 'r');
  assert.equal(modelOfLine(line({})), null);
  assert.equal(countsUsage(line({ out: 1 })), true);
});

test('rows of the same day, harness, model and payment merge; model ids with delimiters stay apart', () => {
  const r = (o: any) => ({
    day: 'd',
    harness: 'h',
    model: 'm',
    pay: 'plan',
    requests: 1,
    in: 1,
    out: 1,
    cacheRead: 0,
    cacheWrite: 0,
    ...o,
  });
  const merged = mergeRows([r({}), r({ in: 4 }), r({ model: 'm","plan' }), r({ model: null })]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], r({ requests: 2, in: 5, out: 2 }));
  assert.equal(isUsageRow(r({})), true);
  for (const bad of [null, [], r({ day: 1 }), r({ model: 3 }), r({ in: -1 }), r({ out: Number.POSITIVE_INFINITY }), r({ pay: undefined })])
    assert.equal(isUsageRow(bad), false, JSON.stringify(bad));
});

test('a row and a line are priced at list price; a model with no list price is unpriced, never free', () => {
  const [opus, unknown] = pricedRows([
    { day: 'd', harness: 'claude', model: 'claude-opus-4-8', pay: 'plan', requests: 1, in: M, out: M, cacheRead: M, cacheWrite: M },
    { day: 'd', harness: 'gemini', model: 'house-model', pay: 'unknown', requests: 1, in: M, out: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.equal(opus.usd, 5 + 25 + 0.5 + 6.25);
  assert.equal(unknown.usd, null);
  assert.equal(pricedRows([unknown], { 'house-model': { input: 2, output: 2 } })[0].usd, 2, 'an owner price applies');
  assert.equal(lineUsd(line({ served: 'gpt-5.5', in: M })), 5);
  assert.equal(lineUsd(line({ served: 'gpt-5.5' })), null, 'no usage, no cost');
  assert.equal(lineUsd(line({ served: 'nobody', in: M })), null);
});

test('the summary reads raw days where they are kept and the rollup before them, within the range asked', async () => {
  const dir = tmp();
  const today = dayOf(T0);
  const yesterday = dayOf(T0 - DAY);
  write(dir, today, [line({ served: 'claude-opus-4-8', pay: 'plan', in: M })]);
  write(dir, yesterday, [line({ served: 'gpt-5.5', harness: 'codex', pay: 'key', out: M })]);
  const old = {
    day: '2026-01-02',
    harness: 'codex',
    model: 'gpt-5.5',
    pay: 'key',
    requests: 3,
    in: M,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  // a day the rollup holds and a raw file still has is read once, from the raw file
  const stale = { ...old, day: yesterday, requests: 9, in: 9 * M };
  fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: { '2026-01-02': [old], [yesterday]: [stale] } }));
  const l = new RequestLedger({ dir, now: () => T0, flushMs: 10_000 });
  l.record({ harness: 'claude', outcome: 'ok', served: 'claude-opus-4-8', pay: 'plan', in: M });
  const all = await l.summary();
  assert.equal(all.rollup, 'ok');
  assert.deepEqual(
    all.rows.map((r: any) => [r.day, r.harness, r.requests, r.usd]),
    [
      [today, 'claude', 2, 10],
      [yesterday, 'codex', 1, 30],
      ['2026-01-02', 'codex', 3, 5],
    ],
  );
  const recent = await l.summary({ from: yesterday, to: yesterday });
  assert.deepEqual(
    recent.rows.map((r: any) => r.day),
    [yesterday],
  );
  // a past day's rows are kept while its file is unchanged, and read again when it changes
  write(dir, yesterday, [line({ served: 'gpt-5.5', harness: 'codex', pay: 'key', out: 2 * M })]);
  assert.equal((await l.summary({ from: yesterday, to: yesterday })).rows[0].usd, 60);
});

test('an unreadable rollup is reported, not read as empty, and the raw days still count', async () => {
  const dir = tmp();
  write(dir, dayOf(T0), [line({ served: 'gpt-5.5', in: M })]);
  for (const text of [
    '{not json',
    JSON.stringify({ v: 2, days: {} }),
    JSON.stringify({ v: 1, days: { x: [] } }),
    JSON.stringify({ v: 1, days: { '2026-01-01': [{}] } }),
  ]) {
    fs.writeFileSync(path.join(dir, 'days.json'), text);
    const l = new RequestLedger({ dir, now: () => T0 });
    clearIgnored();
    const s: any = await quiet(() => l.summary());
    assert.equal(s.rollup, 'unreadable', text);
    assert.equal(s.rows.length, 1);
    assert.ok(recentIgnored().some((e: any) => /rollup/.test(e.context)));
  }
  await assert.rejects(new LedgerRollup({ dir: () => dir, oldest: () => '0000-00-00' }).read(), RollupUnreadable);
  // a rollup that cannot be opened (a folder in its place) is unreadable too
  const odd = tmp();
  fs.mkdirSync(path.join(odd, 'days.json'));
  await assert.rejects(new LedgerRollup({ dir: () => odd, oldest: () => '0000-00-00' }).read(), RollupUnreadable);
});

test('a day past the retention is folded into the rollup, then its raw file is deleted; folding again replaces it', async () => {
  const dir = tmp();
  const old = dayOf(T0 - 40 * DAY);
  write(dir, old, [
    line({ served: 'claude-opus-4-8', pay: 'plan', in: M }),
    '{"cut',
    line({ served: 'claude-opus-4-8', pay: 'plan', in: M }),
  ]);
  const ancient = dayOf(T0 - 500 * DAY);
  fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: { [ancient]: [] } }));
  const l = new RequestLedger({ dir, now: () => T0, keepDays: 30, rollupDays: 400, flushMs: 10_000 });
  l.record({ harness: 'claude', outcome: 'ok' });
  await quiet(() => l.flush());
  assert.equal(fs.existsSync(path.join(dir, `${old}.jsonl`)), false);
  const rolled = JSON.parse(fs.readFileSync(path.join(dir, 'days.json'), 'utf8'));
  assert.deepEqual(Object.keys(rolled.days), [old], 'days past the rollup’s own retention are dropped');
  assert.equal(rolled.days[old][0].requests, 2);
  assert.equal((await l.summary()).rows.find((r: any) => r.day === old)?.usd, 10);
  // folding the same day again (a crash between the fold and the delete) replaces it rather than adding it twice
  const rollup = new LedgerRollup({ dir: () => dir, oldest: () => '0000-00-00' });
  await rollup.fold({ [old]: rolled.days[old] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'days.json'), 'utf8')).days[old][0].requests, 2);
});

test('a rollup that cannot be opened or written keeps every old raw file; an old file that cannot be read is kept', async () => {
  const old = dayOf(T0 - 40 * DAY);
  // a rollup the read cannot open (not its content): nothing is deleted, nothing written over
  const dir = tmp();
  write(dir, old, [line({ in: 1 })]);
  fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: {} }));
  const denied = {
    ...fs.promises,
    readFile: async (p: string, enc: any) => {
      if (p.endsWith('days.json')) throw Object.assign(new Error('too many files'), { code: 'EMFILE' });
      return fs.promises.readFile(p, enc);
    },
  };
  const l = new RequestLedger({ dir, now: () => T0, keepDays: 30, fsp: denied, flushMs: 10_000 });
  l.record({ harness: 'claude', outcome: 'ok' });
  await quiet(() => l.flush());
  assert.equal(fs.existsSync(path.join(dir, `${old}.jsonl`)), true);
  assert.equal(fs.readFileSync(path.join(dir, 'days.json'), 'utf8'), JSON.stringify({ v: 1, days: {} }));
  // a write that fails: nothing is deleted
  const dir2 = tmp();
  write(dir2, old, [line({ in: 1 })]);
  const failing = new RequestLedger({ dir: dir2, now: () => T0, keepDays: 30, flushMs: 10_000 });
  failing.rollup.write = async () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  failing.record({ harness: 'claude', outcome: 'ok' });
  await quiet(() => failing.flush());
  assert.equal(fs.existsSync(path.join(dir2, `${old}.jsonl`)), true);
  // one old file that cannot be read stays; the readable one is folded and deleted; one gone meanwhile is skipped
  const dir3 = tmp();
  const older = dayOf(T0 - 41 * DAY);
  const gone = dayOf(T0 - 42 * DAY);
  write(dir3, old, [line({ in: 1 })]);
  write(dir3, older, [line({ in: 1 })]);
  write(dir3, gone, [line({ in: 1 })]);
  const fsp = {
    ...fs.promises,
    readFile: async (p: string, enc: any) => {
      if (p.endsWith(`${older}.jsonl`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (p.endsWith(`${gone}.jsonl`)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return fs.promises.readFile(p, enc);
    },
  };
  const partial = new RequestLedger({ dir: dir3, now: () => T0, keepDays: 30, fsp, flushMs: 10_000 });
  partial.record({ harness: 'claude', outcome: 'ok' });
  await quiet(() => partial.flush());
  assert.equal(fs.existsSync(path.join(dir3, `${old}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(dir3, `${older}.jsonl`)), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir3, 'days.json'), 'utf8')).days), [old]);
  assert.equal(fs.statSync(path.join(dir3, 'days.json')).mode & 0o777, 0o600, 'a new rollup is owner-only');
});

test('folds run one at a time in the order asked, so a later fold never loses an earlier one', async () => {
  const dir = tmp();
  const rollup = new LedgerRollup({ dir: () => dir, oldest: () => '0000-00-00' });
  const row = (day: string) => ({
    day,
    harness: 'h',
    model: null,
    pay: 'unknown',
    requests: 1,
    in: 1,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  await Promise.all([rollup.fold({ '2026-01-01': [row('2026-01-01')] }), rollup.fold({ '2026-01-02': [row('2026-01-02')] })]);
  assert.deepEqual(Object.keys(await rollup.read()), ['2026-01-01', '2026-01-02']);
  // a fold that fails does not stop the next one
  const real = rollup.write;
  rollup.write = async () => {
    throw new Error('once');
  };
  await assert.rejects(rollup.fold({ '2026-01-03': [] }));
  rollup.write = real;
  await rollup.fold({ '2026-01-04': [] });
  assert.deepEqual(Object.keys(await rollup.read()), ['2026-01-01', '2026-01-02', '2026-01-04']);
});

test('a window asks for the summary over IPC with a range of day stems; anything else in it is dropped', async () => {
  const { register, rangeOf } = require('../electron/app/ipc/ledger.cjs');
  assert.deepEqual(rangeOf({ from: '2026-10-01', to: '2026-10-17', extra: 1 }), { from: '2026-10-01', to: '2026-10-17' });
  for (const bad of [null, 'x', [], { from: '2026-1-1', to: 7 }, { from: '../x' }])
    assert.deepEqual(rangeOf(bad), { from: undefined, to: undefined }, JSON.stringify(bad));
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (ch: string, fn: any) => handlers.set(ch, fn) };
  const asked: any[] = [];
  let ledger: any = { store: { summary: async (r: any) => (asked.push(r), { rows: [{ day: 'd' }], rollup: 'ok' }) } };
  register(ipcMain, { shell: { openPath: async () => '' } }, () => ledger);
  assert.deepEqual(await handlers.get('ledger:summary')!({}, { from: '2026-10-01', to: 'later' }), { rows: [{ day: 'd' }], rollup: 'ok' });
  assert.deepEqual(asked, [{ from: '2026-10-01', to: undefined }]);
  ledger = null;
  assert.deepEqual(await handlers.get('ledger:summary')!({}, {}), { rows: [], rollup: 'ok' }, 'before the ledger starts');
});

test('a rollup whose content cannot be read is set aside whole and a new one started, so the retention keeps running', async () => {
  const dir = tmp();
  const old = dayOf(T0 - 40 * DAY);
  write(dir, old, [line({ served: 'gpt-5.5', in: M })]);
  fs.writeFileSync(path.join(dir, 'days.json'), '{broken');
  const l = new RequestLedger({ dir, now: () => T0, keepDays: 30, flushMs: 10_000 });
  l.record({ harness: 'claude', outcome: 'ok' });
  await quiet(() => l.flush());
  const aside = fs.readdirSync(dir).filter((n) => n.startsWith('days.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{broken', 'the old history is kept as it was');
  assert.equal(fs.existsSync(path.join(dir, `${old}.jsonl`)), false, 'the raw day is folded and deleted');
  const s = await l.summary();
  assert.equal(s.rows.find((r: any) => r.day === old)?.usd, 5);
  assert.equal(s.rollup, 'unreadable', 'the set-aside history is missing, and the summary says so');
});

test('a raw day that cannot be read is named as unread, never counted as no usage, and read again next time', async () => {
  const dir = tmp();
  const yesterday = dayOf(T0 - DAY);
  write(dir, yesterday, [line({ served: 'gpt-5.5', in: M })]);
  let fail = true;
  const fsp = {
    ...fs.promises,
    readFile: async (p: string, enc: any) => {
      if (fail && p.endsWith(`${yesterday}.jsonl`)) throw Object.assign(new Error('too many files'), { code: 'EMFILE' });
      return fs.promises.readFile(p, enc);
    },
  };
  // a rolled-up copy of the same day must not stand in for it either
  fs.writeFileSync(
    path.join(dir, 'days.json'),
    JSON.stringify({
      v: 1,
      days: {
        [yesterday]: [
          { day: yesterday, harness: 'x', model: null, pay: 'unknown', requests: 9, in: 9, out: 0, cacheRead: 0, cacheWrite: 0 },
        ],
      },
    }),
  );
  const l = new RequestLedger({ dir, now: () => T0, fsp });
  const first: any = await quiet(() => l.summary());
  assert.deepEqual(first.unread, [yesterday]);
  assert.deepEqual(first.rows, []);
  fail = false;
  const second = await l.summary();
  assert.deepEqual(second.unread, []);
  assert.equal(second.rows[0].usd, 5);
  // a file listed and then deleted by a prune meanwhile is read from the rollup
  const gone = {
    ...fs.promises,
    stat: async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    },
  };
  const racing = new RequestLedger({ dir, now: () => T0, fsp: gone });
  const raced = await racing.summary();
  assert.deepEqual(raced.unread, []);
  assert.equal(raced.rows[0].requests, 9);
  const vanished = {
    ...fs.promises,
    readFile: async (p: string, enc: any) =>
      p.endsWith('.jsonl') ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : fs.promises.readFile(p, enc),
  };
  assert.equal((await new RequestLedger({ dir, now: () => T0, fsp: vanished }).summary()).rows[0].requests, 9);
  const statFails = {
    ...fs.promises,
    stat: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  assert.deepEqual(((await quiet(() => new RequestLedger({ dir, now: () => T0, fsp: statFails }).summary())) as any).unread, [yesterday]);
});

test('a Codex thread on another model provider than Codex’s own is no plan login’s, whatever login is held', () => {
  const out: any[] = [];
  const tap = new CodexLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (id: string) => id,
    accountOf: () => ({ id: 'p', email: 'me@example.com', verified: true, pay: 'plan' }),
  });
  const run = (thread: string, provider?: string) => {
    if (provider) tap.message({ method: 'thread/started', params: { thread: { id: thread, modelProvider: provider } } });
    tap.message({ method: 'turn/started', params: { threadId: thread, turn: { id: `${thread}-t` } } });
    tap.message({
      method: 'thread/tokenUsage/updated',
      params: { threadId: thread, turnId: `${thread}-t`, tokenUsage: { last: { inputTokens: 1 }, total: { totalTokens: 1 } } },
    });
  };
  run('own', 'openai');
  run('kept', 'sage_0123456789');
  run('unseen');
  assert.deepEqual(
    out.map((r) => [r.session, r.pay]),
    [
      ['own', 'plan'],
      ['kept', 'unknown'],
      ['unseen', 'plan'],
    ],
  );
  for (let i = 0; i < 300; i++) tap.message({ method: 'thread/started', params: { thread: { id: `t${i}`, modelProvider: 'x' } } });
  assert.ok(tap.providers.size <= 256, 'the providers kept are bounded');
  tap.message({ method: 'thread/started', params: { thread: { id: 'odd' } } });
  assert.equal(tap.providers.has('odd'), false);
});

test('Claude pays as its process was started to pay, and a Console login is paid per use', () => {
  const { claudeLedgerAccount } = require('../electron/ledger/accounts.cjs');
  const { billingKind } = require('../electron/harness/claude/auth.cjs');
  assert.equal(billingKind('subscription'), 'subscription');
  assert.equal(billingKind('cloud:CLAUDE_CODE_USE_BEDROCK'), 'cloud');
  assert.equal(billingKind('mopilot:gk'), 'mopilot');
  assert.equal(billingKind('["apiKey","https://x","sk-secret"]'), 'apiKey', 'the kind, never the key');
  assert.equal(billingKind(undefined), 'unknown');
  // the setting changed to a subscription while a busy process still runs on its key
  const started: Record<string, string> = { 'claude:k': 'apiKey', 'claude:m': 'mopilot', 'claude:c': 'cloud', 'claude:x': 'constructor' };
  const o = { view: () => null, authMode: () => 'subscription', cloud: () => null, billingOf: (key: string) => started[key] ?? 'unknown' };
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:k', login: false }, o), { id: 'apiKey', pay: 'key' });
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:m', login: false }, o), { id: 'mopilot', pay: 'gateway' });
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:c', login: false }, o), { id: 'cloud', pay: 'cloud' });
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:x', login: false }, o), { id: 'subscription', pay: 'unknown' });
  assert.deepEqual(claudeLedgerAccount({ login: false }, o), { id: 'subscription', pay: 'unknown' }, 'no key: the setting as it is');
  const view = () => ({
    accounts: [
      { id: 'default', email: 'a@example.com', isDefault: true, identity: 'verified', authMethod: 'console_api_key' },
      { id: 'b1', email: 'b@example.com', isDefault: false, identity: null, authMethod: 'claude.ai' },
    ],
  });
  const loginPay = (m: string | null | undefined) => (/api.?key|console/i.test(m ?? '') ? 'key' : 'plan');
  assert.equal(claudeLedgerAccount({ login: true, account: 'default' }, { ...o, view, loginPay }).pay, 'key');
  assert.equal(claudeLedgerAccount({ login: true, account: 'b1' }, { ...o, view, loginPay }).pay, 'plan');
  assert.equal(claudeLedgerAccount({ login: true, account: 'gone' }, { ...o, view, loginPay }).pay, 'unknown', 'a login not yet read');
});

test('the rollup is written owner-only and flushed to disk with its folder; a flush that fails fails the write', async () => {
  const { writeDurable } = require('../electron/ledger/rollup.cjs');
  const { canSyncFolder } = require('../electron/platform/folderSync.cjs');
  const { fs: portFs } = require('../electron/platform/ports/fs.cjs');
  const dir = tmp();
  const file = path.join(dir, 'days.json');
  const opened: string[] = [];
  const realOpen = portFs.promises.open;
  let refuseFolder = false;
  portFs.promises.open = async (p: string, flags: any, mode?: any) => {
    opened.push(`${p === dir ? 'dir' : path.basename(p)}:${flags}`);
    if (p === dir && refuseFolder) throw Object.assign(new Error('no folder handles here'), { code: 'EIO' });
    return realOpen.call(portFs.promises, p, flags, mode);
  };
  try {
    await writeDurable(file, '{"v":1,"days":{}}\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1,"days":{}}\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // Windows journals the rename itself and has no folder to flush (platform/folderSync.cjs)
    assert.deepEqual(opened, canSyncFolder() ? ['days.json:r', 'dir:r'] : ['days.json:r'], 'the file, then its folder');
    refuseFolder = true;
    if (canSyncFolder()) await assert.rejects(writeDurable(file, '{"v":1,"days":{}}\n'), /no folder handles/);
  } finally {
    portFs.promises.open = realOpen;
  }
});
