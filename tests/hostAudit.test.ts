// The Host's audit writer and reader (host/src/audit.mjs, shared/host/audit.mjs, plan W3): lines in decision order, metadata only, resumed across a restart, pruned by retention on a mocked clock, read by sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAudit } from '../host/src/audit.mjs';
// @ts-ignore: plain ESM without declarations
import { whatOf, hashLine, auditParsers, AUDIT_KINDS, SUMMARY_MAX } from '../shared/host/audit.mjs';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const day = 86_400_000;
const setup = (t: any, o: any = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: T0 };
  const reports: string[] = [];
  const audit = createAudit({
    dir: path.join(dir, 'audit'),
    now: () => clock.now,
    generation: () => 'gen1',
    report: (m: string) => reports.push(m),
    ...o,
  });
  return { dir: path.join(dir, 'audit'), clock, audit, reports };
};
const files = (dir: string) => fs.readdirSync(dir).sort();

test('a line names who and what kind, in decision order, with the policy generation', (t) => {
  const w = setup(t);
  const by = { fingerprint: 'f'.repeat(64), name: 'Pocket iPhone', kind: 'phone' };
  w.audit.governed({
    kind: 'approval.answered',
    chat: 'c1',
    turn: 't1',
    harness: 'claude',
    by,
    org: 'org1',
    what: { tool: 'execute', decision: 'allow', waitedMs: 41000 },
  });
  w.audit.note({ kind: 'chat.message', chat: 'c1' });
  const { lines } = w.audit.read();
  assert.deepEqual(
    lines.map((l: any) => [l.seq, l.kind]),
    [
      [1, 'approval.answered'],
      [2, 'chat.message'],
    ],
  );
  assert.deepEqual(lines[0].by, by);
  assert.deepEqual(lines[0].what, { tool: 'execute', decision: 'allow', waitedMs: 41000 });
  assert.equal(lines[0].policy, 'gen1');
  assert.equal(lines[0].prev, null);
  assert.equal(lines[1].prev, hashLine(JSON.stringify(lines[0])));
  assert.equal(fs.statSync(path.join(w.dir, '2026-11-10.jsonl')).mode & 0o777, 0o600);
  assert.ok(AUDIT_KINDS.includes(lines[0].kind));
});

test('a line carries no text beyond its allowed keys; a summary only when the policy asks for full detail', (t) => {
  assert.deepEqual(whatOf({ tool: 'x'.repeat(100), command: 'rm -rf /', text: 'hi', waitedMs: Infinity, ok: true, summary: 's' }, false), {
    tool: 'x'.repeat(64),
  });
  assert.deepEqual(whatOf({ summary: 'y'.repeat(300), key: 'k', outcome: 3, status: false }, true), {
    key: 'k',
    outcome: 3,
    status: false,
    summary: 'y'.repeat(SUMMARY_MAX),
  });
  assert.deepEqual(whatOf({ summary: 4 }, true), {});
  assert.deepEqual(whatOf(undefined, true), {});
  const w = setup(t, { settings: () => ({ detail: 'full' }) });
  w.audit.note({ kind: 'approval.asked', what: { summary: 'git push origin main' } });
  assert.equal(w.audit.read().lines[0].what.summary, 'git push origin main');
});

test('the chain resumes after a restart and continues across days', (t) => {
  const w = setup(t);
  w.audit.note({ kind: 'chat.started' });
  w.clock.now += day;
  w.audit.note({ kind: 'chat.started' });
  assert.deepEqual(files(w.dir), ['2026-11-10.jsonl', '2026-11-11.jsonl']);
  const again = createAudit({ dir: w.dir, now: () => w.clock.now });
  again.note({ kind: 'chat.message' });
  const { lines } = again.read();
  assert.deepEqual(
    lines.map((l: any) => l.seq),
    [1, 2, 3],
  );
  const raw = fs.readFileSync(path.join(w.dir, '2026-11-11.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(raw[1]).prev, hashLine(raw[0]));
});

test('retention removes day files older than the retention, the default being 90 days', (t) => {
  const w = setup(t, { settings: () => ({ retentionDays: 2 }) });
  w.audit.note({ kind: 'chat.started' });
  for (let i = 0; i < 4; i++) {
    w.clock.now += day;
    w.audit.note({ kind: 'chat.started' });
  }
  assert.deepEqual(files(w.dir), ['2026-11-12.jsonl', '2026-11-13.jsonl', '2026-11-14.jsonl']);
  const d = setup(t);
  d.audit.note({ kind: 'chat.started' });
  d.clock.now += 91 * day;
  d.audit.note({ kind: 'chat.started' });
  assert.equal(files(d.dir).length, 1);
});

test('retention that cannot remove a file is reported and the write still lands', (t) => {
  const reports: string[] = [];
  const io = {
    ...fs,
    unlinkSync: () => {
      throw new Error('busy');
    },
  };
  const w = setup(t, { io, report: (m: string) => reports.push(m), settings: () => ({ retentionDays: 1 }) });
  w.audit.note({ kind: 'chat.started' });
  w.clock.now += 5 * day;
  w.audit.note({ kind: 'chat.started' });
  assert.match(reports[0], /old day file/);
  assert.equal(w.audit.read().lines.length, 2);
});

test('read pages by sequence; exportText selects by time', (t) => {
  const w = setup(t);
  for (let i = 0; i < 5; i++) w.audit.note({ kind: 'chat.message', chat: `c${i}` });
  w.clock.now += day;
  w.audit.note({ kind: 'chat.message', chat: 'late' });
  const first = w.audit.read({ limit: 2 });
  assert.deepEqual(
    first.lines.map((l: any) => l.seq),
    [1, 2],
  );
  assert.equal(first.next, 2);
  assert.deepEqual(
    w.audit.read({ after: first.next, limit: 10 }).lines.map((l: any) => l.seq),
    [3, 4, 5, 6],
  );
  assert.deepEqual(w.audit.read({ after: 99 }), { lines: [], next: 99 });
  assert.equal(w.audit.exportText(T0 + day).length, 1);
  assert.equal(w.audit.exportText().length, 6);
  assert.equal(createAudit({ dir: '/nonexistent/x' }).exportText().length, 0);
});

test('a line that cannot be parsed is not served or exported', (t) => {
  const w = setup(t);
  w.audit.note({ kind: 'chat.message' });
  fs.appendFileSync(path.join(w.dir, '2026-11-10.jsonl'), 'garbage\n');
  assert.equal(w.audit.read().lines.length, 1);
  assert.equal(w.audit.exportText().length, 1);
});

test('the wire parser takes a place and a count and refuses the rest', () => {
  const bad = (m: string) => new Error(m);
  const parse = auditParsers(bad)['host.auditRead'];
  assert.deepEqual(parse({}), { after: 0, limit: 100 });
  assert.deepEqual(parse({ after: 5, limit: 10 }), { after: 5, limit: 10 });
  assert.throws(() => parse({ after: -1 }), /place/);
  assert.throws(() => parse({ after: 'x' }), /place/);
  assert.throws(() => parse({ limit: 0 }), /1 to/);
  assert.throws(() => parse({ limit: 501 }), /1 to/);
});

test('a day file that cannot be read is skipped, not fatal', (t) => {
  const w = setup(t);
  w.audit.note({ kind: 'chat.message' });
  const io = {
    ...fs,
    readFileSync: () => {
      throw new Error('EIO');
    },
  };
  const blind = createAudit({ dir: w.dir, now: () => T0, io });
  assert.deepEqual(blind.read(), { lines: [], next: 0 });
  blind.note({ kind: 'chat.message' });
  assert.equal(createAudit({ dir: w.dir }).read().lines.length, 2);
});

test('with no report function a failing write is still absorbed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-quiet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const io = {
    ...fs,
    appendFileSync: () => {
      throw 'plain string';
    },
  };
  const quiet = createAudit({ dir, io });
  assert.equal(quiet.governed({ kind: 'chat.message' }), false);
});
