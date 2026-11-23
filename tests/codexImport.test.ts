// listCodexProjects in electron/platform/codexImport.cjs: a short-lived app-server is initialized,
// asked for project/list and stopped, whatever the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listCodexProjects, IMPORT_TIMEOUT_MS } = require('../electron/platform/codexImport.cjs');

function fakeServer(reply: (msg: any, emit: (evt: any) => void) => void, { startThrows }: { startThrows?: unknown } = {}) {
  const sent: any[] = [];
  const s = {
    listeners: new Set<(evt: any) => void>(),
    started: 0,
    stopped: 0,
    start() {
      s.started++;
      if (startThrows !== undefined) throw startThrows;
    },
    stop() {
      s.stopped++;
    },
    send(msg: any) {
      sent.push(msg);
      reply(msg, (evt) => {
        for (const l of [...s.listeners]) l(evt);
      });
    },
    sent,
  };
  return s;
}

test('initializes, sends initialized, lists projects and stops the server', async () => {
  const s = fakeServer((m, emit) => {
    if (m.id === 'imp:1') emit({ kind: 'message', msg: { id: 'imp:1', result: {} } });
    if (m.id === 'imp:2') emit({ kind: 'message', msg: { id: 'imp:2', result: { data: [{ path: '/a' }] } } });
  });
  const data = await listCodexProjects(s, { clientInfo: { name: 'x', title: 'X', version: '1' } });
  assert.deepEqual(data, [{ path: '/a' }]);
  assert.deepEqual(
    s.sent.map((m) => m.method),
    ['initialize', 'initialized', 'project/list'],
  );
  assert.deepEqual(s.sent[0].params.clientInfo, { name: 'x', title: 'X', version: '1' });
  assert.equal(s.stopped, 1);
  assert.equal(s.listeners.size, 0);
});

test('a project/list result without a data array is an empty list; other events are ignored', async () => {
  const s = fakeServer((m, emit) => {
    emit({ kind: 'stderr', text: 'noise' });
    emit({ kind: 'message', msg: { id: 'other' } });
    if (m.id === 'imp:1') emit({ kind: 'message', msg: { id: 'imp:1', result: {} } });
    if (m.id === 'imp:2') {
      emit({ kind: 'message', msg: { id: 'imp:2', result: { data: 'nope' } } });
      emit({ kind: 'exit', code: 0 }); // after finishing: ignored
    }
  });
  assert.deepEqual(await listCodexProjects(s), []);
  assert.equal(s.stopped, 1);
});

test('missing result is an empty list', async () => {
  const s = fakeServer((m, emit) => {
    if (m.id === 'imp:1') emit({ kind: 'message', msg: { id: 'imp:1' } });
    if (m.id === 'imp:2') emit({ kind: 'message', msg: { id: 'imp:2' } });
  });
  assert.deepEqual(await listCodexProjects(s), []);
});

test('initialize and project/list errors reject with the server message or a default', async () => {
  const cases: [any, string][] = [
    [{ id: 'imp:1', error: { message: 'bad init' } }, 'bad init'],
    [{ id: 'imp:1', error: {} }, 'initialize failed'],
  ];
  for (const [msg, expected] of cases) {
    const s = fakeServer((m, emit) => {
      if (m.id === 'imp:1') emit({ kind: 'message', msg });
    });
    await assert.rejects(listCodexProjects(s), { message: expected });
    assert.equal(s.stopped, 1);
  }
  for (const [error, expected] of [
    [{ message: 'no list' }, 'no list'],
    [{}, 'project/list failed'],
  ] as const) {
    const s = fakeServer((m, emit) => {
      if (m.id === 'imp:1') emit({ kind: 'message', msg: { id: 'imp:1', result: {} } });
      if (m.id === 'imp:2') emit({ kind: 'message', msg: { id: 'imp:2', error } });
    });
    await assert.rejects(listCodexProjects(s), { message: expected });
  }
});

test('exit rejects with the code or signal and the stderr tail', async () => {
  let s = fakeServer((_m, emit) => emit({ kind: 'exit', code: 2, stderr: '  boom\n' }));
  await assert.rejects(listCodexProjects(s), { message: 'Codex app-server exited (2): boom' });
  s = fakeServer((_m, emit) => emit({ kind: 'exit', code: null, signal: 'SIGKILL' }));
  await assert.rejects(listCodexProjects(s), { message: 'Codex app-server exited (SIGKILL)' });
});

test('error events reject with the error or a default', async () => {
  let s = fakeServer((_m, emit) => emit({ kind: 'error', error: 'ENOENT codex' }));
  await assert.rejects(listCodexProjects(s), { message: 'ENOENT codex' });
  s = fakeServer((_m, emit) => emit({ kind: 'error' }));
  await assert.rejects(listCodexProjects(s), { message: 'Codex failed to start' });
});

test('a throwing start rejects (wrapping non-Errors) and stops the server', async () => {
  const err = new Error('spawn failed');
  let s = fakeServer(() => {}, { startThrows: err });
  await assert.rejects(listCodexProjects(s), (e) => e === err);
  assert.equal(s.stopped, 1);
  s = fakeServer(() => {}, { startThrows: 'plain' });
  await assert.rejects(listCodexProjects(s), { message: 'plain' });
});

test('a start that reports an error and then throws settles once, with the first error', async () => {
  const s = fakeServer(() => {});
  s.start = () => {
    for (const l of [...s.listeners]) l({ kind: 'error', error: 'first' });
    throw new Error('second');
  };
  await assert.rejects(listCodexProjects(s), { message: 'first' });
  assert.equal(s.stopped, 1);
});

test('no answer in time rejects; the default timeout is 20s', async () => {
  assert.equal(IMPORT_TIMEOUT_MS, 20000);
  const s = fakeServer(() => {});
  await assert.rejects(listCodexProjects(s, { timeoutMs: 5 }), { message: 'Codex did not answer in time' });
  assert.equal(s.stopped, 1);
});
