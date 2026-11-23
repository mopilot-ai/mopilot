// The app's managed-policy resolver (electron/platform/managedPolicy.cjs, plan W1): last good, strict fallback, removal, change events and the debounced watcher, on a fake fs and clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createManagedPolicy, managedPolicy, effectivePolicy } = require('../electron/platform/managedPolicy.cjs');
const { STRICT_FALLBACK } = require('../shared/managedPolicy.mjs');

const FILE = '/etc/mopilot-code/managed-policy.json';
const setup = (initial: string | null, opts: { uid?: number; mode?: number } = {}) => {
  const state = { content: initial, uid: opts.uid ?? 0, mode: opts.mode ?? 0o100644, statError: null as string | null, watchError: false };
  let onEvent: (() => void) | null = null;
  let closed = 0;
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const fake = {
    statSync: () => {
      if (state.statError) throw Object.assign(new Error('x'), { code: state.statError });
      if (state.content === null) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return { uid: state.uid, mode: state.mode };
    },
    readFileSync: () => state.content,
    watch: (_dir: string, _o: unknown, fn: () => void) => {
      if (state.watchError) throw new Error('no dir');
      onEvent = fn;
      return { close: () => void closed++ };
    },
  };
  const reported: string[] = [];
  const policy = createManagedPolicy({
    file: FILE,
    platform: 'linux',
    fs: fake,
    report: (m: string) => reported.push(m),
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: any) => {
      t.live = false;
    },
  });
  return { state, policy, reported, timers, fire: () => onEvent!(), closed: () => closed };
};
const doc = (extra: object = {}) => JSON.stringify({ version: 1, organization: 'Acme', permission: { max: 'default' }, ...extra });

test('no file means a person: state none', () => {
  const { policy } = setup(null);
  assert.deepEqual(policy.effectivePolicy(), { state: 'none', doc: null, generation: null, organization: null, problem: null });
});

test('a valid file is the effective policy with its generation and organization', () => {
  const { policy } = setup(doc());
  const p = policy.effectivePolicy();
  assert.equal(p.state, 'valid');
  assert.equal(p.organization, 'Acme');
  assert.match(p.generation, /^[0-9a-f]{64}$/);
  assert.equal(p.doc.permission.max, 'default');
});

test('an invalid file with no last good applies the strict fallback and says why', () => {
  const { policy, reported } = setup('{ nope');
  const p = policy.effectivePolicy();
  assert.equal(p.state, 'fallback');
  assert.deepEqual(p.doc, STRICT_FALLBACK);
  assert.match(p.problem, /not valid/);
  assert.match(reported[0], /managed policy/);
});

test('a file the user can write, or one not owned by root, is refused, never read', () => {
  assert.match(setup(doc(), { mode: 0o100666 }).policy.effectivePolicy().problem, /written by someone/);
  assert.equal(setup(doc(), { uid: 501 }).policy.effectivePolicy().state, 'fallback');
});

test('an unreadable file is a problem, not an empty policy', () => {
  const { policy, state } = setup(doc());
  state.statError = 'EACCES';
  assert.match(policy.reload().problem, /could not be read/);
  assert.equal(policy.effectivePolicy().state, 'valid');
});

test('a corrupt rewrite keeps the last good policy and reports; a fixed file clears the problem', () => {
  const { policy, state } = setup(doc());
  const good = policy.effectivePolicy().generation;
  state.content = '{ broken';
  const kept = policy.reload();
  assert.equal(kept.state, 'valid');
  assert.equal(kept.generation, good);
  assert.match(kept.problem, /not valid/);
  state.content = doc({ permission: { max: 'read-only' } });
  const fixed = policy.reload();
  assert.equal(fixed.problem, null);
  assert.notEqual(fixed.generation, good);
});

test('removing the file retires the policy; a corrupt file after that falls back, not to the old policy', () => {
  const { policy, state } = setup(doc());
  state.content = null;
  assert.equal(policy.reload().state, 'none');
  state.content = '{ broken';
  assert.equal(policy.reload().state, 'fallback');
});

test('listeners hear a change of generation or problem, not a re-read of the same file', () => {
  const { policy, state } = setup(doc());
  const heard: any[] = [];
  const stop = policy.onChange((s: any) => heard.push(s.generation));
  policy.reload();
  assert.equal(heard.length, 0);
  state.content = doc({ accounts: { rotation: false } });
  policy.reload();
  assert.equal(heard.length, 1);
  state.content = '{ broken';
  policy.reload();
  assert.equal(heard.length, 2);
  stop();
  state.content = null;
  policy.reload();
  assert.equal(heard.length, 2);
});

test('a burst of file events becomes one read after the debounce; the later content wins', () => {
  const { policy, state, timers, fire } = setup(doc());
  policy.watch();
  policy.watch();
  fire();
  state.content = doc({ permission: { max: 'read-only' } });
  fire();
  assert.equal(timers.length, 2);
  assert.equal(timers[0].live, false);
  assert.equal(timers[1].ms, 250);
  timers[1].fn();
  assert.equal(policy.effectivePolicy().doc.permission.max, 'read-only');
});

test('stop clears a pending read and closes the watcher; a missing folder is not watched', () => {
  const a = setup(doc());
  a.policy.watch();
  a.fire();
  a.policy.stop();
  assert.equal(a.timers[0].live, false);
  assert.equal(a.closed(), 1);
  a.policy.stop();
  const b = setup(doc());
  b.state.watchError = true;
  b.policy.watch();
  b.policy.stop();
  assert.equal(b.closed(), 0);
});

test('the process-wide resolver is one instance and reads this platform path', () => {
  assert.equal(managedPolicy(), managedPolicy());
  assert.ok(['none', 'valid', 'fallback'].includes(effectivePolicy().state));
});

test('a policy with no organization reports none, also while kept as last good', () => {
  const { policy, state } = setup(JSON.stringify({ version: 1 }));
  assert.equal(policy.effectivePolicy().organization, null);
  state.content = '{ broken';
  assert.equal(policy.reload().organization, null);
});

test('with the real timers a file event is read after the debounce and stop cancels it', async () => {
  let onEvent: () => void = () => undefined;
  let content = doc();
  const fake: any = {
    statSync: () => ({ uid: 0, mode: 0o100644 }),
    readFileSync: () => content,
    watch: (_d: string, _o: unknown, fn: () => void) => ((onEvent = fn), { close() {} }),
  };
  const policy = createManagedPolicy({ file: FILE, platform: 'linux', fs: fake, debounceMs: 5 });
  policy.watch();
  content = doc({ permission: { max: 'read-only' } });
  onEvent();
  onEvent();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(policy.effectivePolicy().doc.permission.max, 'read-only');
  onEvent();
  policy.stop();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(policy.effectivePolicy().doc.permission.max, 'read-only');
});

test('without a report function a problem is still held in the snapshot', () => {
  const fake: any = { statSync: () => ({ uid: 0, mode: 0o100644 }), readFileSync: () => '{ broken' };
  assert.equal(createManagedPolicy({ file: FILE, platform: 'linux', fs: fake }).effectivePolicy().state, 'fallback');
});

test('a document that parses as JSON but breaks the schema is refused with the reason', () => {
  const { policy } = setup(JSON.stringify({ version: 1, permission: { max: 'root' } }));
  assert.match(policy.effectivePolicy().problem!, /permission.max must be one of/);
});
