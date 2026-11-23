// Importing the usage of Claude Code sessions run outside MoPilot (electron/ledger/backfill.cjs, store.cjs summary/importOutside, the
// rollup's live sessions): one request per message id over every transcript (a fork's copies say forkedFrom and are left out),
// nothing MoPilot recorded itself, decided each time the summary reads it (its key in a raw day, or its session's span up to its
// last request with usage, drawn alike from raw and folded days), transcripts found however deep, and a store that cannot be read
// never written over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LedgerImport,
  ImportUnreadable,
  liveSpans,
  addSpans,
  claudeRequests,
  recorded,
  spanKey,
} = require('../electron/ledger/backfill.cjs');
const { LedgerRollup, RollupUnreadable } = require('../electron/ledger/rollup.cjs');
const { RequestLedger, dayOf } = require('../electron/ledger/store.cjs');
const { identityKey } = require('../shared/identityKey.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-import-'));
const T0 = new Date(2026, 10, 22, 10, 0, 0).getTime();
const DAY = 86_400_000;
const M = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const none = { keys: new Set<string>(), spans: new Map() };
const ALL = { from: '0000-00-00', to: '9999-99-99', oldest: '0000-00-00' };
const rec = (id: string, t: string, o: any = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: t,
    sessionId: o.session ?? 's1',
    ...(o.forkedFrom ? { forkedFrom: o.forkedFrom } : {}),
    message: {
      id,
      model: o.model ?? 'claude-opus-4-8',
      usage: { input_tokens: o.in ?? M, output_tokens: o.out ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
const fresh = (dir: string, o: any = {}) => new LedgerImport({ dir: () => dir, dayOf, pause: async () => {}, ...o });
const on = () => true;
/** The roots of an import that reads Claude Code's transcripts under `claude`, with no Codex rollouts. */
const roots = (claude: string) => ({ claude, codex: [path.join(claude, 'no-codex-home')] });
const found = (files: number, read: number, failed = 0) => ({ claude: { files, read, failed }, codex: { files: 0, read: 0, failed: 0 } });
const total = (rows: any[]) => rows.reduce((n, r) => n + r.requests, 0);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const d = console.debug;
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.debug = d;
  }
};
const ledgerLine = (o: any) => `${JSON.stringify({ v: 1, harness: 'claude', outcome: 'ok', served: 'claude-opus-4-8', in: M, ...o })}\n`;

test('a transcript is one request per message id at its last record; copies, CLI replies and bad records are none', async () => {
  const lines = [
    rec('m1', '2026-11-22T09:00:00.000Z', { in: 5 }),
    rec('m1', '2026-11-22T09:00:02.000Z', { in: 7 }), // the same request's final usage
    rec('m2', '2026-11-22T09:01:00.000Z', { model: '' }),
    rec('copied', '2026-11-20T09:00:00.000Z', { forkedFrom: { sessionId: 's0' } }),
    '{"type":"user","toolUseResult":{"type":"assistant"}}',
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    '{"type":"assistant", broken',
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-22T09:02:00.000Z',
      sessionId: 's1',
      message: { id: 'syn', model: '<synthetic>', usage: {} },
    }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-22T09:02:00.000Z', sessionId: 's1', message: { id: 'nousage' } }),
    JSON.stringify({ type: 'assistant', timestamp: 'yesterday', sessionId: 's1', message: { id: 'badtime', usage: {} } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-22T09:02:00.000Z', message: { id: 'nosession', usage: {} } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-22T09:03:00.000Z',
      sessionId: 's1',
      message: { id: 'odd', usage: { input_tokens: -3, output_tokens: 'x' } },
    }),
  ];
  assert.deepEqual(await claudeRequests(lines), [
    ['m1', 's1', '2026-11-22T09:00:02.000Z', 'claude-opus-4-8', 7, 0, 0, 0],
    ['m2', 's1', '2026-11-22T09:01:00.000Z', null, M, 0, 0, 0],
    ['odd', 's1', '2026-11-22T09:03:00.000Z', null, 0, 0, 0, 0],
  ]);
});

test('a session MoPilot ran owns its requests up to its last recorded one; Claude Code under ACP is the same session', () => {
  const u = { outcome: 'ok', in: 1 };
  const lines = [
    { harness: 'claude', session: 's1', t: '2026-11-22T09:05:00.000Z', ...u },
    { harness: 'claude', session: 's1', t: '2026-11-22T09:01:00.000Z', ...u },
    { harness: 'claude', session: 's1', t: '2026-11-22T09:07:00.000Z', ...u },
    // a retry, a stop or an error carries no usage, and draws no span
    { harness: 'claude', session: 's1', t: '2026-11-22T10:00:00.000Z', outcome: 'retry' },
    { harness: 'claude-acp', session: 's2', t: '2026-11-22T09:00:00.000Z', ...u },
    { harness: 'codex', session: 's1', t: '2026-11-22T09:00:00.000Z', ...u },
    { harness: 'claude', session: 3, t: 'x', ...u },
    { harness: 'claude', session: 's9', kind: 'computerAccess', t: 'x', ...u },
    { harness: 'claude', session: 's8', t: 7, ...u },
    null,
  ];
  const spans = liveSpans(lines);
  assert.deepEqual(
    Object.keys(spans).sort(),
    [identityKey('claude', 's1'), identityKey('claude', 's2'), identityKey('codex', 's1')].sort(),
  );
  assert.deepEqual(spans[spanKey('claude', 's1')], { first: '2026-11-22T09:01:00.000Z', last: '2026-11-22T09:07:00.000Z' });
  const live = { keys: new Set(['k1']), spans: addSpans(new Map(), spans) };
  const r = (id: string, session: string, t: string) => [id, session, t, null, 1, 0, 0, 0];
  assert.equal(recorded(live, r('k1', 'other', '2026-01-01T00:00:00.000Z')), true, 'its key');
  // the ledger writes a request after the transcript holds it: the session's first request comes before the span's first line
  assert.equal(recorded(live, r('a', 's1', '2026-11-22T09:00:30.000Z')), true);
  assert.equal(recorded(live, r('b', 's1', '2026-11-22T09:07:00.000Z')), true);
  assert.equal(recorded(live, r('c', 's1', '2026-11-22T09:30:00.000Z')), false, 'after its last recorded request: resumed elsewhere');
  assert.equal(recorded(live, r('d', 's2', '2026-11-22T08:00:00.000Z')), true, 'run under ACP');
  assert.equal(recorded(live, r('e', 's9', '2026-11-22T08:00:00.000Z')), false);
  const widened = addSpans(new Map([['x', { first: '2026-01-02T00:00:00.000Z', last: '2026-01-03T00:00:00.000Z' }]]), {
    x: { first: '2026-01-01T00:00:00.000Z', last: '2026-01-02T00:00:00.000Z' },
  });
  assert.deepEqual(widened.get('x'), { first: '2026-01-01T00:00:00.000Z', last: '2026-01-03T00:00:00.000Z' });
});

test('an import finds transcripts however deep, counts a copied id once, and keeps what Claude Code deleted', async () => {
  const dir = tmp();
  const root = tmp();
  const project = path.join(root, '-Users-me-repo');
  const workflow = path.join(project, 's1', 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(workflow, { recursive: true });
  const main = path.join(project, 's1.jsonl');
  fs.writeFileSync(main, `${rec('a', '2026-11-21T09:00:00.000Z')}\n${rec('b', '2026-11-22T09:00:00.000Z')}\n`);
  // a resume wrote the session's history into a second file: the same ids, the same session
  fs.writeFileSync(
    path.join(project, 's1-resumed.jsonl'),
    `${rec('a', '2026-11-21T09:00:00.000Z')}\n${rec('c', '2026-11-22T11:00:00.000Z')}\n`,
  );
  fs.writeFileSync(path.join(workflow, 'agent-1.jsonl'), `${rec('w', '2026-11-22T09:30:00.000Z', { out: M })}\n`);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a transcript');
  fs.symlinkSync(root, path.join(project, 'loop'));
  const imp = fresh(dir);
  assert.deepEqual(await imp.importOutside(roots(root), on), found(3, 3));
  assert.equal(total(await imp.rows(ALL, none)), 4, 'a, b, c and w: a once');
  assert.equal(fs.statSync(path.join(dir, 'imported.json')).mode & 0o777, 0o600);
  assert.deepEqual(await imp.importOutside(roots(root), on), found(3, 0), 'nothing changed: nothing read again');
  // a transcript that grew is read again, its requests replaced
  fs.appendFileSync(main, `${rec('d', '2026-11-22T12:00:00.000Z')}\n`);
  assert.deepEqual(await imp.importOutside(roots(root), on), found(3, 1));
  // one Claude Code deleted keeps its requests; one that cannot be read keeps what an earlier import found
  fs.rmSync(path.join(project, 's1'), { recursive: true });
  fs.appendFileSync(main, `${rec('e', '2026-11-22T13:00:00.000Z')}\n`);
  const denied = fresh(dir, {
    lines: (file: string) => {
      if (file === main) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(file, 'utf8').split('\n');
    },
  });
  assert.deepEqual(await quiet(() => denied.importOutside(roots(root), on)), found(2, 0, 1), 'the changed one could not be read');
  assert.equal(total(await denied.rows(ALL, none)), 5, 'a, b, c, d and w');
  assert.equal(total(await denied.rows({ from: '2026-11-22', to: '2026-11-22', oldest: '0000-00-00' }, none)), 4, 'within a range');
  assert.equal((await denied.rows({ ...ALL, oldest: '2026-11-23' }, none)).length, 0, 'within the rollup’s retention');
  assert.deepEqual(await fresh(tmp()).importOutside(roots(path.join(root, 'nope')), on), found(0, 0));
});

test('a transcript gone before its read is skipped; two imports at once are one; the default pause and reader work', async () => {
  const dir = tmp();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.jsonl'), `${rec('a', '2026-11-22T09:00:00.000Z')}\n`);
  fs.writeFileSync(path.join(root, 'gone.jsonl'), `${rec('g', '2026-11-22T09:00:00.000Z')}\n`);
  fs.writeFileSync(path.join(root, 'locked.jsonl'), `${rec('l', '2026-11-22T09:00:00.000Z')}\n`);
  const failing = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  const fsp = {
    ...fs.promises,
    stat: async (p: string) =>
      p.endsWith('gone.jsonl') ? failing('ENOENT') : p.endsWith('locked.jsonl') ? failing('EACCES') : fs.promises.stat(p),
  };
  const imp = new LedgerImport({ dir: () => dir, dayOf, fsp });
  const [a, b] = await quiet(() => Promise.all([imp.importOutside(roots(root), on), imp.importOutside(roots(root), on)]));
  assert.deepEqual(a, found(3, 1, 1), 'one gone since it was listed is no failure; one that cannot be looked at is');
  assert.equal(a, b, 'the second ask joined the first');
  assert.equal(total(await imp.rows(ALL, none)), 1);
  assert.equal(imp.running, null, 'a new ask after it ends runs again');
});

test('the Privacy switch turned off during an import saves nothing', async () => {
  const dir = tmp();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.jsonl'), `${rec('a', '2026-11-22T09:00:00.000Z')}\n`);
  assert.deepEqual(await fresh(dir).importOutside(roots(root), () => false), { refused: 'off' });
  assert.equal(fs.existsSync(path.join(dir, 'imported.json')), false);
});

test('an import store that cannot be parsed is set aside whole; one that cannot be opened is never written over', async () => {
  const bad = [
    '{nope',
    JSON.stringify({ v: 3, files: {} }),
    // a version 1 store holds no Codex rollouts, and a harness is Codex's or none
    JSON.stringify({ v: 1, files: { x: { stamp: 's', requests: [], harness: 'codex' } } }),
    JSON.stringify({ v: 2, files: { x: { stamp: 's', requests: [], harness: 'claude' } } }),
    JSON.stringify({ v: 1, files: [] }),
    JSON.stringify({ v: 1, files: { x: { stamp: 1, requests: [] } } }),
    JSON.stringify({ v: 1, files: { x: { stamp: 's', requests: [['a', 's', 'yesterday', null, 1, 0, 0, 0]] } } }),
  ];
  for (const text of bad) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'imported.json'), text);
    await assert.rejects(fresh(dir).union(), ImportUnreadable, text);
    assert.deepEqual(await fresh(dir).importOutside(roots(tmp()), on), found(0, 0));
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith('imported.unreadable-'));
    assert.equal(aside.length, 1, text);
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), text, 'kept as it was');
  }
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'imported.json'), JSON.stringify({ v: 1, files: {} }));
  const failing = fresh(dir, { fsp: { ...fs.promises, readFile: async () => Promise.reject('disk gone') } });
  await assert.rejects(failing.importOutside(roots(tmp()), on), /disk gone/);
  assert.equal(fs.readFileSync(path.join(dir, 'imported.json'), 'utf8'), JSON.stringify({ v: 1, files: {} }));
  const noStat = { ...fs.promises, stat: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) };
  await assert.rejects(fresh(dir, { fsp: noStat }).union(), ImportUnreadable);
  await assert.rejects(fresh(dir, { fsp: { ...fs.promises, stat: async () => Promise.reject('gone away') } }).union(), /gone away/);
});

test('the rollup keeps each folded live session’s span, widens it, drops it past the retention, and reads one without', async () => {
  const dir = tmp();
  const rollup = new LedgerRollup({ dir: () => dir, oldest: () => '2026-01-01' });
  const k = identityKey('claude', 's1');
  await rollup.fold({}, { [k]: { first: '2026-11-02T00:00:00.000Z', last: '2026-11-03T00:00:00.000Z' } });
  await rollup.fold(
    {},
    {
      [k]: { first: '2026-11-01T00:00:00.000Z', last: '2026-11-02T00:00:00.000Z' },
      old: { first: '2025-01-01T00:00:00.000Z', last: '2025-01-02T00:00:00.000Z' },
    },
  );
  await rollup.fold({}, { [k]: { first: '2026-11-04T00:00:00.000Z', last: '2026-11-05T00:00:00.000Z' } });
  assert.deepEqual({ ...(await rollup.load()).live }, { [k]: { first: '2026-11-01T00:00:00.000Z', last: '2026-11-05T00:00:00.000Z' } });
  fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: {} }));
  assert.deepEqual({ ...(await rollup.load()).live }, {}, 'a rollup from before live sessions were kept');
  const badLive = [
    [],
    3,
    { x: { first: 'yesterday', last: '2026-11-01T00:00:00.000Z' } },
    { x: { first: '2026-11-02T00:00:00.000Z', last: '2026-11-01T00:00:00.000Z' } },
  ];
  for (const live of badLive) {
    fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify({ v: 1, days: {}, live }));
    await assert.rejects(rollup.load(), RollupUnreadable, JSON.stringify(live));
  }
});

test('the summary counts each request once: a request MoPilot records after the import is left out from then on', async () => {
  const dir = tmp();
  const root = tmp();
  const today = dayOf(T0);
  // MoPilot ran session s1 and recorded m1; m0 has no line (its session owns it), m2 comes after (not yet recorded); s9 ran alone
  fs.writeFileSync(path.join(dir, `${today}.jsonl`), ledgerLine({ t: iso(T0), session: 's1', key: 'm1' }));
  fs.writeFileSync(path.join(root, 's1.jsonl'), `${rec('m0', iso(T0 - 60_000))}\n${rec('m1', iso(T0))}\n${rec('m2', iso(T0 + 60_000))}\n`);
  fs.writeFileSync(path.join(root, 's9.jsonl'), `${rec('x1', iso(T0 - DAY), { session: 's9', model: 'claude-sonnet-4-5' })}\n`);
  const l = new RequestLedger({ dir, now: () => T0 + 120_000 });
  l.imports.pause = async () => {};
  assert.deepEqual(await l.importOutside(roots(root)), found(2, 2));
  const s = await l.summary();
  assert.equal(s.imported, 'ok');
  const count = (rows: any[], model: string) => total(rows.filter((r) => r.model === model));
  assert.equal(count(s.rows, 'claude-sonnet-4-5'), 1, 'x1, from the import');
  assert.equal(count(s.rows, 'claude-opus-4-8'), 2, 'm1 from the ledger, m0 left out inside its session, m2 from the import');
  // MoPilot now records m2: the next summary leaves the imported m2 out
  fs.appendFileSync(path.join(dir, `${today}.jsonl`), ledgerLine({ t: iso(T0 + 61_000), session: 's1', key: 'm2' }));
  assert.equal(count((await l.summary()).rows, 'claude-opus-4-8'), 2, 'm1 and m2 once each: m2 now from the ledger');
  // an import store that cannot be read: the summary says so and counts the rest
  fs.writeFileSync(path.join(dir, 'imported.json'), '{');
  const broken: any = await quiet(() => l.summary());
  assert.equal(broken.imported, 'unreadable');
  assert.equal(count(broken.rows, 'claude-sonnet-4-5'), 0);
  assert.deepEqual(await new RequestLedger({ dir, now: () => T0, enabled: () => false }).importOutside(roots(root)), { refused: 'off' });
});

test('after the raw days are pruned, the rollup’s live sessions still leave MoPilot’s requests out', async () => {
  const dir = tmp();
  const root = tmp();
  const today = dayOf(T0);
  fs.writeFileSync(path.join(dir, `${today}.jsonl`), ledgerLine({ t: iso(T0), session: 's1', key: 'm1' }));
  fs.writeFileSync(path.join(root, 's1.jsonl'), `${rec('m0', iso(T0 - 60_000))}\n${rec('m1', iso(T0))}\n`);
  const l = new RequestLedger({ dir, now: () => T0 + 40 * DAY, keepDays: 30, flushMs: 10_000 });
  l.imports.pause = async () => {};
  l.record({ harness: 'codex', outcome: 'ok' });
  await l.flush();
  assert.equal(fs.existsSync(path.join(dir, `${today}.jsonl`)), false, 'folded and deleted');
  await l.importOutside(roots(root));
  assert.equal(
    total((await l.summary()).rows.filter((r: any) => r.harness === 'claude')),
    1,
    'm1 once, from the rollup; m0 left out by its session',
  );
  // a rollup that cannot be read: the import is left out rather than counted against nothing
  fs.writeFileSync(path.join(dir, 'days.json'), '{');
  const broken: any = await quiet(() => l.summary());
  assert.equal(broken.imported, 'unreadable');
  assert.equal(broken.rollup, 'unreadable');
});

test('the import is asked for over IPC with Claude Code’s own transcripts folder and the user’s CODEX_HOME', async () => {
  const { register } = require('../electron/app/ipc/ledger.cjs');
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (ch: string, fn: any) => handlers.set(ch, fn) };
  const asked: unknown[] = [];
  let ledger: any = { store: { importOutside: async (r: unknown) => (asked.push(r), found(1, 1)) } };
  const given = { claude: '/home/me/.claude/projects', codex: ['/home/me/.codex/sessions'] };
  register(
    ipcMain,
    { shell: { openPath: async () => '' } },
    () => ledger,
    () => given,
  );
  assert.deepEqual(await handlers.get('ledger:importOutside')!(), found(1, 1));
  assert.deepEqual(asked, [given]);
  ledger = null;
  assert.deepEqual(await handlers.get('ledger:importOutside')!(), { refused: 'not-started' });
  const { projectsRoot, sharedRoot } = require('../electron/platform/claudeHome.cjs');
  const { userCodexHome, rolloutFolders } = require('../electron/harness/codexRollout.cjs');
  assert.equal(projectsRoot(), path.join(sharedRoot(), 'projects'));
  const main = new Map<string, (...a: any[]) => any>();
  register({ handle: (ch: string, fn: any) => main.set(ch, fn) }, { shell: { openPath: async () => '' } }, () => ({
    store: { importOutside: async (r: unknown) => r },
  }));
  assert.deepEqual(await main.get('ledger:importOutside')!(), { claude: projectsRoot(), codex: rolloutFolders(userCodexHome()) });
});

test('a session’s total is the same while its day is raw and once it is folded; a request run elsewhere in it is left out', async () => {
  const dir = tmp();
  const root = tmp();
  const today = dayOf(T0);
  fs.writeFileSync(
    path.join(dir, `${today}.jsonl`),
    ledgerLine({ t: iso(T0), session: 's1', key: 'm1' }) +
      ledgerLine({ t: iso(T0 + 120_000), session: 's1', key: 'm3' }) +
      // a stop after it carries no usage: the session's span still ends at m3
      `${JSON.stringify({ v: 1, harness: 'claude', outcome: 'interrupted', t: iso(T0 + 600_000), session: 's1' })}\n`,
  );
  // m2 ran in the terminal while MoPilot had the session open; m4 after MoPilot's last request
  const lines = [rec('m1', iso(T0)), rec('m2', iso(T0 + 60_000)), rec('m3', iso(T0 + 120_000)), rec('m4', iso(T0 + 300_000))];
  fs.writeFileSync(path.join(root, 's1.jsonl'), `${lines.join('\n')}\n`);
  const raw = new RequestLedger({ dir, now: () => T0 + 900_000 });
  raw.imports.pause = async () => {};
  await raw.importOutside(roots(root));
  assert.equal(total((await raw.summary()).rows), 3, 'm1 and m3 from the ledger, m4 from the import; m2 inside the session is left out');
  const folded = new RequestLedger({ dir, now: () => T0 + 40 * DAY, keepDays: 30, flushMs: 10_000 });
  folded.record({ harness: 'codex', outcome: 'ok' });
  await folded.flush();
  assert.equal(fs.existsSync(path.join(dir, `${today}.jsonl`)), false);
  assert.equal(total((await folded.summary({ from: today, to: today })).rows), 3, 'the same once folded');
});

test('a span is kept by the local day it ended, as the rollup keeps its days: east of UTC too', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const dir = tmp();
    const rollup = new LedgerRollup({ dir: () => dir, oldest: () => '2026-11-01', dayOf });
    const k = identityKey('claude', 's1');
    // 04:00 on Nov 1 in Shanghai is Oct 31 in UTC
    await rollup.fold({}, { [k]: { first: '2026-10-31T19:00:00.000Z', last: '2026-10-31T20:00:00.000Z' } });
    assert.deepEqual({ ...(await rollup.load()).live }, { [k]: { first: '2026-10-31T19:00:00.000Z', last: '2026-10-31T20:00:00.000Z' } });
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('an import store set aside as unreadable says the total may be low for the days up to then', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'imported.json'), JSON.stringify({ v: 9, files: {} }));
  const l = new RequestLedger({ dir, now: () => T0 });
  l.imports.pause = async () => {};
  await l.importOutside(roots(tmp()));
  assert.equal((await l.summary()).imported, 'unreadable');
  assert.equal((await l.summary({ from: '2999-01-01' })).imported, 'ok', 'a range after the day it was set aside is whole');
  await assert.rejects(
    fresh(dir, {
      fsp: { ...fs.promises, readdir: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) },
    }).setAside(),
    /denied/,
  );
  assert.equal(await fresh(path.join(dir, 'not-yet')).setAside(), null);
});

test('a transcript line longer than the reader takes stops the read, so the transcript is not taken as read', async () => {
  const { fileLines } = require('../electron/ledger/backfill.cjs');
  const dir = tmp();
  const file = path.join(dir, 'long.jsonl');
  fs.writeFileSync(file, `${rec('a', '2026-11-22T09:00:00.000Z')}\n${'x'.repeat(5000)}\n${rec('b', '2026-11-22T09:01:00.000Z')}\n`);
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const line of fileLines(file, 1000)) seen.push(line.slice(0, 20));
    })(),
    (e: any) => e.code === 'ETOOLONG',
  );
  assert.equal(seen.length, 1);
  const lines: string[] = [];
  for await (const line of fileLines(file)) lines.push(line);
  assert.equal(lines.length, 3, 'within the framer’s own limit');
});

test('a Host’s Claude Code session is the same session; of a duplicated id, the copy with the most output counts', async () => {
  const live = {
    keys: new Set<string>(),
    spans: addSpans(new Map(), liveSpans([{ harness: 'host-claude', session: 'h1', t: '2026-11-22T09:00:00.000Z', outcome: 'ok', in: 1 }])),
  };
  assert.equal(recorded(live, ['x', 'h1', '2026-11-22T08:59:00.000Z', null, 1, 0, 0, 0]), true);
  const dir = tmp();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a-subagent.jsonl'), `${rec('m', '2026-11-22T09:00:00.000Z', { out: 3 })}\n`);
  fs.writeFileSync(path.join(root, 'b-main.jsonl'), `${rec('m', '2026-11-22T09:00:00.000Z', { out: 5397 })}\n`);
  const imp = fresh(dir);
  await imp.importOutside(roots(root), on);
  const rows = await imp.rows(ALL, none);
  assert.deepEqual(
    rows.map((r: any) => [r.requests, r.out]),
    [[1, 5397]],
  );
});

test('an imported request with no model is counted under no model; an unreadable day outside the range is not named', async () => {
  const dir = tmp();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.jsonl'), `${rec('nm', '2026-11-22T09:00:00.000Z', { model: '' })}\n`);
  const imp = fresh(dir);
  await imp.importOutside(roots(root), on);
  assert.deepEqual(
    (await imp.rows(ALL, none)).map((r: any) => [r.model, r.requests]),
    [[null, 1]],
  );
  const ledger = tmp();
  const old = dayOf(T0 - 5 * DAY);
  fs.writeFileSync(path.join(ledger, `${old}.jsonl`), ledgerLine({ t: iso(T0 - 5 * DAY) }));
  const fsp = {
    ...fs.promises,
    readFile: async (p: string, enc: any) =>
      p.endsWith(`${old}.jsonl`) ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : fs.promises.readFile(p, enc),
  };
  const s: any = await quiet(() => new RequestLedger({ dir: ledger, now: () => T0, fsp }).summary({ from: dayOf(T0), to: dayOf(T0) }));
  assert.deepEqual(s.unread, [], 'a day the range does not reach is not said to be missing from it');
});
