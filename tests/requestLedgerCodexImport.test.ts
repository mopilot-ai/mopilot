// Importing the usage of Codex sessions run outside MoPilot (electron/ledger/backfill.cjs with the core's rollout.usage): rollouts
// found under CODEX_HOME's sessions and archived_sessions, plain or zstd, each request keyed as the live Codex tap keys it, so a
// request MoPilot recorded is left out by its key while its day is raw and by its session's span once folded; an archived or
// compressed copy counted once; the store saying which harness each file is; and nothing imported counted on a day an older version
// folded without its live sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LedgerImport, codexRequests, recorded, spanKey, liveSpans, addSpans } = require('../electron/ledger/backfill.cjs');
const { RequestLedger, dayOf } = require('../electron/ledger/store.cjs');
const { CodexLedgerTap } = require('../electron/ledger/codexTap.cjs');
const { rolloutFolders } = require('../electron/harness/codexRollout.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-codex-import-'));
const T0 = new Date(2026, 10, 22, 10, 0, 0).getTime();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const none = { keys: new Set<string>(), spans: new Map() };
const ALL = { from: '0000-00-00', to: '9999-99-99', oldest: '0000-00-00' };
const on = () => true;
const total = (rows: any[]) => rows.reduce((n, r) => n + r.requests, 0);
/** These fields added up over rows (the ledger's rows and the import's come apart). */
const sum = (rows: any[], fields: string[]) => fields.map((f) => rows.reduce((n, r) => n + r[f], 0));
/** An import's result: each harness's [files, read, failed]. */
const both = ([files, read, failed = 0]: number[], [cFiles, cRead, cFailed = 0]: number[]) => ({
  claude: { files, read, failed },
  codex: { files: cFiles, read: cRead, failed: cFailed },
});
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const d = console.debug;
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.debug = d;
  }
};
const T = '01a1e659-0000-7000-8000-000000000001';
const U = '01a1e659-0000-7000-8000-000000000002';

/** A rollout's lines: its session_meta, then each [time, thread total, input, cached, output] as a model's token_count. */
function rollout(thread: string, began: number, usage: [number, number, number, number, number][], model = 'gpt-5.5') {
  const lines = [
    { timestamp: iso(began), type: 'session_meta', payload: { id: thread, cwd: '/w' } },
    { timestamp: iso(began), type: 'turn_context', payload: { turn_id: 't', model } },
    ...usage.map(([t, totalTokens, input, cached, output]) => ({
      timestamp: iso(t),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: totalTokens },
          last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, cache_write_input_tokens: 0 },
        },
      },
    })),
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

/**
 * An import's roots: an empty Claude Code folder, and the rollout folders (codexRollout.cjs) of a CODEX_HOME, `home`, holding `files`
 * (relative path → text; a .zst one is compressed).
 */
function homes(files: Record<string, string>) {
  const home = tmp();
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel.endsWith('.zst') ? zlib.zstdCompressSync(text) : text);
  }
  return { claude: path.join(home, 'no-claude'), codex: rolloutFolders(home), home };
}

const day = (ms: number) => {
  const d = new Date(ms);
  return `sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

/** A thread MoPilot ran: the live tap's lines for one request (and its stopped turn's repeat) into the ledger. */
function ranInMoPilot(l: any, thread: string, last: { inputTokens: number; cachedInputTokens: number; outputTokens: number }, sum: number) {
  const tap = new CodexLedgerTap({ record: (r: any) => l.record(r), chatOf: () => 'chat', accountOf: () => null });
  tap.emitted({ kind: 'turnStarted', turnId: 'turn-1', model: 'gpt-5.5' });
  tap.message({ method: 'turn/started', params: { threadId: thread, turn: { id: 'turn-1' } } });
  const update = { method: 'thread/tokenUsage/updated', params: { turnId: 'turn-1', tokenUsage: { last, total: { totalTokens: sum } } } };
  tap.message(update);
  tap.message(update);
}

test('the core reads a rollout’s requests, plain or compressed; a reply this version cannot store fails the file', async () => {
  const fixtures = path.join(import.meta.dirname, 'fixtures', 'core', 'rollout');
  for (const name of ['usage.jsonl', 'usage.jsonl.zst'])
    assert.deepEqual(
      await codexRequests(path.join(fixtures, name)),
      [['th:9', 'th', '2026-11-01T00:00:02.000Z', 'gpt-a', 4, 4, 1, 0]],
      name,
    );
  await assert.rejects(
    codexRequests('x', async () => ({ requests: [] })),
    /not a list of requests/,
  );
  await assert.rejects(
    codexRequests('x', async () => [['id', 's', 'yesterday', null, 1, 0, 0, 0]]),
    /not a list of requests/,
  );
  await assert.rejects(codexRequests(path.join(fixtures, 'missing.jsonl')), /open a rollout/);
});

test('a request MoPilot recorded is left out by the live tap’s own key; one run after it elsewhere counts; a copy counts once', async () => {
  const dir = tmp();
  const l = new RequestLedger({ dir, now: () => T0 });
  l.imports.pause = async () => {};
  // MoPilot ran T's first request; the second ran in the terminal afterwards, U ran there alone and was archived compressed
  ranInMoPilot(l, T, { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 }, 1050);
  await l.flush();
  // the rollout's lines are stamped after the ledger's, past T's span: only the shared <thread>:<total> key leaves the first out
  const t = rollout(T, T0 - 5000, [
    [T0 + 10, 1050, 1000, 400, 50],
    [T0 + 20, 1050, 1000, 400, 50],
    [T0 + 60_000, 2200, 1100, 1000, 50],
  ]);
  const u = rollout(U, T0 - DAY, [[T0 - DAY + 1000, 500, 450, 0, 50]], 'gpt-5.4');
  const roots = homes({
    [`${day(T0)}/rollout-2026-11-22T09-59-55-${T}.jsonl`]: t,
    [`${day(T0 - DAY)}/rollout-2026-11-21T10-00-00-${U}.jsonl`]: u,
    [`archived_sessions/rollout-2026-11-21T10-00-00-${U}.jsonl.zst`]: u,
    [`${day(T0)}/notes.jsonl`]: u,
  });
  assert.deepEqual(await l.importOutside(roots), both([0, 0], [3, 3]));
  const rows = (await l.summary()).rows.filter((r: any) => r.harness === 'codex');
  const by = (model: string) => rows.filter((r: any) => r.model === model);
  assert.deepEqual(
    sum(by('gpt-5.5'), ['requests', 'in', 'cacheRead', 'out']),
    [2, 600 + 100, 400 + 1000, 100],
    'the tap’s request from the ledger, the later one from the import; the stopped turn’s repeat is none',
  );
  assert.equal(total(by('gpt-5.4')), 1, 'U once, though its rollout is in sessions and archived_sessions');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'imported.json'), 'utf8'));
  assert.equal(stored.v, 2);
  assert.deepEqual(new Set(Object.values(stored.files).map((f: any) => f.harness)), new Set(['codex']));
});

test('after the raw days are folded, a Codex session MoPilot ran still owns its requests up to its last, and only Codex’s', async () => {
  const dir = tmp();
  const early = new RequestLedger({ dir, now: () => T0 });
  ranInMoPilot(early, T, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }, 110);
  await early.flush();
  const l = new RequestLedger({ dir, now: () => T0 + 40 * DAY, keepDays: 30, flushMs: 10_000 });
  l.imports.pause = async () => {};
  l.record({ harness: 'claude', outcome: 'ok' });
  await l.flush();
  assert.equal(fs.existsSync(path.join(dir, `${dayOf(T0)}.jsonl`)), false, 'folded and deleted');
  // the rollout's line for MoPilot's request is written just before the ledger's: the session's span still owns it
  const t = rollout(T, T0 - 5000, [
    [T0 - 10, 110, 100, 0, 10],
    [T0 + 60_000, 330, 200, 0, 20],
  ]);
  await l.importOutside(homes({ [`${day(T0)}/rollout-x-${T}.jsonl`]: t }));
  const codex = (await l.summary()).rows.filter((r: any) => r.harness === 'codex');
  assert.deepEqual(sum(codex, ['requests', 'in']), [2, 300], 'the first from the rollup, the second from the import');
  const claudeSpan = { keys: new Set<string>(), spans: new Map([[spanKey('claude', T), { first: iso(T0), last: iso(T0 + DAY) }]]) };
  const r = ['x', T, iso(T0), null, 1, 0, 0, 0];
  assert.equal(recorded(claudeSpan, r, 'codex'), false, 'a Claude Code session of the same id is not this thread');
  assert.equal(recorded(claudeSpan, r), true);
  // the Codex ACP adapter's sessions are Codex threads: its spans are the thread's
  const acp = {
    keys: new Set<string>(),
    spans: addSpans(new Map(), liveSpans([{ harness: 'codex-acp', session: T, t: iso(T0), outcome: 'ok', in: 1 }])),
  };
  assert.equal(recorded(acp, r, 'codex'), true);
});

test('rollouts are read again only when changed; one the core cannot read keeps what it had; a version 1 store reads', async () => {
  const dir = tmp();
  const name = `${day(T0)}/rollout-x-${T}.jsonl.zst`;
  const roots = homes({ [name]: rollout(T, T0, [[T0 + 1000, 10, 5, 0, 5]]) });
  // a version 1 store held Claude Code's transcripts only: its files are kept as Claude Code's
  const claudeFile = path.join(roots.claude, 'gone.jsonl');
  const v1 = { v: 1, files: { [claudeFile]: { stamp: '1:1', requests: [['m', 's', iso(T0), 'claude-opus-4-8', 1, 0, 0, 0]] } } };
  fs.writeFileSync(path.join(dir, 'imported.json'), JSON.stringify(v1));
  const imp = new LedgerImport({ dir: () => dir, dayOf, pause: async () => {} });
  assert.deepEqual(await imp.importOutside(roots, on), both([0, 0], [1, 1]));
  assert.deepEqual(await imp.importOutside(roots, on), both([0, 0], [1, 0]));
  assert.deepEqual((await imp.rows(ALL, none)).map((r: any) => [r.harness, r.requests]).sort(), [
    ['claude', 1],
    ['codex', 1],
  ]);
  // the file is no zstd frame now: the core cannot read it, and what the last import found stays
  fs.writeFileSync(path.join(roots.home, name), 'this is not a zstd frame');
  const found = await quiet(() => imp.importOutside(roots, on));
  assert.deepEqual(found, both([0, 0], [1, 0, 1]), 'it says the file could not be read');
  assert.equal(total((await imp.rows(ALL, none)).filter((r: any) => r.harness === 'codex')), 1);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'imported.json'), 'utf8'));
  assert.equal(stored.files[claudeFile].harness, undefined);
});

test('a file both roots reach is read once, as Claude Code’s', async () => {
  const roots = homes({ [`${day(T0)}/rollout-x-${T}.jsonl`]: rollout(T, T0, [[T0 + 1000, 10, 5, 0, 5]]) });
  const seen: string[] = [];
  const dir = tmp();
  const imp = new LedgerImport({
    dir: () => dir,
    dayOf,
    pause: async () => {},
    lines: (file: string) => (seen.push(file), []),
    rollout: async () => assert.fail('read as Codex’s'),
  });
  const found = await imp.importOutside({ claude: roots.codex[0], codex: roots.codex }, on);
  assert.deepEqual(found, both([1, 1], [0, 0]));
  assert.equal(seen.length, 1);
});

test('on a day an older version folded without live sessions, nothing imported counts: MoPilot’s requests are the rollup’s', async () => {
  const dir = tmp();
  const d = dayOf(T0);
  const next = dayOf(T0 + 2 * DAY);
  const row = { day: d, harness: 'codex', model: 'gpt-5.5', pay: 'unknown', requests: 1, in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
  // the older version folded day d (MoPilot ran T's first request then) and wrote no live sessions
  fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: { [d]: [row] } }));
  const l = new RequestLedger({ dir, now: () => T0 + 3 * DAY });
  l.imports.pause = async () => {};
  // the second request is on the next local day, but within a time zone change of day d: it may be what the rollup filed under d
  const t = rollout(T, T0 - 5000, [
    [T0, 110, 100, 0, 10],
    [T0 + 15 * 3_600_000, 220, 100, 0, 10],
    [T0 + 2 * DAY, 440, 200, 0, 20],
  ]);
  await l.importOutside(homes({ [`${day(T0)}/rollout-x-${T}.jsonl`]: t }));
  const s = await l.summary();
  assert.deepEqual(
    [d, next].map((x) =>
      sum(
        s.rows.filter((r: any) => r.day === x),
        ['requests', 'in'],
      ),
    ),
    [
      [1, 100],
      [1, 200],
    ],
    'day d once, from the rollup; a day further on from the import',
  );
});

test('a day folded with no live sessions covers its requests whichever time zone it was folded in and is read in', async () => {
  const dir = tmp();
  const req = (id: string, t: string) => [id, T, t, 'gpt-5.5', 1, 0, 0, 0];
  // 10:30Z on Oct 1 is Oct 2 in UTC+14, where the day was folded, and Sep 30 in UTC−12, where it is read
  const files = {
    f: { stamp: 's', harness: 'codex', requests: [req(`${T}:1`, '2026-10-01T10:30:00.000Z'), req(`${T}:2`, '2026-10-03T12:00:00.000Z')] },
  };
  fs.writeFileSync(path.join(dir, 'imported.json'), JSON.stringify({ v: 2, files }));
  const westmost = (ms: number) => new Date(ms - 12 * 3_600_000).toISOString().slice(0, 10);
  const imp = new LedgerImport({ dir: () => dir, dayOf: westmost });
  const live = { ...none, spanless: new Set(['2026-10-02']) };
  assert.deepEqual(
    (await imp.rows(ALL, live)).map((r: any) => [r.day, r.requests]),
    [['2026-10-03', 1]],
  );
});
