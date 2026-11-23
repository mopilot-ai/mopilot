// Superagent watch service, runner and fake source: what Settings › Superagent reads and changes, and when the event source runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../electron/superagent/store/index.cjs');
const { migrate } = require('../electron/superagent/store/migrations.cjs');
const { createWatch, WatchError, describe, problemOf } = require('../electron/superagent/watch.cjs');
const { createRunner } = require('../electron/superagent/runner.cjs');
const { createFakeSource } = require('../electron/superagent/fakeSource.cjs');
const { createIntake } = require('../electron/superagent/intake/intake.cjs');

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
function setup(over: any = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  let t = 1_700_000_000_000;
  const store = createStore({ db, now: () => (t += 1000) });
  const calls = { changed: 0, ack: 0 };
  const state = { store: store as any, error: null as any, on: true };
  const watch = createWatch({
    getStore: () => state.store,
    getError: () => state.error,
    enabled: () => state.on,
    onChange: () => {
      calls.changed++;
    },
    acknowledge: () => {
      calls.ack++;
    },
    ...over,
  });
  return { store, watch, state, calls, intake: createIntake({ store, now: () => t }) };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e instanceof WatchError ? e.code : `other:${e.message}`;
  }
  return 'no error';
};

test('state: off, not open (with why), and open with the settings, the log and the precision', async () => {
  const { watch, state, store, intake } = setup();
  const open: any = watch.state();
  assert.equal(open.ok, true);
  assert.deepEqual(
    open.config.rules.map((r: any) => [r.id, r.mode, r.available]),
    [
      ['explicit', 'observe', true],
      ['ci', 'observe', false],
      ['bugs', 'observe', true],
      ['questions', 'observe', true],
    ],
  );
  assert.deepEqual([open.config.repo, open.config.allowed, open.log, open.reconcile, open.stats.precision], [null, [], [], [], null]);
  watch.setRepo('acme/widgets');
  watch.setAllowed(['alice']);
  await intake.receive(ev());
  const row = (watch.state() as any).log[0];
  assert.deepEqual([row.verdict, row.what, row.mark], ['Would accept', 'Issue #7 from alice: The app crashes on start', null]);
  state.on = false;
  assert.deepEqual(watch.state(), { ok: false, error: { code: 'off', message: 'Superagent is off.', setAside: null } });
  state.on = true;
  state.store = null;
  assert.equal((watch.state() as any).error.message, 'Superagent is starting.');
  state.error = Object.assign(new Error('the database could not be read'), {
    name: 'StoreDamagedError',
    setAside: '/x/superagent.db.damaged-1',
  });
  assert.deepEqual((watch.state() as any).error, {
    code: 'damaged',
    message: 'the database could not be read',
    setAside: '/x/superagent.db.damaged-1',
  });
  state.error = Object.assign(new Error('newer'), { name: 'StoreNewerError' });
  assert.equal((watch.state() as any).error.code, 'newer');
  state.error = new Error('database is locked');
  assert.deepEqual((watch.state() as any).error, { code: 'failed', message: 'database is locked', setAside: null });
  assert.equal(problemOf({ name: 'StoreDamagedError', message: 'x' }).setAside, null);
  assert.equal(problemOf('text').message, 'text');
  // needs-reconcile events show
  store.events.record('github', 'r1', {});
  store.events.claim('github', 'r1', 'dead', 1);
  store.events.commit('github', 'r1', 'dead');
  state.store = store;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((watch.state() as any).reconcile.length, 1);
});

test('describe: a long text is cut, a missing number and an unknown kind are still a sentence', () => {
  const base = { kind: 'issue.comment', actor: 'bob', text: 'a\n\n b', subject: { number: 3 } };
  assert.equal(describe(base), 'Comment on issue #3 from bob: a b');
  assert.equal(describe({ ...base, text: 'x'.repeat(200) }), `Comment on issue #3 from bob: ${'x'.repeat(90)}…`);
  assert.equal(
    describe({ ...base, text: `${'x'.repeat(89)}😀tail` }),
    `Comment on issue #3 from bob: ${'x'.repeat(89)}😀…`,
    'cut on a whole character',
  );
  assert.equal(describe({ ...base, kind: 'weird', text: '', subject: { number: null } }), 'weird from bob');
});

test('setRepo: owner/name, a URL, or nothing clears it; anything else is refused and keeps the old one', () => {
  const { watch, calls } = setup();
  assert.equal(watch.setRepo(' https://github.com/acme/widgets.git/ ').repo, 'acme/widgets');
  assert.equal(calls.changed, 1);
  assert.equal(
    code(() => watch.setRepo('acme')),
    'invalid_repo',
  );
  assert.equal(
    code(() => watch.setRepo(42)),
    'invalid_repo',
  );
  assert.equal((watch.state() as any).config.repo, 'acme/widgets');
  assert.equal(watch.setRepo('').repo, null);
  assert.equal(watch.setRepo('acme/widgets').repo, 'acme/widgets');
  assert.equal(watch.setRepo(null).repo, null);
  assert.equal(calls.changed, 4, 'a refused change tells nobody');
});

test('setAllowed: logins are cleaned, a bad one refuses the whole list, a non-list is refused', () => {
  const { watch } = setup();
  assert.deepEqual(watch.setAllowed(['@Alice', 'bob', 'ALICE']).allowed, ['Alice', 'bob']);
  assert.equal(
    code(() => watch.setAllowed(['ok', 'not ok'])),
    'invalid_login',
  );
  assert.equal(
    code(() => watch.setAllowed('alice')),
    'invalid_login',
  );
  assert.deepEqual((watch.state() as any).config.allowed, ['Alice', 'bob'], 'nothing changed');
  assert.deepEqual(watch.setAllowed([]).allowed, []);
});

test('setRuleMode: Off and Observe; Auto is not available yet; unknown rules and modes are refused', () => {
  const { watch } = setup();
  assert.equal(watch.setRuleMode('bugs', 'off').rules.find((r: any) => r.id === 'bugs').mode, 'off');
  assert.equal(watch.setRuleMode('bugs', 'observe').rules.find((r: any) => r.id === 'bugs').mode, 'observe');
  assert.equal(
    code(() => watch.setRuleMode('bugs', 'auto')),
    'auto_unavailable',
  );
  assert.equal(
    code(() => watch.setRuleMode('nope', 'off')),
    'unknown_rule',
  );
  assert.equal(
    code(() => watch.setRuleMode('bugs', 'loud')),
    'invalid_mode',
  );
  assert.equal(
    code(() => watch.setRuleMode(5, 'off')),
    'unknown_rule',
  );
  assert.equal(
    code(() => watch.setRuleMode('bugs', 5)),
    'unknown_rule',
  );
});

test('setPaused: everything, or GitHub alone; any other scope is refused', () => {
  const { watch } = setup();
  assert.deepEqual(watch.setPaused('all', true).paused, { all: true, github: false });
  assert.deepEqual(watch.setPaused('github', true).paused, { all: true, github: true });
  assert.deepEqual(watch.setPaused('all', false).paused, { all: false, github: true });
  assert.deepEqual(watch.setPaused('github', 'yes').paused, { all: false, github: false }, 'only true pauses');
  assert.equal(
    code(() => watch.setPaused('slack', true)),
    'invalid_scope',
  );
});

test('mark: Right, Wrong, cleared; the precision follows; a bad mark or an old entry is refused', async () => {
  const { watch, intake, calls } = setup();
  watch.setRepo('acme/widgets');
  watch.setAllowed(['alice']);
  await intake.receive(ev());
  const id = (watch.state() as any).log[0].id;
  assert.equal(watch.mark(id, 'right').precision, 1);
  assert.equal(watch.mark(id, 'wrong').precision, 0);
  assert.equal(watch.mark(id, null).precision, null);
  assert.equal(
    code(() => watch.mark(id, 'maybe')),
    'invalid_mark',
  );
  assert.equal(
    code(() => watch.mark('gone', 'right')),
    'unknown_decision',
  );
  assert.equal(
    code(() => watch.mark(7, 'right')),
    'unknown_decision',
  );
  assert.ok(calls.changed >= 5);
});

test('every change needs a running store', () => {
  const { watch, state } = setup();
  state.store = null;
  for (const fn of [
    () => watch.setRepo('a/b'),
    () => watch.setAllowed([]),
    () => watch.setRuleMode('bugs', 'off'),
    () => watch.setPaused('all', true),
    () => watch.mark('x', 'right'),
  ]) {
    assert.equal(code(fn), 'unavailable');
  }
});

test('acknowledgeDamage: only after real damage; a locked or failing database has nothing to replace', () => {
  const { watch, state, calls } = setup();
  state.store = null;
  state.error = new Error('database is locked');
  assert.equal(
    code(() => watch.acknowledgeDamage()),
    'not_damaged',
  );
  state.error = null;
  assert.equal(
    code(() => watch.acknowledgeDamage()),
    'not_damaged',
  );
  assert.equal(calls.ack, 0, 'nothing started');
  state.error = Object.assign(new Error('bad'), { name: 'StoreDamagedError' });
  assert.equal(watch.acknowledgeDamage(), true);
  assert.equal(calls.ack, 1);
});

test('runner: starts for a chosen repo, restarts for another, stops on pause or flag off, and says why it is stopped', async () => {
  const log: string[] = [];
  const emitters: any[] = [];
  let store: any = null;
  let config: any = { repo: null, paused: { all: false, github: false } };
  const received: unknown[] = [];
  const runner = createRunner({
    getStore: () => store,
    getConfig: () => config,
    createSource: ({ repo, emit }: any) => {
      emitters.push(emit);
      return { start: () => log.push(`start ${repo}`), stop: () => log.push(`stop ${repo}`) };
    },
    receive: async (e: unknown) => {
      received.push(e);
      if (e === 'boom') throw new Error('intake failed');
    },
    onError: (e: Error) => log.push(`error ${e.message}`),
  });
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'off' });
  store = {};
  runner.sync();
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'no_repo' });
  config = { repo: 'a/b', paused: { all: false, github: false } };
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'idle' });
  runner.sync();
  runner.sync();
  assert.deepEqual(log, ['start a/b'], 'started once');
  assert.deepEqual(runner.status(), { state: 'watching', repo: 'a/b' });
  emitters[0]('e1');
  assert.deepEqual(received, ['e1']);
  config = { repo: 'c/d', paused: { all: false, github: false } };
  runner.sync();
  assert.deepEqual(log.slice(1), ['stop a/b', 'start c/d']);
  emitters[0]('late');
  assert.deepEqual(received, ['e1'], 'a replaced source emits nothing more');
  emitters[1]('boom');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(log.at(-1), 'error intake failed');
  config = { repo: 'c/d', paused: { all: false, github: true } };
  runner.sync();
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'paused' });
  config = { repo: 'c/d', paused: { all: true, github: false } };
  runner.sync();
  assert.equal(log.filter((l) => l === 'stop c/d').length, 1);
  config = { repo: 'c/d', paused: { all: false, github: false } };
  runner.sync();
  store = null;
  runner.sync();
  assert.equal(log.at(-1), 'stop c/d');
  runner.stop();
  runner.stop();
});

test('runner without a source in this build says so and never starts', () => {
  const runner = createRunner({
    getStore: () => ({}),
    getConfig: () => ({ repo: 'a/b', paused: { all: false, github: false } }),
    createSource: null,
    receive: async () => {},
  });
  runner.sync();
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'no_source' });
  // the default error sink does not throw
  const r2 = createRunner({
    getStore: () => ({}),
    getConfig: () => ({ repo: 'a/b', paused: { all: false, github: false } }),
    createSource: ({ emit }: any) => ({ start: () => emit('x'), stop() {} }),
    receive: async () => {
      throw new Error('x');
    },
  });
  r2.sync();
});

test('runner: a source that cannot be created or started is reported once, not retried until the repository changes, and never throws', () => {
  const errors: string[] = [];
  const config: any = { repo: 'a/b', paused: { all: false, github: false } };
  let mode = 'create';
  let creates = 0;
  const runner = createRunner({
    getStore: () => ({}),
    getConfig: () => config,
    createSource: () => {
      creates++;
      if (mode === 'create') throw new Error('no token');
      return {
        start: () => {
          if (mode === 'start') throw new Error('bad start');
        },
        stop() {},
      };
    },
    receive: async () => {},
    onError: (e: Error) => errors.push(e.message),
  });
  runner.sync();
  runner.sync();
  runner.sync();
  assert.deepEqual([errors, creates], [['no token'], 1], 'reported once, not retried');
  assert.deepEqual(runner.status(), { state: 'stopped', reason: 'error' });
  mode = 'start';
  config.repo = 'c/d';
  runner.sync();
  assert.deepEqual(errors, ['no token', 'bad start']);
  assert.equal(runner.status().reason, 'error');
  mode = 'ok';
  config.repo = 'e/f';
  runner.sync();
  assert.deepEqual(runner.status(), { state: 'watching', repo: 'e/f' });
  // a pause clears the latch, so resuming tries again
  mode = 'create';
  config.repo = 'g/h';
  runner.sync();
  assert.equal(runner.status().reason, 'error');
  config.paused.all = true;
  runner.sync();
  mode = 'ok';
  config.paused.all = false;
  runner.sync();
  assert.deepEqual(runner.status(), { state: 'watching', repo: 'g/h' });
});

test('fake source: emits the events of its repo once, stops when told, and reports a bad file', () => {
  const emitted: unknown[] = [];
  const errors: unknown[] = [];
  const events = [
    ev({ externalId: 'a' }),
    ev({ externalId: 'b', repo: { fullName: 'other/repo' } }),
    ev({ externalId: 'c', repo: { fullName: 'ACME/WIDGETS' } }),
    null,
  ];
  const s = createFakeSource({
    repo: 'acme/widgets',
    emit: (e: any) => emitted.push(e.externalId),
    readEvents: () => JSON.stringify(events),
    onError: (e: unknown) => errors.push(e),
  });
  s.start();
  assert.deepEqual(emitted, ['a', 'c']);
  const stopped = createFakeSource({
    repo: 'acme/widgets',
    emit: (e: any) => {
      emitted.push(`s-${e.externalId}`);
      stopped.stop();
    },
    readEvents: () => JSON.stringify([ev({ externalId: 'x' }), ev({ externalId: 'y' })]),
    onError: () => {},
  });
  stopped.start();
  assert.deepEqual(emitted.slice(2), ['s-x'], 'stopped after the first');
  createFakeSource({
    repo: 'a/b',
    emit: () => assert.fail('nothing to emit'),
    readEvents: () => '{"not":"a list"}',
    onError: () => {},
  }).start();
  createFakeSource({ repo: 'a/b', emit() {}, readEvents: () => '{oops', onError: (e: unknown) => errors.push(e) }).start();
  assert.equal(errors.length, 1);
});
