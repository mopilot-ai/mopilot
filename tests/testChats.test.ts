// A test run's chats on the user's Mac (#1724): electron/platform/testChats.cjs (where a test instance on the real home
// puts projectless chats), the projectless-folder IPC that uses it, and scripts/test-chats.mjs (a run's project folder,
// and its cleanup over the dev instance's debugging port).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { testRunFolder, testChatsRoot, accountHome, TEST_CHATS_ROOT, RUN_TAG } = require('../electron/platform/testChats.cjs');
import { spawnSync } from 'node:child_process';
const tc = await import('../scripts/test-chats.mjs');

test('a test instance on the real home puts its chats in its run folder; E2E (a scratch HOME) and the user’s own instance do not', () => {
  const real = { home: '/Users/me', realHome: () => '/Users/me', pid: 42, root: '/r' };
  assert.equal(testRunFolder({ ...real, env: { SAGE_E2E_BACKGROUND: '1', MOPILOT_TEST_RUN: 't1724' } }), '/r/t1724');
  assert.equal(testRunFolder({ ...real, env: { SAGE_E2E_BACKGROUND: '1' } }), '/r/run-42', 'no tag: one per process');
  assert.equal(testRunFolder({ ...real, env: { SAGE_E2E_BACKGROUND: '1', MOPILOT_TEST_RUN: '../x' } }), '/r/run-42', 'not one folder name');
  assert.equal(testRunFolder({ ...real, env: {} }), null, 'the user’s own instance');
  assert.equal(testRunFolder({ ...real, home: '/tmp/e2e/home', env: { SAGE_E2E_BACKGROUND: '1' } }), null, 'an E2E run');
  assert.equal(
    testRunFolder({ ...real, realHome: () => null, env: { SAGE_E2E_BACKGROUND: '1' } }),
    null,
    'no account home: not a test run',
  );
  assert.equal(typeof testRunFolder(), 'object', 'the process defaults read without throwing');
  assert.equal(typeof accountHome(), 'string');
  const throws = mock.method(os, 'userInfo', () => {
    throw new Error('no passwd entry');
  });
  try {
    assert.equal(accountHome(), null);
  } finally {
    throws.mock.restore();
  }
  assert.ok(path.isAbsolute(TEST_CHATS_ROOT));
  assert.equal(RUN_TAG.test('a'.repeat(65)), false);
});

test('the run folder and the command line', () => {
  assert.equal(tc.runFolder('t1', '/r'), '/r/t1');
  assert.throws(() => tc.runFolder('a/b', '/r'), /not a run tag/);
  assert.throws(() => tc.runFolder(undefined, '/r'), /not a run tag/);
  assert.equal(tc.runFolder('t1'), path.join(TEST_CHATS_ROOT, 't1'));
  assert.deepEqual(tc.parseArgs(['cleanup', '--port', '9524', '--run', 't1', '--dry-run']), {
    command: 'cleanup',
    opts: { port: '9524', run: 't1', 'dry-run': true },
  });
  assert.throws(() => tc.parseArgs(['cleanup', 'stray']), /Unexpected argument: stray/);
});

test('the app window among a debugging port’s targets: the dev renderer, not a pane guest or the mini window', () => {
  const t = (url: string, type = 'page', ws = 'ws://x') => ({ url, type, webSocketDebuggerUrl: ws });
  assert.equal(
    tc.appTarget([t('https://example.com/'), t('http://localhost:5824/#mini'), t('http://localhost:5824/')])?.url,
    'http://localhost:5824/',
  );
  assert.equal(tc.appTarget([t('http://127.0.0.1:5824/?x=1')])?.url, 'http://127.0.0.1:5824/?x=1');
  assert.equal(tc.appTarget([t('http://localhost:5824/', 'worker'), t('http://localhost:5824/', 'page', '')]), null);
});

/** A WebSocket that answers Runtime.evaluate with `reply` (or fails to connect). */
function fakeWS(reply: (msg: any) => any, connect = true) {
  const sent: any[] = [];
  class WS {
    onopen: any;
    onerror: any;
    onmessage: any;
    closed = false;
    url: string;
    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => (connect ? this.onopen() : this.onerror(new Error('refused'))));
    }
    send(data: string) {
      const msg = JSON.parse(data);
      sent.push(msg);
      // another message first: ignored
      queueMicrotask(() => {
        this.onmessage({ data: JSON.stringify({ method: 'Runtime.consoleAPICalled' }) });
        this.onmessage({ data: JSON.stringify({ id: msg.id, ...reply(msg) }) });
      });
    }
    close() {
      this.closed = true;
    }
  }
  return { WS: WS as any, sent };
}

test('evaluate: the value, the page’s exception, a protocol error, or no connection', async () => {
  const ok = fakeWS(() => ({ result: { result: { value: 7 } } }));
  assert.equal(await tc.evaluate('ws://x', '(a) => a', [1], ok.WS), 7);
  assert.equal(ok.sent[0].params.expression, '((a) => a)(...[1])');
  await assert.rejects(
    tc.evaluate('ws://x', 'f', [], fakeWS(() => ({ result: { exceptionDetails: { exception: { description: 'Boom' } } } })).WS),
    /Boom/,
  );
  await assert.rejects(
    tc.evaluate('ws://x', 'f', [], fakeWS(() => ({ result: { exceptionDetails: { text: 'Uncaught' } } })).WS),
    /Uncaught/,
  );
  await assert.rejects(tc.evaluate('ws://x', 'f', [], fakeWS(() => ({ error: { message: 'no such method' } })).WS), /no such method/);
  await assert.rejects(tc.evaluate('ws://x', 'f', [], fakeWS(() => ({}), false).WS), /Couldn't reach ws:\/\/x/);
  // a page that never answers: given up on
  const silent = fakeWS(() => ({ id: 99 }));
  await assert.rejects(tc.evaluate('ws://x', 'f', [], silent.WS, 5), /No answer from ws:\/\/x in 0.005 s/);
});

test('cleanup archives the run’s chats in the instance, then removes the run folder; a dry run or a failed archive keeps it', async () => {
  const removed: string[] = [];
  const asked: string[] = [];
  const get = async (url: string) => (
    asked.push(url), { json: async () => [{ url: 'http://localhost:5824/', type: 'page', webSocketDebuggerUrl: 'ws://app' }] }
  );
  let answer: any = { found: ['a', 'b'], archived: ['a', 'b'], failed: [] };
  const ws = fakeWS((msg) => ({ result: { result: { value: { ...answer, args: msg.params.expression.slice(-40) } } } }));
  const deps = { root: '/r', fetch: get as any, WS: ws.WS as any, rm: (p: string) => removed.push(p) };
  assert.equal(
    await tc.main(['cleanup', '--port', '9524', '--run', 't1'], deps),
    '2 chat(s) under /r/t1\narchived a\narchived b\nremoved /r/t1',
  );
  assert.deepEqual(asked, ['http://127.0.0.1:9524/json/list']);
  assert.match(ws.sent[0].params.expression, /\.\.\.\["\/r\/t1",false\]\)$/);
  assert.deepEqual(removed, ['/r/t1']);
  answer = { found: ['a'], archived: [], failed: [] };
  assert.equal(
    await tc.main(['cleanup', '--port', '9524', '--run', 't1', '--dry-run'], deps),
    '1 chat(s) under /r/t1 (dry run)\nkept /r/t1',
  );
  assert.match(ws.sent[1].params.expression, /\["\/r\/t1",true\]\)$/);
  answer = { found: ['a'], archived: [], failed: [{ id: 'a', error: 'Chat was deleted' }] };
  await assert.rejects(tc.main(['cleanup', '--port', '9524', '--run', 't1'], deps), /FAILED a: Chat was deleted\nkept \/r\/t1/);
  assert.equal(removed.length, 1);
  await assert.rejects(tc.cleanup({ ...deps, port: 0, run: 't1' }), /debugging port/);
  await assert.rejects(
    tc.cleanup({ ...deps, port: 1, run: 't1', fetch: (async () => ({ json: async () => [] })) as any }),
    /No MoPilot dev window on port 1/,
  );
});

test('the folder command makes the run’s project folder; anything else prints the usage; the real folder removal', async () => {
  const made: string[] = [];
  assert.equal(await tc.main(['folder', '--run', 't1'], { root: '/r', mkdir: (d: string) => made.push(d) }), '/r/t1/project');
  assert.deepEqual(made, ['/r/t1/project']);
  await assert.rejects(tc.main(['nope']), /Usage: node scripts\/test-chats.mjs/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testchats-'));
  assert.equal(await tc.main(['folder', '--run', 'r1'], { root: dir }), path.join(dir, 'r1', 'project'));
  assert.ok(fs.existsSync(path.join(dir, 'r1', 'project')));
  const ws = fakeWS(() => ({ result: { result: { value: { found: [], archived: [], failed: [] } } } }));
  await tc.cleanup({
    port: 1,
    run: 'r1',
    root: dir,
    WS: ws.WS as any,
    fetch: (async () => ({ json: async () => [{ url: 'http://localhost:1/', type: 'page', webSocketDebuggerUrl: 'ws://a' }] })) as any,
  });
  assert.equal(fs.existsSync(path.join(dir, 'r1')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a test instance on the real home makes a projectless chat’s folder in its run folder, whatever folder it was asked for', async () => {
  const tag = `ut-${process.pid}-${Date.now()}`;
  const saved = { bg: process.env.SAGE_E2E_BACKGROUND, run: process.env.MOPILOT_TEST_RUN };
  Object.assign(process.env, { SAGE_E2E_BACKGROUND: '1', MOPILOT_TEST_RUN: tag });
  const handlers = new Map<string, Function>();
  try {
    require('../electron/app/ipc/files.cjs').register(
      { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      { app: { getPath: () => os.tmpdir() }, live: {} },
    );
  } finally {
    for (const [k, v] of [
      ['SAGE_E2E_BACKGROUND', saved.bg],
      ['MOPILOT_TEST_RUN', saved.run],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  const run = path.join(TEST_CHATS_ROOT, tag);
  try {
    const mk = handlers.get('fs:mkdirProjectless')!;
    assert.deepEqual(await mk({}, path.join(os.homedir(), 'Documents', 'MoPilot'), '2026-10-20', 'hello'), {
      ok: true,
      path: path.join(run, '2026-10-20', 'hello'),
    });
    assert.ok(fs.existsSync(path.join(run, '2026-10-20', 'hello')));
    // a folder that isn't one is refused as before
    assert.deepEqual(await mk({}, 'relative', '2026-10-20', 'x'), { ok: false, error: 'invalid folder name' });
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test('the scratch root per platform, and the command line run as a script', () => {
  assert.equal(testChatsRoot('darwin', '/var/x'), '/private/tmp/mopilot-test');
  assert.equal(testChatsRoot('linux', '/tmp'), path.join('/tmp', 'mopilot-test'));
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/test-chats.mjs', ...args], { encoding: 'utf8' });
  const bad = run('nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: node scripts\/test-chats.mjs/);
  const tag = `ut-cli-${process.pid}`;
  const ok = run('folder', '--run', tag);
  try {
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), path.join(TEST_CHATS_ROOT, tag, 'project'));
  } finally {
    fs.rmSync(path.join(TEST_CHATS_ROOT, tag), { recursive: true, force: true });
  }
});

test('the archive program the page runs: it parses, takes the run folder under either /tmp spelling, and reports each chat', async () => {
  // the dev instance found it: an escape lost inside the program's template string made it unparseable
  const archived: string[] = [];
  const threads = {
    a: { id: 'a', cwd: '/private/tmp/mopilot-test/t1/project' },
    b: { id: 'b', cwd: '/tmp/mopilot-test/t1/project/sub' },
    c: { id: 'c', cwd: '/tmp/mopilot-test/t10/project' },
    d: { id: 'd' },
    e: { id: 'e', cwd: '/private/tmp/mopilot-test/t1' },
  };
  const stores: Record<string, any> = {
    '/src/store/core.ts': { get: () => ({ threads }) },
    '/src/store/actions.ts': {
      archiveThread: async (id: string) => {
        if (id === 'e') throw new Error('Chat was deleted');
        if (id === 'b') throw 'raw';
        archived.push(id);
      },
    },
  };
  const program = tc.ARCHIVE_JS.replace(/await import\('([^']+)'\)/g, (_m: string, p: string) => `__stores[${JSON.stringify(p)}]`);
  const run = new Function('__stores', `return (${program})`)(stores);
  assert.deepEqual(await run('/private/tmp/mopilot-test/t1', false), {
    found: ['a', 'b', 'e'],
    archived: ['a'],
    failed: [
      { id: 'b', error: 'raw' },
      { id: 'e', error: 'Chat was deleted' },
    ],
  });
  assert.deepEqual(await run('/r/t1', true), { found: [], archived: [], failed: [] });
});
