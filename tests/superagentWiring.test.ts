// The real GitHub source wired into the Superagent watcher (electron/app/superagentSource.cjs and electron/app/ipc/superagent.cjs): flag off means no poll, a repo pick starts it, pause and flag flips stop it, the bot login and the cursor reach the source, and its health reaches the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { githubSourceFactory, defaultExec } = require('../electron/app/superagentSource.cjs');
const { register } = require('../electron/app/ipc/superagent.cjs');
const { createStore } = require('../electron/superagent/store/index.cjs');
const { migrate } = require('../electron/superagent/store/migrations.cjs');
const { saveConfig } = require('../electron/superagent/gate/config.cjs');

const settle = () => new Promise((r) => setTimeout(r, 30));
function memStore() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return createStore({ db, now: () => 1000 });
}

test('the factory builds the source for the repo with the bot login, the cursor in the database and the token from gh', async () => {
  const store = memStore();
  let open: any = store;
  const seen: any[] = [];
  const statuses: any[] = [];
  const make = githubSourceFactory({
    getStore: () => open,
    now: () => 5,
    onStatus: (s: any) => statuses.push(s),
    log: () => {},
    deps: {
      createGithubSource: (o: any) => (seen.push(o), { start() {}, stop() {} }),
      exec: async (file: string, args: string[]) => ({ stdout: `${file} ${args.join(' ')}\n` }),
      env: {},
      childEnv: () => ({}),
      fetch: async () => ({}),
      setTimer: () => 7,
      clearTimer: () => {},
    },
  });
  make({ repo: 'acme/widgets', emit: () => {} });
  saveConfig(store, { repo: 'acme/widgets', botLogin: '@helper-bot' });
  make({ repo: 'acme/gadgets', emit: () => {} });
  assert.deepEqual(
    seen.map((o) => [o.repo, o.ownLogin]),
    [
      ['acme/widgets', 'mopilot-superagent'],
      ['acme/gadgets', 'helper-bot'],
    ],
  );
  const o = seen[1];
  assert.equal(await o.getToken(), 'gh auth token');
  assert.equal(o.now(), 5);
  assert.equal(
    o.setTimer(() => {}, 1),
    7,
  );
  o.onStatus({ state: 'ok', delayMs: 1 });
  assert.deepEqual(statuses, [{ state: 'ok', delayMs: 1 }]);
  // the poll cursor lives in the database, under its own key, and survives a new source
  assert.equal(await o.store.get('github-notifications:acme/gadgets'), undefined);
  await o.store.set('github-notifications:acme/gadgets', { etag: 'e1' });
  assert.deepEqual(store.watch.settings.get('cursor:github-notifications:acme/gadgets'), { etag: 'e1' });
  assert.deepEqual(await seen[0].store.get('github-notifications:acme/gadgets'), { etag: 'e1' });
  // with no store open there is nowhere to keep it, and nothing throws
  const bare = githubSourceFactory({
    getStore: () => store,
    now: () => 0,
    onStatus() {},
    log() {},
    deps: { createGithubSource: (x: any) => (seen.push(x), {}), exec: async () => ({ stdout: '' }), env: {}, childEnv: () => ({}) },
  });
  bare({ repo: 'a/b', emit() {} });
  open = null;
  assert.equal(await o.store.get('k'), undefined);
  assert.equal(await o.store.set('k', 1), undefined);
});

test('the token is asked for once a minute at most, shared by requests that ask together; a failing gh is no token, not an error, and is asked again', async () => {
  const store = memStore();
  const seen: any[] = [];
  const logs: string[] = [];
  let clock = 0;
  let execs = 0;
  let fail = false;
  const make = githubSourceFactory({
    getStore: () => store,
    now: () => clock,
    onStatus() {},
    log: (m: string) => logs.push(m),
    deps: {
      createGithubSource: (o: any) => (seen.push(o), {}),
      exec: async () => {
        execs++;
        await Promise.resolve();
        if (fail) throw new Error('gh: not logged in\nrun gh auth login');
        return { stdout: ' tok \n' };
      },
      env: {},
      childEnv: () => ({}),
    },
  });
  make({ repo: 'a/b', emit() {} });
  const get = seen[0].getToken;
  assert.deepEqual(await Promise.all([get(), get(), get()]), ['tok', 'tok', 'tok']);
  assert.equal(execs, 1, 'requests asking together share one gh run');
  clock = 59_000;
  assert.equal(await get(), 'tok');
  assert.equal(execs, 1, 'kept for a minute');
  clock = 61_000;
  assert.equal(await get(), 'tok');
  assert.equal(execs, 2);
  // gh missing or failing: no token (the source says so), logged, and not kept
  fail = true;
  clock = 200_000;
  assert.equal(await get(), null);
  assert.equal(await get(), null);
  assert.equal(execs, 4, 'a missing token is asked for again');
  assert.deepEqual(logs, ['github source: could not read a GitHub token', 'github source: could not read a GitHub token']);
  fail = false;
  assert.equal(await get(), 'tok');
  // an empty answer is no token either
  const empty = githubSourceFactory({
    getStore: () => store,
    now: () => 0,
    onStatus() {},
    log() {},
    deps: { createGithubSource: (o: any) => (seen.push(o), {}), exec: async () => ({ stdout: '\n' }), env: {}, childEnv: () => ({}) },
  });
  empty({ repo: 'a/b', emit() {} });
  assert.equal(await seen.at(-1).getToken(), null);
});

test('the factory defaults: global fetch, real timers, real gh runner that fails clearly and gives up after its timeout', async () => {
  const store = memStore();
  const seen: any[] = [];
  githubSourceFactory({
    getStore: () => store,
    now: () => 0,
    onStatus() {},
    log() {},
    deps: { createGithubSource: (o: any) => (seen.push(o), {}) },
  })({ repo: 'a/b', emit() {} });
  const o = seen[0];
  assert.equal(o.fetch, globalThis.fetch);
  let fired = false;
  const h = o.setTimer(() => (fired = true), 1);
  o.clearTimer(h);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, false, 'the default timer is cancellable');
  const plain = o.setTimer(() => {}, 0);
  assert.ok(plain, 'a real timer handle');
  assert.deepEqual(await defaultExec(process.execPath, ['-e', "process.stdout.write('tok')"], { env: process.env }), { stdout: 'tok' });
  await assert.rejects(defaultExec(process.execPath, ['-e', 'process.exit(3)'], { env: process.env }));
  await assert.rejects(defaultExec('/definitely/not/a/program', [], { env: process.env }));
});

// the real source on fake ports: what leaves the app is a GET to api.github.com with the token
function wired() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-sa-wire-'));
  const handlers: Record<string, (e: unknown, ...a: any[]) => Promise<any>> = {};
  const fetches: { url: string; init: any }[] = [];
  const execs: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const flag = { on: false };
  const github = {
    fetch: async (url: string, init: any) => {
      fetches.push({ url, init });
      return { status: 304, ok: false, headers: { get: () => null } };
    },
    exec: async (file: string, args: string[]) => (execs.push([file, ...args]), { stdout: 'tok-from-gh\n' }),
    env: {},
    childEnv: () => ({}),
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms, live: true }) && timers.length - 1,
    clearTimer: (h: number) => {
      timers[h].live = false;
    },
  };
  const ticks: Array<() => void> = [];
  const ctrl = register(
    {
      handle: (c: string, fn: any) => {
        handlers[c] = fn;
      },
    },
    { app: { getPath: () => root, isPackaged: true }, broadcastAll() {} },
    {
      enabled: () => flag.on,
      now: () => Date.parse('2026-11-08T12:00:00Z'),
      github,
      setTimer: (fn: () => void) => {
        ticks.push(fn);
      },
      lifecycle: { setTimer: () => 0, clearTimer: () => {} },
      later: () => {},
    },
  );
  const value = async (name: string, ...args: any[]) => {
    const r = await handlers[`superagent:${name}`]({}, ...args);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.value;
  };
  /** Runs the source's pending poll timer, if one is live. */
  const poll = async () => {
    const t = timers.filter((x) => x.live).at(-1);
    if (t) {
      t.live = false;
      t.fn();
    }
    await settle();
  };
  return { ctrl, flag, fetches, execs, timers, ticks, value, poll };
}

test('flag off means no poll: no request, no token lookup, no timer, even with a repository saved', async () => {
  const t = wired();
  t.ticks[0]();
  await t.value('state').catch(() => {});
  assert.deepEqual([t.fetches.length, t.execs.length, t.timers.length], [0, 0, 0]);
  assert.equal(t.ctrl.runner.status().reason, 'off');
  // a repository chosen while it was on, then the flag turns off: the poll stops and nothing more is sent
  t.flag.on = true;
  await t.value('setRepo', 'acme/widgets');
  await t.poll();
  assert.equal(t.fetches.length, 1);
  t.flag.on = false;
  t.ticks.at(-1)!();
  await t.ctrl.sa.sync();
  assert.equal(
    t.timers.every((x) => !x.live),
    true,
    'no pending poll',
  );
  const before = t.fetches.length;
  t.ticks.at(-1)!();
  await t.poll();
  assert.equal(t.fetches.length, before, 'nothing is sent after the flag went off');
});

test('picking a repo starts one GET poll with the token; a pause stops it, resuming and another repo start it again', async () => {
  const t = wired();
  t.flag.on = true;
  await t.value('state');
  assert.equal(t.fetches.length, 0, 'no repository, no poll');
  await t.value('setRepo', 'acme/widgets');
  await t.poll();
  assert.equal(t.fetches.length, 1);
  const { url, init } = t.fetches[0];
  assert.equal(url, 'https://api.github.com/repos/acme/widgets/notifications?all=true&per_page=50&since=2026-11-08T11%3A00%3A00Z');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.authorization, 'Bearer tok-from-gh');
  assert.deepEqual(t.execs, [['gh', 'auth', 'token']]);
  assert.deepEqual((await t.value('state')).source.state, 'watching');

  await t.value('setPaused', 'github', true);
  assert.equal(
    t.timers.every((x) => !x.live),
    true,
    'paused: no pending poll',
  );
  assert.deepEqual((await t.value('state')).source, { state: 'stopped', reason: 'paused' });
  await t.value('setPaused', 'github', false);
  await t.poll();
  assert.equal(t.fetches.length, 2);
  assert.equal(t.fetches[1].url, url, 'resuming keeps the read-inclusive poll window');
  await t.value('setRepo', 'acme/gadgets');
  await t.poll();
  assert.equal(
    t.fetches.at(-1)!.url,
    'https://api.github.com/repos/acme/gadgets/notifications?all=true&per_page=50&since=2026-11-08T11%3A00%3A00Z',
  );
  assert.equal(
    t.fetches.every((f) => f.init.method === 'GET'),
    true,
    'GET only',
  );
  await t.ctrl.sa.sync();
});

test('the source reports its health once per change, and the page gets it', async () => {
  let report: (s: any) => void = () => {};
  let log: (m: string, e: unknown) => void = () => {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-sa-health-'));
  const handlers: Record<string, any> = {};
  let sent = 0;
  register(
    {
      handle: (c: string, fn: any) => {
        handlers[c] = fn;
      },
    },
    { app: { getPath: () => root, isPackaged: true }, broadcastAll: () => sent++ },
    {
      enabled: () => true,
      setTimer: () => {},
      later: () => {},
      lifecycle: { setTimer: () => 0, clearTimer: () => {} },
      github: {
        createGithubSource: (o: any) => ((report = o.onStatus), (log = o.log), { start() {}, stop() {} }),
        exec: async () => ({ stdout: '' }),
        env: {},
        childEnv: () => ({}),
      },
    },
  );
  const call = async (n: string, ...a: any[]) => (await handlers[`superagent:${n}`]({}, ...a)).value;
  await call('setRepo', 'acme/widgets');
  const base = sent;
  report({ state: 'error', delayMs: 1, reason: 'No GitHub token' });
  report({ state: 'error', delayMs: 2, reason: 'No GitHub token' });
  assert.equal(sent, base + 1, 'the same health is told once');
  assert.deepEqual((await call('state')).source.health, { state: 'error', reason: 'No GitHub token' });
  report({ state: 'ok', delayMs: 3 });
  assert.deepEqual((await call('state')).source.health, { state: 'ok' });
  assert.equal(sent, base + 2);
  // an item the source could not read is noted, not thrown
  log('github source: an item failed', new Error('GitHub 500'));
  const { recentIgnored } = require('../electron/ignored.cjs');
  assert.ok(recentIgnored().some((r: any) => /an item failed/.test(JSON.stringify(r))));
});

test('the source health reaches the page: a missing token is said, and it clears when the source restarts', async () => {
  const t = wired();
  t.flag.on = true;
  await t.value('setRepo', 'acme/widgets');
  // no token: the env has none and gh gives an empty answer
  (t as any).execs.length = 0;
  await t.poll();
  await settle();
  const s = (await t.value('state')).source;
  assert.equal(s.state, 'watching');
  assert.equal(s.health.state, 'unchanged', 'a 304 poll is healthy');
  await t.value('setPaused', 'github', true);
  await t.value('setPaused', 'github', false);
  assert.equal((await t.value('state')).source.health, undefined, 'a new source has reported nothing yet');
  await t.ctrl.sa.sync();
});
