// The request ledger's line and files (electron/ledger/line.cjs, store.cjs): the allowlisted v1 line, error text
// scrubbed and cut short, batched appends by one writer, the day file and its cap, retention, the Privacy switch,
// the synchronous write at quit, and reading the last lines back with filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ledgerLine, errorText, ERROR_MAX } = require('../electron/ledger/line.cjs');
const { RequestLedger, dayOf, parseLines } = require('../electron/ledger/store.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { buildDiagnostics } = require('../electron/support/diagnostics.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'request-ledger-'));
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const read = (dir: string, day = dayOf(T0)) =>
  fs
    .readFileSync(path.join(dir, `${day}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const quiet = <T>(fn: () => T) => {
  const d = console.debug;
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.debug = d;
  }
};

test('a line keeps only typed ids, counts and the outcome, in schema v1', () => {
  const line = JSON.parse(
    ledgerLine(
      {
        harness: 'codex',
        chat: 'c1',
        session: 's1',
        turn: 't1',
        account: { id: 'a1', email: 'me@example.com', verified: true },
        req: 'gpt-5',
        served: 'gpt-5-mini',
        effort: 'high',
        in: 10.4,
        out: 20,
        cacheRead: 30,
        cacheWrite: 0,
        reasoning: 5,
        outcome: 'ok',
        status: 200,
        code: 'x',
        error: 'not on ok lines',
        // anything else a tap passes in never reaches the file
        prompt: 'secret prompt',
        tool: { args: 'rm -rf /' },
      } as any,
      T0,
    ),
  );
  assert.deepEqual(line, {
    v: 1,
    t: new Date(T0).toISOString(),
    chat: 'c1',
    harness: 'codex',
    session: 's1',
    turn: 't1',
    account: { id: 'a1', email: 'me@example.com', verified: true },
    req: 'gpt-5',
    served: 'gpt-5-mini',
    effort: 'high',
    in: 10,
    out: 20,
    cacheRead: 30,
    cacheWrite: 0,
    reasoning: 5,
    outcome: 'ok',
    status: 200,
  });
});

test('a line drops values of the wrong type or shape, and refuses a record without a harness or a known outcome', () => {
  const line = JSON.parse(
    ledgerLine(
      {
        harness: 'claude',
        chat: 42,
        session: 'x'.repeat(201),
        account: { id: '', email: 'e' },
        in: Number.NaN,
        out: -1,
        cacheRead: Infinity,
        reasoning: '7',
        outcome: 'error',
        code: { not: 'an id' },
      } as any,
      T0,
    ),
  );
  assert.deepEqual(line, { v: 1, t: new Date(T0).toISOString(), harness: 'claude', outcome: 'error' });
  // an account without an email or a boolean verified keeps just its id
  assert.deepEqual(JSON.parse(ledgerLine({ harness: 'h', outcome: 'ok', account: { id: 'a', email: null, verified: null } }, T0)).account, {
    id: 'a',
  });
  assert.equal(ledgerLine({ outcome: 'ok' } as any, T0), null);
  assert.equal(ledgerLine({ harness: 'codex', outcome: 'done' } as any, T0), null);
  assert.equal(ledgerLine(null as any, T0), null);
});

test("a line's error text loses keys, tokens, emails and the home folder, and is cut short", () => {
  const home = '/Users/someone';
  const text = errorText(
    `401 Invalid key sk-ant-${'a'.repeat(30)} for Bearer abcdefghijklmnop at /Users/someone/project\n  from me@example.com`,
    home,
  );
  assert.equal(text, '401 Invalid key [REDACTED:anthropic-key] for Bearer [REDACTED:token] at ~/project from <email>');
  const long = errorText('e'.repeat(ERROR_MAX + 50));
  assert.equal(long.length, ERROR_MAX + 1);
  assert.ok(long.endsWith('…'));
  assert.equal(errorText('   '), undefined);
  assert.equal(errorText(42 as any), undefined);
});

test('records are batched into one append, written to the day file, with nothing written before the flush', async () => {
  const dir = tmp();
  const appends: string[] = [];
  const fsp = {
    ...fs.promises,
    appendFile: async (f: string, text: string, o: any) => (appends.push(text), fs.promises.appendFile(f, text, o)),
  };
  const l = new RequestLedger({ dir, now: () => T0, fsp, flushMs: 10_000 });
  assert.equal(l.record({ harness: 'codex', outcome: 'ok', in: 1 }), true);
  assert.equal(l.record({ harness: 'codex', outcome: 'retry', status: 429 }), true);
  assert.equal(l.record({ outcome: 'ok' } as any), false, 'an invalid record is not queued');
  assert.equal(fs.existsSync(path.join(dir, `${dayOf(T0)}.jsonl`)), false);
  await l.flush();
  assert.equal(appends.length, 1);
  assert.deepEqual(
    read(dir).map((x) => [x.outcome, x.status]),
    [
      ['ok', undefined],
      ['retry', 429],
    ],
  );
  assert.equal((fs.statSync(path.join(dir, `${dayOf(T0)}.jsonl`)).mode & 0o777).toString(8), '600');
  // an empty queue writes nothing
  await l.flush();
  assert.equal(appends.length, 1);
});

test("a record's timer flushes on its own, and a flush during one in flight waits for it and then writes the rest", async () => {
  const dir = tmp();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const reached = new Promise<void>((r) => (started = r));
  let first = true;
  const fsp = {
    ...fs.promises,
    appendFile: async (f: string, text: string, o: any) => {
      if (first) {
        first = false;
        const held = new Promise<void>((r) => (release = r));
        started();
        await held;
      }
      return fs.promises.appendFile(f, text, o);
    },
  };
  const l = new RequestLedger({ dir, now: () => T0, fsp, flushMs: 1 });
  l.record({ harness: 'a', outcome: 'ok' });
  // the timer, not a flush, starts the first append
  await reached;
  assert.ok(l.inflight);
  l.record({ harness: 'b', outcome: 'ok' });
  const done = l.flush();
  release();
  await done;
  assert.deepEqual(
    read(dir).map((x) => x.harness),
    ['a', 'b'],
  );
});

test('the day a record falls on names its file; a batch across midnight goes to both', async () => {
  const dir = tmp();
  let now = new Date(2026, 9, 17, 23, 59, 59).getTime();
  const l = new RequestLedger({ dir, now: () => now, flushMs: 10_000 });
  l.record({ harness: 'a', outcome: 'ok' });
  now += 2000;
  l.record({ harness: 'b', outcome: 'ok' });
  await l.flush();
  assert.deepEqual(
    read(dir, '2026-10-17').map((x) => x.harness),
    ['a'],
  );
  assert.deepEqual(
    read(dir, '2026-10-18').map((x) => x.harness),
    ['b'],
  );
});

test("a day's file stops at its cap with one capped marker, counting what was on disk before this run", async () => {
  const dir = tmp();
  const line = ledgerLine({ harness: 'codex', outcome: 'ok' }, T0);
  const size = Buffer.byteLength(line) + 1;
  fs.writeFileSync(path.join(dir, `${dayOf(T0)}.jsonl`), `${line}\n`);
  const l = new RequestLedger({ dir, now: () => T0, dayMax: size * 3, flushMs: 10_000 });
  for (let i = 0; i < 4; i++) l.record({ harness: 'codex', outcome: 'ok' });
  await l.flush();
  l.record({ harness: 'codex', outcome: 'ok' });
  await l.flush();
  const lines = read(dir);
  assert.equal(lines.filter((x) => x.harness).length, 3);
  assert.equal(lines.filter((x) => x.capped).length, 1);
  assert.equal(lines.at(-1).capped, true);
  // a new run reading a file already over its cap writes nothing more to it
  const again = new RequestLedger({ dir, now: () => T0, dayMax: size, flushMs: 10_000 });
  again.record({ harness: 'codex', outcome: 'ok' });
  await again.flush();
  assert.equal(read(dir).length, lines.length);
});

test('files older than the retention are deleted once a day; other files and newer days stay', async () => {
  const dir = tmp();
  for (const name of ['2026-09-16.jsonl', '2026-09-17.jsonl', '2026-10-16.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '');
  const removed: string[] = [];
  const fsp = { ...fs.promises, unlink: async (p: string) => (removed.push(path.basename(p)), fs.promises.unlink(p)) };
  const l = new RequestLedger({ dir, now: () => T0, keepDays: 30, fsp, flushMs: 10_000 });
  l.record({ harness: 'a', outcome: 'ok' });
  await l.flush();
  assert.deepEqual(removed, ['2026-09-16.jsonl']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-09-17.jsonl', '2026-10-16.jsonl', '2026-10-17.jsonl', 'days.json', 'notes.txt']);
  fs.writeFileSync(path.join(dir, '2026-09-01.jsonl'), '');
  l.record({ harness: 'a', outcome: 'ok' });
  await l.flush();
  assert.deepEqual(removed, ['2026-09-16.jsonl'], 'pruned at most once a day');
});

test('a failed delete or write is noted and costs only that batch', async () => {
  clearIgnored();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), '');
  let failWrite = true;
  const fsp = {
    ...fs.promises,
    unlink: async () => {
      throw new Error('locked');
    },
    appendFile: async (f: string, text: string, o: any) => {
      if (failWrite) throw new Error('disk full');
      return fs.promises.appendFile(f, text, o);
    },
  };
  const l = new RequestLedger({ dir, now: () => T0, fsp, flushMs: 10_000 });
  await quiet(async () => {
    l.record({ harness: 'lost', outcome: 'ok' });
    await l.flush();
    failWrite = false;
    l.record({ harness: 'kept', outcome: 'ok' });
    await l.flush();
  });
  assert.deepEqual(
    read(dir).map((x) => x.harness),
    ['kept'],
  );
  const notes = recentIgnored().map((e: any) => e.context);
  assert.ok(notes.includes('write the request ledger'));
  assert.ok(notes.includes('delete an old request ledger file'));
});

test('with the Privacy switch off nothing is queued, and what was queued before it went off is dropped', async () => {
  const dir = tmp();
  let on = true;
  const l = new RequestLedger({ dir, now: () => T0, enabled: () => on, flushMs: 10_000 });
  assert.equal(l.record({ harness: 'a', outcome: 'ok' }), true);
  on = false;
  assert.equal(l.record({ harness: 'b', outcome: 'ok' }), false);
  await l.flush();
  l.flushSync();
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0);
});

test('quitting writes what is queued synchronously; a failure is noted', () => {
  clearIgnored();
  const dir = path.join(tmp(), 'nested');
  const l = new RequestLedger({ dir, now: () => T0, flushMs: 10_000 });
  l.record({ harness: 'a', outcome: 'ok' });
  l.record({ harness: 'b', outcome: 'error', error: 'x' });
  l.flushSync();
  assert.equal(l.timer, null);
  assert.deepEqual(
    read(dir).map((x) => x.harness),
    ['a', 'b'],
  );
  // nothing queued: nothing to do
  l.flushSync();
  const broken = new RequestLedger({
    dir,
    now: () => T0,
    fsSync: {
      mkdirSync: () => undefined,
      existsSync: () => false,
      statSync: () => ({ size: 0 }),
      appendFileSync: () => {
        throw new Error('read-only');
      },
    },
    flushMs: 10_000,
  });
  broken.record({ harness: 'c', outcome: 'ok' });
  quiet(() => broken.flushSync());
  assert.ok(recentIgnored().some((e: any) => e.context === 'write the request ledger at quit'));
});

test("quitting keeps to the day's cap: a full file takes no more lines, one near it takes what fits and the marker", () => {
  const dir = tmp();
  const line = ledgerLine({ harness: 'codex', outcome: 'ok' }, T0);
  const size = Buffer.byteLength(line) + 1;
  fs.writeFileSync(path.join(dir, `${dayOf(T0)}.jsonl`), `${line}\n`);
  const l = new RequestLedger({ dir, now: () => T0, dayMax: size * 2, flushMs: 10_000 });
  for (let i = 0; i < 3; i++) l.record({ harness: 'codex', outcome: 'ok' });
  l.flushSync();
  const lines = read(dir);
  assert.deepEqual(
    lines.map((x) => (x.capped ? 'capped' : x.harness)),
    ['codex', 'codex', 'capped'],
  );
  // what this run knows of the day is the cap reached: a later quit writes nothing more
  l.record({ harness: 'codex', outcome: 'ok' });
  l.flushSync();
  assert.equal(read(dir).length, 3);
});

test('a read of the log looks through about readMax of the newest files, so a narrow filter stays bounded', async () => {
  const dir = tmp();
  const at = (d: string, h: string) => JSON.stringify({ v: 1, t: `${d}T10:00:00.000Z`, harness: h, outcome: 'ok' });
  fs.writeFileSync(path.join(dir, '2026-10-15.jsonl'), `${at('2026-10-15', 'old')}\n`);
  fs.writeFileSync(path.join(dir, '2026-10-16.jsonl'), `${at('2026-10-16', 'codex')}\n`);
  fs.writeFileSync(path.join(dir, '2026-10-17.jsonl'), `${at('2026-10-17', 'codex')}\n`);
  const l = new RequestLedger({ dir, now: () => T0, readMax: 1 });
  assert.deepEqual(
    (await l.recent({ harness: 'old' })).map((x: any) => x.harness),
    [],
    'the newest file was enough to reach the budget',
  );
  const all = new RequestLedger({ dir, now: () => T0 });
  assert.deepEqual(
    (await all.recent({ harness: 'old' })).map((x: any) => x.harness),
    ['old'],
  );
});

test('recent reads newest first across day files, filters, skips cut lines and caps the count', async () => {
  clearIgnored();
  const dir = tmp();
  const at = (d: string, o: any) => JSON.stringify({ v: 1, t: `${d}T10:00:00.000Z`, ...o });
  fs.writeFileSync(
    path.join(dir, '2026-10-16.jsonl'),
    `${[
      at('2026-10-16', { harness: 'codex', outcome: 'ok', chat: 'c1', account: { id: 'a1', email: 'x@y.z' } }),
      '{"cut short',
      '"not an object"',
      at('2026-10-16', { harness: 'claude', outcome: 'error', chat: 'c2', account: { id: 'default' } }),
    ].join('\n')}\n`,
  );
  const l = new RequestLedger({ dir, now: () => T0, flushMs: 10_000 });
  l.record({ harness: 'codex', outcome: 'retry', chat: 'c1' });
  const all = await quiet(() => l.recent());
  assert.deepEqual(
    all.map((x: any) => [x.harness, x.outcome]),
    [
      ['codex', 'retry'],
      ['claude', 'error'],
      ['codex', 'ok'],
    ],
  );
  assert.ok(recentIgnored().some((e: any) => e.context === 'read a request ledger line'));
  const pick = async (f: any) => (await quiet(() => l.recent(f))).map((x: any) => x.outcome);
  assert.deepEqual(await pick({ harness: 'codex' }), ['retry', 'ok']);
  assert.deepEqual(await pick({ account: 'x@y.z' }), ['ok']);
  assert.deepEqual(await pick({ account: 'default' }), ['error']);
  assert.deepEqual(await pick({ outcome: 'error' }), ['error']);
  assert.deepEqual(await pick({ chat: 'c1' }), ['retry', 'ok']);
  assert.deepEqual(await pick({ limit: 1 }), ['retry']);
  assert.deepEqual(await pick({ limit: 'many' }), ['retry', 'error', 'ok'], 'a limit that is not a number reads 200');
  // a missing folder reads as no lines
  assert.deepEqual(await new RequestLedger({ dir: path.join(dir, 'none') }).recent(), []);
});

test('lastDay keeps the last 24 hours across today and yesterday, oldest first, at most max lines', async () => {
  const dir = tmp();
  const line = (t: string, h: string) => JSON.stringify({ v: 1, t, harness: h, outcome: 'ok' });
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  fs.writeFileSync(
    path.join(dir, `${dayOf(now - 86_400_000)}.jsonl`),
    `${line('2026-10-16T11:00:00.000Z', 'old')}\n${line('2026-10-16T13:00:00.000Z', 'y')}\n`,
  );
  fs.writeFileSync(path.join(dir, `${dayOf(now)}.jsonl`), `${line('2026-10-17T11:00:00.000Z', 't')}\n`);
  const l = new RequestLedger({ dir, now: () => now });
  assert.deepEqual(
    (await l.lastDay()).map((s: string) => JSON.parse(s).harness),
    ['y', 't'],
  );
  assert.deepEqual(
    (await l.lastDay(1)).map((s: string) => JSON.parse(s).harness),
    ['t'],
  );
});

test('a read of a day file that fails for another reason than a missing file is noted and reads as empty', async () => {
  clearIgnored();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `${dayOf(T0)}.jsonl`), '');
  const fsp = {
    ...fs.promises,
    readFile: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  const l = new RequestLedger({ dir, now: () => T0, fsp });
  assert.deepEqual(await quiet(() => l.recent()), []);
  assert.ok(recentIgnored().some((e: any) => e.context === 'read a request ledger file'));
});

test('parseLines keeps only objects with a time', () => {
  assert.deepEqual(parseLines('\n{"t":"x"}\n{"no":"time"}\nnull\n'), [{ t: 'x' }]);
});

test('Copy diagnostics lists the last day of the request log, scrubbed like the rest', async () => {
  const text = buildDiagnostics({
    version: '1',
    platform: 'darwin',
    home: '/Users/me',
    ledger: ['{"harness":"codex","account":{"email":"me@example.com"},"error":"in /Users/me/x"}'],
  });
  assert.match(text, /Request log, last day \(1 lines\)\n {2}\{"harness":"codex","account":\{"email":"<email>"\},"error":"in ~\/x"\}/);
  assert.doesNotMatch(buildDiagnostics({ version: '1', platform: 'darwin', ledger: [] }), /Request log/);
});
