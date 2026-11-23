// The parity edge scenarios (bench/lib/edgeParity.mjs): their place in the suite, pages, server routes, the stalled report and grades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { SCENARIOS, gradeEdge } = await import('../bench/lib/edge.mjs');
const { edgeHandle } = await import('../bench/lib/edgePages.mjs');
const { PARITY_SCENARIOS, EXPORTS, REPORT_STALL_MS, parityHandle, holdStalled } = await import('../bench/lib/edgeParity.mjs');

const get = (p: string) => edgeHandle({ method: 'GET', url: new URL(p, 'http://localhost:8790'), headers: {}, body: '' }, [], 5);
const scenario = (id: string) => SCENARIOS.find((s: any) => s.id === id)!;

test('PW scenarios are in the suite with their own ids and edge rows', () => {
  for (const s of PARITY_SCENARIOS) assert.equal(scenario(s.id), s);
  assert.deepEqual(
    PARITY_SCENARIOS.map((s: any) => [s.id, s.edge]),
    [
      ['stop-and-duplicate', 'E-P15'],
      ['download-prompt', 'E-P2c'],
    ],
  );
  assert.equal(new Set(SCENARIOS.map((s: any) => s.id)).size, SCENARIOS.length);
});

test('PW pages: the catalog filter and its report link, the two exports, listed on the index', () => {
  const catalog = String(get('/s/stop?run=r1').body);
  assert.match(catalog, /data-scenario="stop-and-duplicate"/);
  assert.match(catalog, /<select id="colour">/);
  assert.match(catalog, /href="\/s\/stop\/report"/);
  assert.match(catalog, /"red":17,"blue":23/);
  const exports = String(get('/s/exports').body);
  assert.match(exports, /href="\/s\/exports\/1"[\s\S]*href="\/s\/exports\/2"/);
  const index = String(get('/').body);
  for (const p of ['/s/stop', '/s/exports']) assert.ok(index.includes(`href="${p}"`), p);
});

test('PW routes: the stalled report names both outcomes; each export is report.csv with its own rows and event', () => {
  const report: any = get('/s/stop/report?run=r1');
  assert.equal(report.status, 200);
  assert.equal(report.stall.ms, REPORT_STALL_MS);
  assert.deepEqual(
    [report.event.event, report.stall.aborted.event, report.stall.complete.event, report.event.run],
    ['report-started', 'report-aborted', 'report-complete', 'r1'],
  );
  for (const n of ['1', '2'] as const) {
    const out: any = get(`/s/exports/${n}?run=r1`);
    assert.equal(out.headers['content-disposition'], 'attachment; filename="report.csv"');
    assert.equal(out.body, EXPORTS[n]);
    assert.equal(out.event.event, `export-${n}`);
  }
  assert.equal(String(EXPORTS[1].split('\n')[3]), '3,Lisbon,4417');
  assert.equal(
    parityHandle(new URL('http://localhost/s/exports/3'), () => ({})),
    null,
  );
  assert.equal(get('/s/exports/3').status, 404);
});

/** A response the stall writes to: headers, flush, end and close, as node's ServerResponse. */
function fakeRes() {
  const res: any = Object.assign(new EventEmitter(), { head: null, flushed: false, ended: null });
  res.writeHead = (status: number, headers: any) => (res.head = { status, headers });
  res.flushHeaders = () => (res.flushed = true);
  res.end = (body: string) => ((res.ended = body), res.emit('close'));
  return res;
}

function fakeTimers() {
  const t: any = { fn: null, ms: 0, cleared: false };
  t.setTimeout = (fn: () => void, ms: number) => ((t.fn = fn), (t.ms = ms), 7);
  t.clearTimeout = (id: number) => (t.cleared = id === 7);
  return t;
}

test('holdStalled: headers at once; a request that goes first is aborted once; one that runs its course completes', () => {
  const out: any = get('/s/stop/report?run=r1');
  const events: any[] = [];
  const res = fakeRes();
  const timers = fakeTimers();
  holdStalled(
    res,
    out,
    (e) => events.push(e),
    timers,
    () => 42,
  );
  assert.deepEqual([res.head.status, res.head.headers['cache-control'], res.flushed, timers.ms], [200, 'no-store', true, REPORT_STALL_MS]);
  res.emit('close');
  res.emit('close');
  assert.deepEqual(
    events.map((e) => [e.event, e.at]),
    [['report-aborted', 42]],
  );
  assert.equal(timers.cleared, true);

  const done: any[] = [];
  const res2 = fakeRes();
  const timers2 = fakeTimers();
  holdStalled(res2, out, (e) => done.push(e), timers2);
  timers2.fn();
  assert.deepEqual(
    done.map((e) => e.event),
    ['report-complete'],
    'the close after the body is no abort',
  );
  assert.match(String(res2.ended), /Full report/);
});

test('PW grades: every event and both counts pass; a report left to finish or a missing count fails', () => {
  const stop = scenario('stop-and-duplicate');
  const all = [{ event: 'report-aborted' }, { event: 'filter-red' }, { event: 'filter-blue' }];
  const answer = 'Red shows 17 items and blue shows 23 items.';
  assert.equal(gradeEdge({ scenario: stop, events: all, turn: { answer }, offered: [] }).verdict, 'PASS');
  assert.deepEqual(gradeEdge({ scenario: stop, events: [...all, { event: 'report-complete' }], turn: { answer }, offered: [] }).why, [
    'page reported report-complete',
  ]);
  assert.deepEqual(gradeEdge({ scenario: stop, events: all.slice(1), turn: { answer: 'Red: 17.' }, offered: [] }).why, [
    'missing page events: report-aborted',
    'answer lacks "23"',
  ]);
  const dl = scenario('download-prompt');
  const both = [{ event: 'export-1' }, { event: 'export-2' }];
  assert.equal(gradeEdge({ scenario: dl, events: both, turn: { answer: 'Row 3: 3,Lisbon,4417' }, offered: [] }).verdict, 'PASS');
  assert.deepEqual(gradeEdge({ scenario: dl, events: both, turn: { answer: 'Row 3: 3,Oslo,9902' }, offered: [] }).why, [
    'answer lacks "4417"',
  ]);
});
