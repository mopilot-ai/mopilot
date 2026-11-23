// electron/harness/routes.cjs: every harness's route kept in main, read again on a file change, a slow read never
// overwriting a newer one, a half-written file keeping the last good route, and processes that started before the
// route changed counted and restarted only while idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRoutes } = require('../electron/harness/routes.cjs');

const INFO = {
  files: [{ id: 'config', path: '/h/.x/config.json', format: 'json' }],
  endpoint: ['config:url'],
  vendorHosts: ['vendor.test'],
};
const TWO = { ...INFO, files: [...INFO.files, { id: 'other', path: '/h/.y/other.json', format: 'json' }] };
const docs = (doc: unknown, error: string | null = null) => ({ env: {}, files: { config: { path: '/h/.x/config.json', doc, error } } });

function setup(o: any = {}) {
  let answer: any = { docs: docs({}), mtimeMs: 100 };
  const changes: any[] = [];
  const watchers: any[] = [];
  let clock = 1000;
  const procs: Record<string, any> = o.procs ?? {};
  const routes = createRoutes({
    env: () => ({}),
    home: '/h',
    platform: 'darwin',
    table: o.table ?? { x: INFO },
    read: o.read ?? (async () => answer),
    watch:
      o.watch ??
      ((dir: string, _opts: any, cb: any) => {
        const handlers: Record<string, () => void> = {};
        const w = {
          dir,
          cb,
          closed: false,
          close: () => (w.closed = true),
          on: (ev: string, fn: () => void) => (handlers[ev] = fn),
          fire: (ev: string) => handlers[ev](),
        };
        watchers.push(w);
        return w;
      }),
    now: () => clock,
    debounceMs: 5,
    processes: (kind: string) => procs[kind] ?? null,
    onChange: (list: any[]) => changes.push(list),
  });
  return {
    routes,
    changes,
    watchers,
    set: (a: any) => (answer = a),
    tick: (ms: number) => (clock += ms),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the first read keeps the route and the files' time; an unchanged read tells no one", async () => {
  const s = setup();
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 500 });
  await s.routes.refreshAll();
  assert.equal(s.changes.length, 1);
  const [r] = s.changes[0];
  assert.equal(r.harness, 'x');
  assert.equal(r.kind, 'external');
  assert.equal(r.label, 'magpie');
  assert.equal(r.changedAt, 500);
  assert.deepEqual(r.stale, { running: 0, idle: 0 });
  assert.deepEqual(r.effects, []);
  assert.equal(s.routes.get('x').label, 'magpie');
  assert.equal(s.routes.get('nope'), null);
  await s.routes.refreshAll();
  assert.equal(s.changes.length, 1);
});

test('a changed route moves changedAt to the newer file time, or to now when the file went away', async () => {
  const s = setup();
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 500 });
  await s.routes.refreshAll();
  // edited without changing the route (an MCP server added): changedAt stays
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425', mcp: 1 }), mtimeMs: 700 });
  await s.routes.refresh('x');
  assert.equal((await s.routes.list())[0].changedAt, 500);
  s.set({ docs: docs({ url: 'https://vendor.test' }), mtimeMs: 900 });
  assert.equal(await s.routes.refresh('x'), true);
  assert.equal((await s.routes.list())[0].changedAt, 900);
  // the vendor's own endpoint and no endpoint at all are the same route
  s.set({ docs: { env: {}, files: { config: { path: '/h/.x/config.json' } } }, mtimeMs: 0 });
  await s.routes.refresh('x');
  assert.equal((await s.routes.list())[0].changedAt, 900);
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 950 });
  await s.routes.refresh('x');
  // deleted: no newer time to go by
  s.set({ docs: { env: {}, files: { config: { path: '/h/.x/config.json' } } }, mtimeMs: 0 });
  s.tick(5);
  await s.routes.refresh('x');
  const r = (await s.routes.list())[0];
  assert.equal(r.changedAt, 1005);
  assert.equal(r.kind, 'direct');
});

test('a file another tool is still writing reads as unknown and keeps the last good route; changedAt does not move', async () => {
  const s = setup();
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 500 });
  await s.routes.refreshAll();
  s.set({ docs: docs(undefined, "Couldn't read /h/.x/config.json: Unexpected end"), mtimeMs: 600 });
  await s.routes.refreshAll();
  const r = (await s.routes.list())[0];
  assert.equal(r.kind, 'unknown');
  assert.equal(r.lastGood.label, 'magpie');
  assert.equal(r.changedAt, 500);
  // the write finished with the same route: nothing restarts for it
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 610 });
  await s.routes.refreshAll();
  assert.equal((await s.routes.list())[0].changedAt, 500);
});

test('unknown from the first read: the next good read does not count as a change', async () => {
  const s = setup();
  s.set({ docs: docs(undefined, 'bad'), mtimeMs: 300 });
  await s.routes.refreshAll();
  assert.equal((await s.routes.list())[0].lastGood, null);
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 300 });
  await s.routes.refreshAll();
  assert.equal((await s.routes.list())[0].changedAt, 300);
});

test('a slow read that finishes after a newer one is dropped', async () => {
  let release: (v: any) => void = () => {};
  let n = 0;
  const s = setup({
    read: () => {
      n++;
      if (n === 1) return new Promise((r) => (release = r));
      return Promise.resolve({ docs: docs({ url: 'https://vendor.test' }), mtimeMs: 200 });
    },
  });
  const slow = s.routes.refresh('x');
  assert.equal(await s.routes.refresh('x'), true);
  release({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 100 });
  assert.equal(await slow, false);
  assert.equal(s.routes.get('x').kind, 'direct');
});

test('a read that throws is logged and changes nothing', async () => {
  const s = setup({
    read: async () => {
      throw new Error('boom');
    },
  });
  await s.routes.refreshAll();
  assert.equal(s.changes.length, 0);
  assert.deepEqual(await s.routes.list(), []);
});

test('processes that started before the route changed are stale: busy ones counted apart; a failing list counts none', async () => {
  const s = setup({
    procs: {
      x: {
        list: async () => [
          { startedAt: 400, busy: false },
          { startedAt: 450, busy: true },
          { startedAt: 950, busy: false },
        ],
        restartIdle: async () => ({ restarted: 1, busy: 1 }),
        effects: () => ['poolingOff'],
      },
    },
  });
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 900 });
  await s.routes.refreshAll();
  const r = (await s.routes.list())[0];
  assert.deepEqual(r.stale, { running: 1, idle: 1 });
  assert.deepEqual(r.effects, ['poolingOff']);
  const f = setup({ procs: { x: { list: async () => Promise.reject(new Error('gone')), restartIdle: async () => ({}) } } });
  await f.routes.refreshAll();
  assert.deepEqual((await f.routes.list())[0].stale, { running: 0, idle: 0 });
});

test('a harness whose processes pick a change up by themselves never has stale ones', async () => {
  const s = setup({
    table: { x: { ...INFO, appliesLive: true } },
    procs: { x: { list: async () => [{ startedAt: 1, busy: false }], restartIdle: async () => ({ restarted: 0, busy: 0 }) } },
  });
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 900 });
  await s.routes.refreshAll();
  assert.deepEqual((await s.routes.list())[0].stale, { running: 0, idle: 0 });
  s.routes.close();
});

test('Restart to apply: idle processes before changedAt; a second click joins the first; every window hears after', async () => {
  const calls: number[] = [];
  let finish: (v: any) => void = () => {};
  const s = setup({
    procs: {
      x: {
        list: async () => [],
        restartIdle: (before: number) => {
          calls.push(before);
          return new Promise((r) => (finish = r));
        },
      },
    },
  });
  s.set({ docs: docs({}), mtimeMs: 800 });
  await s.routes.refreshAll();
  const before = s.changes.length;
  const a = s.routes.restartIdle('x');
  const b = s.routes.restartIdle('x');
  assert.equal(a, b);
  finish({ restarted: 2, busy: 0 });
  assert.deepEqual(await a, { restarted: 2, busy: 0 });
  assert.deepEqual(calls, [800]);
  assert.equal(s.changes.length, before + 1);
  // a harness with no processes or no route yet restarts nothing
  assert.deepEqual(await s.routes.restartIdle('unread'), { restarted: 0, busy: 0 });
});

test('a write in a watched folder reads that harness again after the burst; another file there is ignored', async () => {
  const s = setup({ table: { x: INFO, y: { ...INFO, files: [{ id: 'config', path: '/h/.y/other.json', format: 'json' }] } } });
  s.set({ docs: docs({}), mtimeMs: 1 });
  await s.routes.refreshAll();
  assert.deepEqual(
    s.watchers.map((w) => w.dir),
    ['/h/.x', '/h/.y'],
  );
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 50 });
  const x = s.watchers[0];
  x.cb('change', 'unrelated.json');
  x.cb('change', 'config.json');
  x.cb('change', 'config.json');
  await wait(20);
  assert.equal(s.routes.get('x').label, 'magpie');
  assert.equal(s.routes.get('y').kind, 'direct');
  assert.equal(s.changes.at(-1).length, 2);
  // no name: every harness is read again
  s.set({ docs: docs({ url: 'https://elsewhere.test' }), mtimeMs: 60 });
  x.cb('rename', null);
  await wait(20);
  assert.equal(s.routes.get('y').label, 'elsewhere.test');
});

test('a write that leaves the route as it was tells no one', async () => {
  const s = setup();
  s.set({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 5 });
  await s.routes.refreshAll();
  const before = s.changes.length;
  s.watchers[0].cb('change', 'config.json');
  await wait(20);
  assert.equal(s.changes.length, before);
  s.routes.close();
});

test('a watcher whose folder went away is dropped and attached again at the next read', async () => {
  const s = setup();
  await s.routes.refreshAll();
  assert.equal(s.watchers.length, 1);
  s.watchers[0].fire('error');
  assert.equal(s.watchers[0].closed, true);
  await s.routes.refresh('x');
  assert.equal(s.watchers.length, 2);
});

test('a folder that does not exist yet is not watched; focus reads again', async () => {
  const s = setup({
    table: { x: TWO },
    watch: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  await s.routes.refreshAll();
  assert.equal(s.routes.get('x').kind, 'direct');
});

test('close stops the watchers and pending reads, and a read that lands after close is dropped', async () => {
  let release: (v: any) => void = () => {};
  const s = setup({ read: () => new Promise((r) => (release = r)) });
  const first = s.routes.refresh('x');
  release({ docs: docs({}), mtimeMs: 1 });
  await first;
  s.watchers[0].cb('change', 'config.json');
  const late = s.routes.refresh('x');
  s.routes.close();
  release({ docs: docs({}), mtimeMs: 1 });
  assert.equal(await late, false);
  assert.equal(s.watchers[0].closed, true);
  await wait(15);
  // no watcher is made once closed
  assert.equal(s.watchers.length, 1);
});

test('a window update that throws is logged, never an unhandled rejection', async () => {
  const routes = require('../electron/harness/routes.cjs').createRoutes({
    env: () => ({}),
    home: '/h',
    platform: 'darwin',
    table: { x: INFO },
    read: async () => ({ docs: docs({ url: 'http://127.0.0.1:3425' }), mtimeMs: 1 }),
    watch: () => ({ close: () => {}, on: () => {} }),
    processes: () => ({
      list: async () => [],
      restartIdle: async () => ({ restarted: 0, busy: 0 }),
      effects: () => {
        throw new Error('fake accounts');
      },
    }),
    onChange: () => assert.fail('no list to send'),
  });
  await routes.refreshAll();
  routes.close();
});
