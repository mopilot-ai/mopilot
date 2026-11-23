// Inert filesystem and process boundaries exercise ACP login hold ownership, explicit completion, and failure cleanup.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, mock, test, type TestContext } from 'node:test';

const files = new Map<string, string>();
const watchers: FakeWatcher[] = [];
const writes: string[] = [];
const exited = new Error('inert process exit');
let readError: Error | undefined;
let watchError: Error | undefined;
let duringWatch: (() => void) | undefined;
let exitCodes: number[] = [];
let output: string[] = [];
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
class FakeWatcher extends EventEmitter {
  closed = 0;
  directory: string;
  changed: () => void;
  constructor(directory: string, changed: () => void) {
    super();
    this.directory = directory;
    this.changed = changed;
  }
  close() {
    this.closed++;
  }
}
const fs = {
  mkdirSync() {},
  readFileSync(file: string) {
    if (readError) throw readError;
    if (!files.has(file)) throw missing();
    return files.get(file)!;
  },
  writeFileSync(file: string, content: string, options?: { flag?: string }) {
    if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('already held'), { code: 'EEXIST' });
    files.set(file, content);
    writes.push(file);
  },
  unlinkSync(file: string) {
    files.delete(file);
  },
  existsSync: (file: string) => files.has(file),
  watch(directory: string, changed: () => void) {
    if (watchError) throw watchError;
    duringWatch?.();
    const watcher = new FakeWatcher(directory, changed);
    watchers.push(watcher);
    return watcher;
  },
};
mock.module('node:fs', { defaultExport: fs });
mock.module('node:process', {
  defaultExport: {
    argv: ['/node', '/fixtures/fake-acp-agent.mjs'],
    execPath: '/node',
    stdout: { write: (text: string) => output.push(text) },
    exit: (code: number) => {
      exitCodes.push(code);
      throw exited;
    },
  },
});
const { holdAcpLogin, waitForAcpLoginRelease } = await import('./fixtures/acp-login-gate.mjs');
const { terminalLogin, authMethods, authed, authenticate } = await import('./fixtures/fake-acp-signin.mjs');
const state = '/inert/gemini';
const held = `${state}/login-hold`;
const marker = `${state}/authed`;
const login = () => terminalLogin(['/node', '/fake', '--login', state]);
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

beforeEach((t) => {
  files.clear();
  watchers.length = 0;
  writes.length = 0;
  readError = undefined;
  watchError = undefined;
  duringWatch = undefined;
  exitCodes = [];
  output = [];
  (t as TestContext).mock.timers.enable({ apis: ['setTimeout'] });
});

test('terminal login cannot authenticate or exit until its argv-scoped hold is explicitly released', async (t) => {
  const release = holdAcpLogin(state);
  const result = observe(login());
  assert.equal(watchers[0].directory, state);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(files.has(marker), false);
  assert.deepEqual(exitCodes, []);
  assert.deepEqual(output, []);
  release();
  watchers[0].changed();
  assert.equal(await result, exited);
  assert.equal(files.has(marker), true);
  assert.deepEqual(exitCodes, [0]);
  assert.deepEqual(output, ['Logged in.\n']);
  assert.equal(watchers[0].closed, 1);
  t.mock.timers.runAll();
  assert.equal(watchers[0].closed, 1);
});

test('release is idempotent and a stale release cannot delete a later hold', async () => {
  const oldRelease = holdAcpLogin(state);
  const token = files.get(held);
  oldRelease();
  oldRelease();
  const release = holdAcpLogin(state);
  assert.notEqual(files.get(held), token);
  oldRelease();
  assert.equal(files.has(held), true);
  const result = waitForAcpLoginRelease(state);
  release();
  watchers[0].changed();
  await result;
});

test('a live overlapping hold is refused without replacing the owner', () => {
  const release = holdAcpLogin(state);
  const token = files.get(held);
  assert.throws(() => holdAcpLogin(state), { code: 'EEXIST' });
  assert.equal(files.get(held), token);
  release();
});

test('release before watch registration is observed by the subscribe-then-check read', async () => {
  const release = holdAcpLogin(state);
  duringWatch = release;
  assert.equal(await observe(login()), exited);
  assert.equal(watchers[0].closed, 1);
  assert.equal(files.has(marker), true);
});

test('unrelated directory events and another harness release cannot release this login', async () => {
  const release = holdAcpLogin(state);
  const otherRelease = holdAcpLogin('/inert/kimi');
  const result = observe(login());
  otherRelease();
  watchers[0].changed();
  await Promise.resolve();
  assert.equal(files.has(marker), false);
  assert.equal(watchers[0].closed, 0);
  release();
  watchers[0].changed();
  assert.equal(await result, exited);
});

test('an older waiter fails closed on replacement, while its release leaves the new token alone', async () => {
  const staleRelease = holdAcpLogin(state);
  const result = observe(login());
  files.set(held, 'replacement');
  watchers[0].changed();
  assert.match(String(await result), /replaced before release/);
  staleRelease();
  assert.equal(files.get(held), 'replacement');
  assert.equal(files.has(marker), false);
  assert.equal(watchers[0].closed, 1);
});

test('the watchdog fails closed and cleans up rather than treating time as release', async (t) => {
  const release = holdAcpLogin(state);
  const result = observe(login());
  t.mock.timers.tick(120_000);
  assert.match(String(await result), /not released/);
  assert.equal(files.has(marker), false);
  assert.equal(files.has(held), true);
  assert.equal(watchers[0].closed, 1);
  release();
  watchers[0].changed();
  assert.equal(watchers[0].closed, 1);
  assert.deepEqual(exitCodes, []);
});

for (const failure of ['initial read', 'watch setup', 'watch error', 'subsequent read'] as const) {
  test(`${failure} failure cannot authenticate and retires any watcher and deadline`, async (t) => {
    const release = holdAcpLogin(state);
    const error = new Error(failure);
    if (failure === 'initial read') readError = error;
    if (failure === 'watch setup') watchError = error;
    const result = observe(login());
    if (failure === 'watch error') watchers[0].emit('error', error);
    if (failure === 'subsequent read') {
      readError = error;
      watchers[0].changed();
    }
    assert.equal(await result, error);
    assert.equal(files.has(marker), false);
    assert.deepEqual(exitCodes, []);
    assert.equal(watchers.length, failure === 'initial read' || failure === 'watch setup' ? 0 : 1);
    for (const watcher of watchers) assert.equal(watcher.closed, 1);
    t.mock.timers.runAll();
    for (const watcher of watchers) assert.equal(watcher.closed, 1);
    readError = undefined;
    release();
  });
}

test('release surfaces read failures without deleting a hold it cannot identify', () => {
  holdAcpLogin(state);
  const release = holdAcpLogin('/inert/other');
  readError = new Error('cannot identify');
  assert.throws(release, /cannot identify/);
  assert.equal(files.has('/inert/other/login-hold'), true);
});

test('normal no-hold login and non-login protocol startup do not open a watcher', async () => {
  assert.equal(await terminalLogin(['/node', '/fake']), undefined);
  assert.deepEqual(writes, []);
  assert.equal(await observe(login()), exited);
  assert.equal(files.has(marker), true);
  assert.equal(watchers.length, 0);
});

test('terminal auth passes the same state in argv without relying on wrapper environment', () => {
  assert.deepEqual(authMethods({ terminalLogin: true }, state), [
    {
      id: 'terminal',
      name: 'Log in in terminal',
      _meta: { 'terminal-auth': { command: '/node', args: ['/fixtures/fake-acp-agent.mjs', '--login', state], label: 'fake login' } },
    },
  ]);
  assert.deepEqual(authMethods({ authMethods: [{ id: 'browser' }] }, state), [{ id: 'browser' }]);
  assert.deepEqual(authMethods({}, state), []);
  assert.equal(authed({}, state), true);
  assert.equal(authed({ needsAuth: true }, undefined), undefined);
  assert.equal(authed({ needsAuth: true }, state), false);
  files.set(marker, '');
  assert.equal(authed({ needsAuth: true }, state), true);
});

test('ordinary authentication without state remains immediate', async () => {
  assert.deepEqual(await authenticate({}, undefined), {});
  assert.deepEqual(writes, []);
  assert.deepEqual(await authenticate({}, state), {});
  assert.deepEqual(writes, [marker]);
});

test('browser authentication still awaits success and persists only then', async (t) => {
  const result = authenticate({ browserLogin: true }, state);
  assert.equal(files.has(marker), false);
  files.set(`${state}/browser-ok`, '');
  t.mock.timers.tick(50);
  assert.deepEqual(await result, {});
  assert.equal(files.has(marker), true);
});

test('browser authentication failures propagate with and without a state directory', async () => {
  files.set(`${state}/browser-fail`, ' failed \n');
  assert.match(String(await observe(authenticate({ browserLogin: true }, state))), /failed/);
  files.set('browser-fail', ' default state failed ');
  assert.match(String(await observe(authenticate({ browserLogin: true }, undefined))), /default state failed/);
  assert.deepEqual(writes, []);
});

test('a failed held login can be released, rearmed, and retried without stale cleanup touching the new owner', async () => {
  const oldRelease = holdAcpLogin(state);
  const first = observe(login());
  const failure = new Error('first watcher failed');
  watchers[0].emit('error', failure);
  assert.equal(await first, failure);
  oldRelease();
  const release = holdAcpLogin(state);
  const retry = observe(login());
  oldRelease();
  assert.equal(files.has(held), true);
  assert.equal(files.has(marker), false);
  release();
  watchers[1].changed();
  assert.equal(await retry, exited);
  assert.equal(files.has(marker), true);
  assert.deepEqual(
    watchers.map((watcher) => watcher.closed),
    [1, 1],
  );
});
