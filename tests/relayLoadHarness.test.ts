// The relay load harness (scripts/relay-load): its frame integrity check, the books that call a frame lost, duplicated or reordered, the latency report, the sampler and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HEADER_BYTES, makeBox, makeNonce, readBox, frameText } from '../scripts/relay-load/payload.mjs';
import { Ledger } from '../scripts/relay-load/ledger.mjs';
import { Latency, cpuSeconds, formatReport, spread } from '../scripts/relay-load/stats.mjs';
import { Sampler } from '../scripts/relay-load/sampler.mjs';
import { DEFAULTS } from '../scripts/relay-load/run.mjs';
import { USAGE, parseOptions, run, verdict } from '../scripts/relay-load/cli.mjs';

test('a box names its pair, direction, counter and time, and any changed byte makes it not intact', () => {
  const box = makeBox(7, 'p2m', 42, 100, 1234.5);
  assert.deepEqual(readBox(box), { pair: 7, dir: 'p2m', ctr: 42, sentAt: 1234.5, intact: true });
  assert.equal(makeBox(7, 'm2p', 1, 3, 0).length, HEADER_BYTES);
  const bad = Buffer.from(box);
  bad[HEADER_BYTES + 5] ^= 1;
  assert.equal(readBox(bad)?.intact, false);
  // every part of the header is covered: the send time, the counter, the pair and the length; and a truncated box is not intact
  for (const at of [4, 8, 16, 23, 24, 27, 28]) {
    const flipped = Buffer.from(box);
    flipped[at] ^= 1;
    assert.equal(readBox(flipped)?.intact, false, `byte ${at}`);
  }
  assert.equal(readBox(box.subarray(0, 60))?.intact, false);
  assert.equal(readBox(Buffer.concat([box, Buffer.from([1])]))?.intact, false);
  assert.equal(readBox(Buffer.alloc(4)), null);
  assert.equal(readBox(Buffer.alloc(HEADER_BYTES)), null);
  const noDir = Buffer.from(box);
  noDir.writeUInt8(9, 12);
  assert.equal(readBox(noDir), null);
  assert.equal(makeNonce(3, 'p2m', 9).length, 24);
  assert.notDeepEqual(makeNonce(3, 'p2m', 9), makeNonce(3, 'm2p', 9));
  const msg = JSON.parse(frameText('p_x00000001', 2, 'm2p', 5, 50, 1));
  assert.equal(msg.t, 'frame');
  assert.equal(readBox(Buffer.from(msg.box, 'base64'))?.ctr, 5);
});

test('the ledger calls an accepted frame nobody received lost, and tells duplicates, reorders and redeliveries apart', () => {
  const l = new Ledger();
  l.created();
  l.accepted('0:m2p', 1);
  l.accepted('0:m2p', 1);
  l.accepted('0:m2p', 2);
  assert.equal(l.lost(), 2);
  assert.deepEqual(l.unreceived(), ['0:m2p:1', '0:m2p:2']);
  assert.equal(l.settled(), false);
  // a frame the relay still holds is undelivered, one it dropped is lost
  assert.deepEqual(
    { lost: l.report(new Set(['0:m2p:2'])).lost, undelivered: l.report(new Set(['0:m2p:2'])).undelivered },
    { lost: 1, undelivered: 1 },
  );
  assert.equal(l.report().accepted, 2);
  assert.equal(l.received('0:m2p', 1, 1), 'new');
  assert.equal(l.received('0:m2p', 1, 1), 'duplicated');
  assert.equal(l.received('0:m2p', 3, 1), 'new');
  assert.equal(l.received('0:m2p', 2, 1), 'reordered');
  assert.equal(l.received('0:m2p', 1, 2), 'redelivered');
  assert.equal(l.received('0:m2p', 2, 2), 'redelivered');
  // a repeat that is not adjacent is a duplicate too, not a reorder
  assert.equal(l.received('0:m2p', 5, 3), 'new');
  assert.equal(l.received('0:m2p', 6, 3), 'new');
  assert.equal(l.received('0:m2p', 5, 3), 'duplicated');
  l.corrupt();
  l.phantom();
  // the reordered frame did arrive, so it is not lost
  assert.equal(l.lost(), 0);
  assert.deepEqual(l.report(), {
    created: 1,
    accepted: 2,
    received: 5,
    redelivered: 2,
    duplicated: 2,
    reordered: 1,
    corrupt: 1,
    phantom: 1,
    lost: 0,
    undelivered: 0,
  });
});

test('latency percentiles, spreads, cpu times and the printed report', () => {
  const lat = new Latency();
  assert.deepEqual(lat.summary(), { count: 0 });
  for (const ms of [1, 2, 3, 4, 100]) lat.record(ms);
  const s: any = lat.summary();
  assert.equal(s.count, 5);
  assert.ok(s.p50 >= 3 && s.p50 < 4.1 && s.p99 >= 99 && s.max >= 99);
  assert.equal(spread([]), null);
  assert.deepEqual(spread([1, 5, 3]), { mean: 3, max: 5 });
  assert.equal(cpuSeconds('1:02.50'), 62.5);
  assert.equal(cpuSeconds('1:00:01.50'), 3601.5);
  const base: any = {
    config: { pairs: 2, sockets: 4, seconds: 3 },
    mode: 'x',
    ledger: {
      created: 1,
      accepted: 1,
      received: 1,
      lost: 0,
      undelivered: 0,
      duplicated: 0,
      reordered: 0,
      corrupt: 0,
      phantom: 0,
      redelivered: 0,
    },
    client: { resends: 0, reconnects: 0, closes: {}, errors: {}, unaccepted: 0 },
    latency: { steady: { count: 0 }, all: s },
    chaos: { socketsKilled: 0, relayRestarts: 0 },
    samples: {},
    mailboxLeft: 0,
  };
  const bare = formatReport(base);
  assert.match(bare, /no samples/);
  assert.doesNotMatch(bare, /rss|mailbox {2}depth|closes {3}by code|\/healthz|WARNING/);
  assert.match(bare, /never accepted by the relay.*: 0/);
  const full = formatReport({
    ...base,
    relayCloseCodes: { 1006: 2 },
    samples: {
      rssMb: { mean: 100, max: 120 },
      cpuPct: { mean: 10, max: 30 },
      mailboxDepth: { mean: 1, max: 4 },
      healthMs: { mean: 2, max: 9 },
      harnessLagMs: { mean: 1, max: 3 },
    },
  });
  assert.match(full, /rss mean 100 MB {2}max 120 MB {2}cpu mean 10%/);
  assert.match(full, /depth mean 1 {2}max 4/);
  assert.match(full, /"1006":2/);
  assert.match(
    formatReport({ ...base, samples: { rssMb: { mean: 1, max: 1 }, rssTrend: { startMb: 90.5, endMb: 95.25 } } }),
    /\(first tenth 90\.5 MB, last tenth 95\.3 MB\)/,
  );
  assert.match(formatReport({ ...base, relayEvents: { slow_consumer: 3 } }), /other relay log events: {"slow_consumer":3}/);
  assert.doesNotMatch(formatReport({ ...base, relayEvents: {} }), /other relay log events/);
  assert.match(formatReport({ ...base, relayErrorSamples: ['boom'] }), /first relay errors: \["boom"\]/);
  assert.match(formatReport({ ...base, mailboxKnown: false }), /WARNING.*mailbox could not be read/);
  assert.match(formatReport({ ...base, samples: { healthFailures: 4 } }), /failed or timed out 4/);
  assert.match(
    formatReport({ ...base, samples: { rssMb: { mean: 1, max: 1 }, healthMs: { mean: 1, max: 1 } } }),
    /cpu mean 0%.*lag p99 max 0 ms/s,
  );
});

test('the sampler records memory, cpu, health round trip, depth and sockets, and survives a missing process or a dead health check', async () => {
  const procs = [{ rssMb: 10, cpu: 1 }, { rssMb: 12, cpu: 1.5 }, null];
  let i = 0;
  const up = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = http
      .createServer((_: any, res: any) => res.end('ok'))
      .listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
  let depthFails = false;
  const sampler = new Sampler({
    pid: () => (i < 3 ? 123 : null),
    healthUrl: `http://127.0.0.1:${up.port}/healthz`,
    depth: async () => {
      if (depthFails) throw new Error('db down');
      return 7;
    },
    sockets: () => 4,
    intervalMs: 5,
    readProcess: async () => procs[i++] as any,
  });
  await sampler.sample();
  await new Promise((r) => setTimeout(r, 20));
  await sampler.sample();
  up.close();
  depthFails = true;
  await sampler.sample();
  const rows = sampler.rows;
  assert.equal(rows[0].rssMb, 10);
  assert.ok((rows[0].healthMs as number) >= 0);
  assert.equal(rows[2].healthFailed, true);
  assert.equal(rows[2].healthMs, undefined);
  assert.equal(rows[0].cpuPct, undefined);
  assert.ok((rows[1].cpuPct as number) > 0);
  assert.equal(rows[2].rssMb, undefined);
  assert.equal(rows[0].depth, 7);
  assert.equal(rows[2].depth, undefined);
  assert.equal(rows[2].depthError, 'db down');
  assert.equal(rows[2].sockets, 4);
  const sum = sampler.summary();
  assert.equal(sum.rssMb?.max, 12);
  assert.equal(sum.seconds, 3);
  assert.equal(sum.depthErrors, 1);
  assert.equal(sum.rssTrend, null, 'three samples are too few for a trend');
  assert.equal(sum.healthFailures, 1);
  // the trend compares the start and the end of a run: the first and last tenth of the samples
  const growing = new Sampler({
    pid: () => 1,
    healthUrl: 'http://127.0.0.1:1/',
    depth: async () => 0,
    sockets: () => 0,
    readProcess: async () => null,
  });
  growing.rows = Array.from({ length: 30 }, (_, i) => ({ rssMb: 100 + i, sockets: 0, lagMs: 0 }));
  assert.deepEqual(growing.trend(), { startMb: 101, endMb: 128 });
  growing.rows.push({ sockets: 0, lagMs: 0 });
  assert.equal(growing.trend()?.endMb, 128, 'a sample without a reading is left out');
  growing.rows = growing.rows.slice(0, 20);
  assert.equal(growing.trend(), null, 'twenty samples give a tenth of two: too few');
  // a restarted relay is another process: its cpu time starts over, so no cpu share is computed across the restart
  let pid = 10;
  const times = [
    { rssMb: 1, cpu: 500 },
    { rssMb: 1, cpu: 1 },
    { rssMb: 1, cpu: 2 },
  ];
  let reads = 0;
  const restarted = new Sampler({
    pid: () => pid,
    healthUrl: 'http://127.0.0.1:1/',
    depth: async () => 0,
    sockets: () => 0,
    readProcess: async () => times[reads++] as any,
  });
  await restarted.sample();
  pid = 11;
  await restarted.sample();
  await new Promise((r) => setTimeout(r, 30));
  await restarted.sample();
  assert.equal(restarted.rows[1].cpuPct, undefined);
  assert.ok((restarted.rows[2].cpuPct as number) > 0);
  // the timer skips a tick while a sample is still running
  const ticking = new Sampler({ pid: () => null, healthUrl: 'http://127.0.0.1:1/', depth: async () => 0, sockets: () => 0, intervalMs: 5 });
  ticking.begin();
  ticking.busy = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ticking.rows.length, 0);
  ticking.busy = false;
  await new Promise((r) => setTimeout(r, 40));
  ticking.end();
  assert.ok(ticking.rows.length >= 1);
  // the real ps reads this process
  const real = new Sampler({ pid: () => process.pid, healthUrl: 'http://127.0.0.1:1/', depth: async () => 0, sockets: () => 0 });
  await real.sample();
  assert.ok((real.rows[0].rssMb as number) > 1);
  const gone = new Sampler({ pid: () => 2 ** 22 + 7, healthUrl: 'http://127.0.0.1:1/', depth: async () => 0, sockets: () => 0 });
  await gone.sample();
  assert.equal(gone.rows[0].rssMb, undefined);
});

test('the command line parses every option, prints usage, writes the JSON report and exits non-zero on a loss', async () => {
  assert.equal(parseOptions([]).options.pairs, 500);
  assert.equal(parseOptions([]).options.burst, DEFAULTS.burst);
  const o = parseOptions([
    ...[
      '--pairs',
      '9',
      '--seconds',
      '5',
      '--mac-rate',
      '2',
      '--phone-rate',
      '1',
      '--burst',
      '3:4:5',
      '--restarts',
      '1',
      '--signal',
      'SIGTERM',
    ],
    ...[
      '--restart-down',
      '10',
      '--kill-rate',
      '0',
      '--database',
      'postgres://u',
      '--allow-remote-database',
      '--env',
      'A=b=c',
      '--env',
      'D=e',
      '--drain',
      '7',
      '--json',
      'x.json',
    ],
  ]);
  assert.deepEqual(o.options, {
    pairs: 9,
    seconds: 5,
    macRate: 2,
    phoneRate: 1,
    burst: { at: 0.3, pairs: 3, frames: 4, size: 5 },
    restarts: 1,
    restartSignal: 'SIGTERM',
    restartDownMs: 10,
    killRate: 0,
    resetRate: 0,
    database: 'postgres://u',
    allowRemoteDatabase: true,
    drainSeconds: 7,
    relayEnv: { A: 'b=c', D: 'e' },
  });
  assert.equal(o.json, 'x.json');
  assert.equal(parseOptions(['--burst', 'off']).options.burst, null);
  assert.throws(() => parseOptions(['--env', 'NOEQUALS']), /--env needs KEY=VALUE/);
  assert.throws(() => parseOptions(['--env', '=x']), /--env needs KEY=VALUE/);
  assert.equal(parseOptions(['--help']).help, true);
  assert.equal(parseOptions([]).options.allowRemoteDatabase, false);
  // a mistyped number is an error, not a run that sends nothing and passes
  for (const bad of [
    ['--pairs', 'abc'],
    ['--pairs', '0'],
    ['--pairs', '1.5'],
    ['--pairs', ''],
    ['--seconds=-3'],
    ['--mac-rate', 'x'],
    ['--restarts', '0.5'],
    ['--drain', '0'],
    ['--burst', '3:4'],
    ['--burst', 'a:b:c'],
  ])
    assert.throws(
      () => parseOptions(bad),
      /--(pairs|seconds|mac-rate|restarts|drain|burst) must be (a whole number|a number|pairs:frames:bytes)/,
      bad.join(' '),
    );
  assert.equal(parseOptions(['--mac-rate', '0', '--phone-rate', '0', '--restarts', '0']).options.macRate, 0);

  const lines: string[] = [];
  await run(['--help'], { out: (t) => lines.push(t) });
  assert.deepEqual(lines, [USAGE]);

  const good = {
    config: { pairs: 1, sockets: 2, seconds: 1 },
    mode: 'm',
    drained: true,
    mailboxLeft: 0,
    ledger: {
      created: 1,
      accepted: 1,
      received: 1,
      lost: 0,
      undelivered: 0,
      duplicated: 0,
      reordered: 0,
      corrupt: 0,
      phantom: 0,
      redelivered: 0,
    },
    client: { resends: 0, reconnects: 0, closes: {}, errors: {}, unaccepted: 0 },
    latency: { steady: { count: 0 }, all: { count: 0 } },
    chaos: { socketsKilled: 0, relayRestarts: 0 },
    samples: {},
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const out = path.join(dir, 'r.json');
  const seen: string[] = [];
  const before = process.exitCode;
  await run(['--json', out], { out: (t) => seen.push(t), run: (async (opts: any, d: any) => (d.log('hi'), good)) as any });
  assert.equal(process.exitCode, 0);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).mode, 'm');
  assert.ok(seen.includes('[relay-load] hi'));
  await run([], { out: () => undefined, run: (async () => ({ ...good, ledger: { ...good.ledger, lost: 1 } })) as any });
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
  for (const bad of [
    { ledger: { ...good.ledger, undelivered: 1 } },
    { ledger: { ...good.ledger, duplicated: 1 } },
    { ledger: { ...good.ledger, reordered: 1 } },
    { ledger: { ...good.ledger, corrupt: 1 } },
    { ledger: { ...good.ledger, phantom: 1 } },
    { drained: false },
    { mailboxLeft: 2 },
    { mailboxKnown: false },
    { ledger: { ...good.ledger, created: 0 } },
  ])
    assert.equal(verdict({ ...good, ...bad }), 1);
  assert.equal(verdict(good), 0);
  assert.match(
    execFileSync(process.execPath, [new URL('../scripts/relay-load.mjs', import.meta.url).pathname, '--help']).toString(),
    /Usage: node scripts\/relay-load.mjs/,
  );
});
