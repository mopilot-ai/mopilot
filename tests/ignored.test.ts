// electron/ignored.cjs: the shared record of deliberately ignored errors (context, scrubbed message, time),
// bounded, and logged with console.debug.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { noteIgnored, ignoring, messageOf, recentIgnored, clearIgnored, IGNORED_LIMIT } = require('../electron/ignored.cjs');

afterEach(() => clearIgnored());

test('noteIgnored records the context, the scrubbed message and the time, and logs it', () => {
  const debug = mock.method(console, 'debug', () => {});
  try {
    noteIgnored('remove the temp file', new Error(`ENOENT: ${os.homedir()}/a sk-ant-api03-supersecretvalue1234567890`));
    const t = new TypeError('not a function');
    noteIgnored('call the listener', t);
    noteIgnored('read the port', 'closed');
    noteIgnored('read nothing', undefined);
    const got = recentIgnored();
    assert.deepEqual(
      got.map((e: any) => [e.context, e.message]),
      [
        ['remove the temp file', 'ENOENT: ~/a [REDACTED:anthropic-key]'],
        ['call the listener', 'TypeError: not a function'],
        ['read the port', 'closed'],
        ['read nothing', 'undefined'],
      ],
    );
    assert.ok(!Number.isNaN(Date.parse(got[0].at)));
    assert.equal(debug.mock.calls[1].arguments[0], '[ignored] call the listener: TypeError: not a function');
    // a copy: changing it does not change the record
    got[0].context = 'changed';
    assert.equal(recentIgnored()[0].context, 'remove the temp file');
  } finally {
    debug.mock.restore();
  }
});

test('noteIgnored leaves out the expected error codes and records any other error', () => {
  const debug = mock.method(console, 'debug', () => {});
  try {
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    noteIgnored('read the saved list', missing, ['ENOENT']);
    assert.deepEqual(recentIgnored(), []);
    noteIgnored('read the saved list', Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }), ['ENOENT']);
    noteIgnored('read the saved list', new SyntaxError('Unexpected token'), ['ENOENT']);
    noteIgnored('read the saved list', null, ['ENOENT']);
    assert.deepEqual(
      recentIgnored().map((e: any) => e.message),
      ['EACCES: denied', 'SyntaxError: Unexpected token', 'null'],
    );
    assert.equal(debug.mock.calls.length, 3);
  } finally {
    debug.mock.restore();
  }
});

test('noteIgnored folds repeats into a count, drops URL queries and bounds long text', () => {
  const debug = mock.method(console, 'debug', () => {});
  try {
    noteIgnored('mask a frame', new Error('detached'));
    noteIgnored('save the list', new Error('EACCES'));
    noteIgnored('mask a frame', new Error('detached'));
    assert.deepEqual(
      recentIgnored().map((e: any) => [e.context, e.count]),
      [
        ['save the list', 1],
        ['mask a frame', 2],
      ],
    );
    noteIgnored('navigate', new Error('net::ERR_ABORTED at https://site.test/cb?code=secret123&state=x#frag (and more)'));
    assert.equal(recentIgnored().at(-1).message, 'net::ERR_ABORTED at https://site.test/cb?… (and more)');
    noteIgnored('x'.repeat(600), new Error('y'.repeat(600)));
    const long = recentIgnored().at(-1);
    assert.equal(long.context, `${'x'.repeat(500)}…`);
    assert.equal(long.message, `${'y'.repeat(500)}…`);
  } finally {
    debug.mock.restore();
  }
});

test('noteIgnored keeps only the most recent entries', () => {
  const debug = mock.method(console, 'debug', () => {});
  try {
    for (let i = 0; i < IGNORED_LIMIT + 5; i++) noteIgnored(`step ${i}`, new Error('e'));
    const got = recentIgnored();
    assert.equal(got.length, IGNORED_LIMIT);
    assert.equal(got[0].context, 'step 5');
    assert.equal(got.at(-1).context, `step ${IGNORED_LIMIT + 4}`);
  } finally {
    debug.mock.restore();
  }
});

test('ignoring is noteIgnored as a rejection handler, expected codes included', async () => {
  const debug = mock.method(console, 'debug', () => {});
  try {
    await Promise.reject(new Error('offline')).catch(ignoring('refresh the switches'));
    await Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })).catch(ignoring('read a file', ['ENOENT']));
  } finally {
    debug.mock.restore();
  }
  assert.deepEqual(
    recentIgnored().map((e: { context: string; message: string }) => [e.context, e.message]),
    [['refresh the switches', 'offline']],
  );
});

test('messageOf: an Error gives its message, anything else thrown is a string', () => {
  assert.equal(messageOf(new TypeError('bad')), 'bad');
  assert.equal(messageOf('closed'), 'closed');
  assert.equal(messageOf(undefined), 'undefined');
});

test('a long error without spaces is cleaned in linear time: only a bounded prefix is scanned', async () => {
  // the URL-query strip scans from each URL to the next space: on megabytes without one (a blob, many URLs) that was
  // quadratic. A worker bounds the wall time: linear finishes in well under a second, quadratic took minutes.
  const { Worker } = await import('node:worker_threads');
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { noteIgnored, recentIgnored } = require(workerData.ignored);
    console.debug = () => {};
    for (const unit of ['a://', 'x', 'a.'])
      noteIgnored('a long error', unit.repeat(Math.ceil(1_000_000 / unit.length)));
    parentPort.postMessage(recentIgnored().map((e) => e.message.length));
  `;
  const w = new Worker(code, { eval: true, workerData: { ignored: require.resolve('../electron/ignored.cjs') } });
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    new Promise((resolve) => w.once('message', resolve)),
    new Promise((resolve) => (timer = setTimeout(resolve, 30_000, 'timed out'))),
  ]);
  clearTimeout(timer);
  await w.terminate();
  // each kept message is cut to the limit, with its "…"
  assert.deepEqual(outcome, [501, 501, 501]);
  // a query on a URL is still dropped
  noteIgnored('fetch', 'GET https://x.test/a?code=secret failed');
  assert.equal(recentIgnored().at(-1)!.message, 'GET https://x.test/a?… failed');
});
