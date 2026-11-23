// Superagent IPC (electron/app/ipc/superagent.cjs) on a real temp folder: off opens nothing, a flip opens and closes the store, a damaged database stops until acknowledged, a locked one is retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/superagent.cjs');

const ev = (o: any = {}) => ({
  source: 'github',
  externalId: 'IC_1',
  threadKey: 'I_1',
  kind: 'issue.opened',
  actor: { login: 'alice', id: 1, type: 'User' },
  repo: { nodeId: 'R_1', fullName: 'acme/widgets' },
  subject: { type: 'issue', number: 7, nodeId: 'I_1', url: 'https://github.com/acme/widgets/issues/7' },
  body: 'The app crashes on start',
  occurredAt: '2026-11-07T10:00:00Z',
  ...o,
});
/** Fake ports for the real GitHub source: nothing leaves the test. */
function ghDeps() {
  return {
    fetch: async () => ({ status: 304, ok: false, headers: { get: () => null } }),
    exec: async () => ({ stdout: 'tok\n' }),
    env: {},
    childEnv: () => ({}),
    setTimer: () => 0,
    clearTimer: () => {},
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(o: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-sa-ipc-'));
  const dir = path.join(root, 'superagent');
  const eventsFile = path.join(root, 'events.json');
  fs.writeFileSync(
    eventsFile,
    JSON.stringify([
      ev({ externalId: 'a', threadKey: 'I_a' }),
      ev({ externalId: 'b', threadKey: 'I_b', actor: { login: 'mallory', id: 2, type: 'User' } }),
    ]),
  );
  const handlers: Record<string, (e: unknown, ...a: any[]) => Promise<any>> = {};
  const sent: string[] = [];
  const timers: Array<() => void> = [];
  const laters: Array<() => void> = [];
  const flag = { on: false };
  // the fake file is read when register runs, from the environment the app was started with
  const { fake = true, packaged, ...rest } = o;
  const previous = process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS;
  if (fake) process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS = fake === true ? eventsFile : fake;
  else delete process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS;
  let ctrl: any;
  try {
    ctrl = register(
      {
        handle: (channel: string, fn: any) => {
          handlers[channel] = fn;
        },
      },
      { app: { getPath: () => root, isPackaged: packaged === true }, broadcastAll: (c: string) => sent.push(c) },
      {
        enabled: () => flag.on,
        later: (fn: () => void) => {
          laters.push(fn);
        },
        setTimer: (fn: () => void) => {
          timers.push(fn);
        },
        lifecycle: { setTimer: () => 0, clearTimer: () => {} },
        ...rest,
      },
    );
  } finally {
    if (previous === undefined) delete process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS;
    else process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS = previous;
  }
  const call = async (name: string, ...args: any[]) => handlers[`superagent:${name}`]({}, ...args);
  const value = async (name: string, ...args: any[]) => {
    const r = await call(name, ...args);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.value;
  };
  return { laters, root, dir, db: path.join(dir, 'superagent.db'), eventsFile, handlers, sent, timers, flag, ctrl, call, value };
}

test('off: nothing opens, no folder or file is made, changes are refused, the state says it is off', async () => {
  const t = setup();
  assert.equal((await t.value('state')).error.code, 'off');
  assert.equal(fs.existsSync(t.dir), false);
  assert.deepEqual((await t.call('setRepo', 'acme/widgets')).error, { message: 'Superagent is not running.', code: 'unavailable' });
  t.timers[0]();
  assert.equal(fs.existsSync(t.dir), false, 'the periodic check opens nothing either');
  assert.equal(t.ctrl.runner.status().reason, 'off');
});

test('on: the store opens in a private folder; the journey: repo, allowed, events arrive, marks, pause, resume', async () => {
  const t = setup();
  t.flag.on = true;
  let s = await t.value('state');
  assert.equal(s.ok, true);
  assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
  assert.deepEqual(s.source, { state: 'stopped', reason: 'no_repo' });

  await t.value('setAllowed', ['alice']);
  const config = await t.value('setRepo', 'acme/widgets');
  assert.equal(config.repo, 'acme/widgets');
  await settle();
  s = await t.value('state');
  assert.deepEqual(s.source, { state: 'watching', repo: 'acme/widgets' });
  assert.deepEqual(s.log.map((r: any) => r.verdict).sort(), ['Would accept', 'Would ignore']);
  assert.ok(t.sent.includes('superagent:changed'));

  const accept = s.log.find((r: any) => r.verdict === 'Would accept');
  assert.equal((await t.value('mark', accept.id, 'right')).precision, 1);
  assert.equal((await t.call('mark', 'gone', 'right')).error.code, 'unknown_decision');

  await t.value('setRule', 'bugs', 'off');
  assert.equal((await t.call('setRule', 'bugs', 'auto')).error.code, 'auto_unavailable');
  await t.value('setPaused', 'github', true);
  assert.deepEqual((await t.value('state')).source, { state: 'stopped', reason: 'paused' });
  await t.value('setPaused', 'github', false);
  await settle();
  assert.deepEqual((await t.value('state')).source, { state: 'watching', repo: 'acme/widgets' });
  assert.equal((await t.value('state')).log.length, 2, 'the same events delivered again are stored once');

  assert.equal((await t.call('setRepo', 'nope')).error.code, 'invalid_repo');
  assert.deepEqual((await t.call('nope-not-registered'.replace('nope-not-registered', 'setAllowed'), 'x')).error.code, 'invalid_login');
  await t.ctrl.sa.sync();
});

test('a flag flip closes the store after running work and stops the source; flipping back keeps the data', async () => {
  const t = setup();
  t.flag.on = true;
  await t.value('setAllowed', ['alice']);
  await t.value('setRepo', 'acme/widgets');
  await settle();
  t.flag.on = false;
  t.timers[0](); // the periodic check notices the flip
  await t.ctrl.sa.sync();
  assert.equal(t.ctrl.sa.store, null);
  assert.deepEqual(t.ctrl.runner.status(), { state: 'stopped', reason: 'off' });
  assert.equal((await t.value('state')).error.code, 'off');
  t.flag.on = true;
  const s = await t.value('state');
  assert.equal(s.ok, true);
  assert.equal(s.log.length, 2);
  assert.equal(s.config.repo, 'acme/widgets');
  await settle();
  await t.ctrl.sa.sync();
});

test('a damaged database stops everything, shows one error with where the copy is kept, and starts again only after acknowledge', async () => {
  const t = setup();
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(t.db, 'this is not a database'.repeat(100));
  t.flag.on = true;
  const s = await t.value('state');
  assert.equal(s.ok, false);
  assert.equal(s.error.code, 'damaged');
  assert.match(s.error.setAside, /superagent\.db\.damaged-\d+$/);
  assert.equal(fs.existsSync(s.error.setAside), true, 'the damaged copy is kept');
  assert.equal(fs.existsSync(t.db), false);
  // every later tick and call: still stopped, no fresh database appears
  for (let i = 0; i < 3; i++) {
    t.timers.at(-1)!();
    await t.call('state');
  }
  assert.equal(fs.existsSync(t.db), false, 'nothing starts again without the acknowledge');
  assert.equal((await t.call('setRepo', 'acme/widgets')).error.code, 'unavailable');
  // the person confirms: a fresh database
  assert.equal(await t.value('acknowledge'), true);
  const after = await t.value('state');
  assert.equal(after.ok, true);
  assert.deepEqual(after.log, []);
  assert.equal(fs.existsSync(s.error.setAside), true, 'the damaged copy is still kept');
  assert.equal((await t.call('acknowledge')).error.code, 'not_damaged');
});

test('a locked database is retried and recovers; it is not damage, so there is nothing to acknowledge and nothing is replaced', async () => {
  const retries: Array<() => void> = [];
  let locked = true;
  const real = require('node:sqlite').DatabaseSync;
  const t = setup({
    lifecycle: { setTimer: (fn: () => void) => retries.push(fn), clearTimer: () => {} },
    openDb: (file: string) => {
      if (locked) throw Object.assign(new Error('database is locked'), { errcode: 5 });
      return new real(file);
    },
  });
  fs.mkdirSync(t.dir, { recursive: true });
  t.flag.on = true;
  const s = await t.value('state');
  assert.deepEqual([s.ok, s.error.code, s.error.message], [false, 'failed', 'database is locked']);
  assert.equal((await t.call('acknowledge')).error.code, 'not_damaged');
  assert.equal(fs.existsSync(t.db), false, 'no fresh database was made');
  assert.equal(fs.existsSync(`${t.db}.stopped`), false);
  assert.equal(retries.length, 1, 'the calls in between did not retry early');
  locked = false;
  retries[0]();
  t.sent.length = 0;
  t.timers[0](); // the next periodic check sees a store that was not there
  assert.deepEqual(t.sent, ['superagent:changed'], 'the page is told it opened');
  const after = await t.value('state');
  assert.equal(after.ok, true, 'recovered by itself');
});

test('errors come back as values, with a code when there is one; a thrown string is still a message', async () => {
  const t = setup();
  t.flag.on = true;
  assert.deepEqual((await t.call('setRule', 'bugs', 'loud')).error, { message: 'Unknown mode: loud', code: 'invalid_mode' });
  t.ctrl.sa.store.watch.settings.set = () => {
    throw 'plain text';
  };
  assert.deepEqual((await t.call('setPaused', 'all', true)).error, { message: 'plain text', code: null });
  await t.ctrl.sa.sync();
});

test('a source from the app (not the fake) is used when no fake file is named', async () => {
  const started: string[] = [];
  const t = setup({ fake: false, createSource: ({ repo }: any) => ({ start: () => started.push(repo), stop() {} }) });
  t.flag.on = true;
  await t.value('state');
  await t.value('setRepo', 'acme/widgets');
  assert.deepEqual(started, ['acme/widgets']);
});

test('events arriving with no open store are dropped quietly, and the default flag and timer exist', async () => {
  const t = setup({ fake: false, github: ghDeps(), createSource: undefined });
  t.flag.on = true;
  await t.value('state');
  await t.value('setRepo', 'acme/widgets');
  await t.ctrl.sa.sync();
  const real = register({ handle() {} }, { app: { getPath: () => t.root }, broadcastAll() {} }, { dir: path.join(t.root, 'default-flag') });
  assert.equal(real.sa.store, null, 'the flag is off by default');
  assert.equal(fs.existsSync(path.join(t.root, 'default-flag')), false);
});

test('an event the source sends after the store closed is dropped; a failing intake and an unreadable fake file are reported, not thrown', async () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  let emit: (e: unknown) => void = () => {};
  const t = setup({
    fake: false,
    createSource: ({ emit: e }: any) => {
      emit = e;
      return { start() {}, stop() {} };
    },
  });
  t.flag.on = true;
  await t.value('setRepo', 'acme/widgets');
  await t.value('setAllowed', ['alice']);
  // the store goes away through the lifecycle alone, while the runner still holds its source
  t.flag.on = false;
  await t.ctrl.sa.sync();
  emit(ev());
  await settle();
  t.flag.on = true;
  assert.equal((await t.value('state')).log.length, 0, 'nothing was recorded after the close');

  // a failing intake: the error is noted and the page keeps working
  t.ctrl.sa.store.watch.recordDecision = () => {
    throw new Error('disk full');
  };
  emit(ev({ externalId: 'x' }));
  await settle();
  assert.ok(
    recentIgnored().some((r: any) => /record a Superagent event/.test(JSON.stringify(r))),
    'noted',
  );
  assert.equal((await t.value('state')).ok, true);
  await t.ctrl.sa.sync();

  const bad = setup({ fake: path.join(t.root, 'missing.json') });
  bad.flag.on = true;
  await bad.value('state');
  await bad.value('setRepo', 'acme/widgets');
  assert.ok(
    recentIgnored().some((r: any) => /read the fake Superagent events/.test(JSON.stringify(r))),
    'noted',
  );
});

test('a burst of events tells the page once; the fake events are honored only in an unpackaged build', async () => {
  const t = setup();
  t.flag.on = true;
  await t.value('setAllowed', ['alice']);
  t.sent.length = 0;
  await t.value('setRepo', 'acme/widgets'); // the fake source delivers two events
  await settle();
  const before = t.sent.filter((c) => c === 'superagent:changed').length;
  assert.equal(t.laters.length, 1, 'one pending notice for the whole burst');
  t.laters.shift()!();
  assert.equal(t.sent.filter((c) => c === 'superagent:changed').length, before + 1);
  await t.ctrl.sa.sync();

  const packaged = setup({ packaged: true, github: ghDeps() });
  packaged.flag.on = true;
  await packaged.value('setRepo', 'acme/widgets');
  await settle();
  assert.deepEqual(
    (await packaged.value('state')).source,
    { state: 'watching', repo: 'acme/widgets' },
    'an installed app watches GitHub, never the fake file',
  );
  assert.equal((await packaged.value('state')).log.length, 0);
  await packaged.ctrl.sa.sync();
});

test('the page notice uses a real short timer by default', async () => {
  const t = setup({ later: undefined });
  t.flag.on = true;
  await t.value('setAllowed', ['alice']);
  await t.value('setRepo', 'acme/widgets');
  await settle();
  const before = t.sent.length;
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(t.sent.length, before + 1, 'one notice for the events that arrived');
  await t.ctrl.sa.sync();
});
