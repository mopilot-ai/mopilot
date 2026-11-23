// electron/harness/harnessUpdates.cjs over real harness runs with a fake pty and quiet spawner: versions read and
// offered, the running-chat gate, outcomes after an update (updated, unchanged, failed, broken with one npm retry),
// the restart once idle, and the daily check. Update all is tests/harnessUpdateAll.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { HarnessUpdates, lastLines } = require('../electron/harness/harnessUpdates.cjs');
const { setup, npmMethod } = await import('./support/harness-updates-kit.ts');

test('lastLines keeps the last lines with something on them, without colours', () => {
  assert.equal(lastLines('a\n\n\x1b[31mb\x1b[0m\r\nc\rd\n'), 'b · c · d');
  assert.equal(lastLines('x\ny\nz', 1), 'z');
  assert.equal(lastLines(''), '');
});

test('a check reads each installed harness: its version (its package before detection), the newest, and whether to offer it', async () => {
  const s = setup();
  const [a, b] = [s.updates.check(), s.updates.check()];
  assert.equal(a, b, 'checks asked at once share one');
  const st = await a;
  assert.equal(st.checking, false);
  assert.ok(st.checkedAt);
  const kimi = s.info('acp:kimi');
  assert.deepEqual(
    [kimi.installed, kimi.latest, kimi.updatable, kimi.command, kimi.from, kimi.state, kimi.latestStatus],
    ['1.0.0', '2.2.0', true, 'npm install -g --prefix /p @moonshot-ai/kimi-code@latest', 'npm (/p)', 'idle', null],
  );
  // no package version: detection's
  assert.equal(s.info('codex').installed, '0.162.0');
  assert.equal(s.info('codex').latestStatus, 'unverified');
  assert.ok(
    s.sent.some(([, p]) => p.checking === true),
    'windows see the check under way',
  );
  // force asks the registries again
  await s.updates.check({ force: true });
  assert.deepEqual(s.forgot, ['npm:@moonshot-ai/kimi-code', 'npm:@openai/codex']);
});

test("nothing is offered when the newest isn't newer, doesn't work with MoPilot, can't be read, or the install is blocked", async () => {
  const s = setup({
    knownBad: true,
    methods: {
      codex: npmMethod('@openai/codex'),
      'acp:kimi': npmMethod('@moonshot-ai/kimi-code', { blocked: 'needs-admin' }),
      'acp:goose': {
        via: 'brew',
        argv: ['/b/brew', 'upgrade', 'block-goose-cli'],
        shown: 'brew upgrade block-goose-cli',
        pkg: 'block-goose-cli',
        cask: false,
        env: null,
        blocked: null,
        from: 'Homebrew',
        packageJson: null,
      },
      'acp:cursor': {
        via: 'self',
        argv: ['/c', 'update'],
        shown: 'cursor-agent update',
        pkg: null,
        cask: false,
        env: null,
        blocked: null,
        from: 'standalone install',
        packageJson: null,
      },
      // Homebrew's keg with no brew to run: the newest is still read, through brew on PATH
      'acp:qwen': {
        via: 'brew',
        argv: null,
        shown: null,
        pkg: 'qwen-code',
        cask: false,
        env: null,
        blocked: 'unknown-install',
        from: 'Homebrew',
        packageJson: null,
      },
    },
    installed: [
      { kind: 'codex', bin: '/c', version: '0.162.0' },
      { kind: 'acp:kimi', bin: '/k', version: '1.0.0' },
      { kind: 'acp:goose', bin: '/g', version: '1.55.0' },
      { kind: 'acp:cursor', bin: '/u', version: '2026.10.01' },
      { kind: 'acp:qwen', bin: '/q', version: '0.1.0' },
    ],
    latest: { '@openai/codex': '0.170.0', '@moonshot-ai/kimi-code': '2.2.0', 'block-goose-cli': '1.55.0', 'qwen-code': '0.25.2' },
    versions: {},
  });
  await s.updates.check();
  assert.equal(s.info('codex').updatable, false, 'the newest is known bad');
  assert.equal(s.info('codex').latestStatus, 'knownBad');
  assert.equal(s.info('acp:kimi').updatable, false, 'needs admin rights');
  assert.equal(s.info('acp:goose').updatable, false, 'up to date (through Homebrew)');
  assert.equal(s.info('acp:goose').latest, '1.55.0');
  assert.equal(s.info('acp:cursor').latest, null, 'no package to read the newest from');
  assert.deepEqual([s.info('acp:qwen').latest, s.info('acp:qwen').updatable], ['0.25.2', false]);
  // a row patched after it left the list changes nothing
  s.updates.set('acp:gone', { state: 'waiting' });
  assert.equal(s.info('acp:gone'), undefined);
  // a harness no longer installed leaves the list
  s.setInstalled([{ kind: 'codex', bin: '/c', version: '0.162.0' }]);
  await s.updates.check();
  assert.deepEqual(
    s.updates.state().harnesses.map((h: any) => h.harness),
    ['codex'],
  );
});

test('an update runs its command in a terminal windows attach to; a second click joins it', async () => {
  const s = setup();
  await s.updates.check();
  assert.deepEqual(await s.updates.update('acp:nope'), { ok: false, error: 'not-updatable' });
  const r = await s.updates.update('acp:kimi');
  assert.equal(r.ok, true);
  assert.deepEqual(s.ptys[0].opts.command, ['/p/bin/npm', 'install', '-g', '--prefix', '/p', '@moonshot-ai/kimi-code@latest']);
  assert.deepEqual(s.ptys[0].opts.env, { PATH: '/p/bin:/usr/bin' });
  assert.equal(s.info('acp:kimi').state, 'updating');
  assert.equal(s.info('acp:kimi').runId, r.runId);
  assert.deepEqual(await s.updates.update('acp:kimi'), { ok: true, runId: r.runId });
  assert.equal(s.ptys.length, 1);
});

test('updated: the new version, the newest asked again, and the long-lived process restarted once its chats are idle', async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.versions['acp:kimi'] = '2.2.0';
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 'Fix login' }] });
  await s.end(0);
  const kimi = s.info('acp:kimi');
  assert.deepEqual(kimi.outcome, { result: 'updated', from: '1.0.0', to: '2.2.0', message: 'Updated from 1.0.0', runId: s.ptys[0].id });
  assert.equal(kimi.state, 'idle');
  assert.equal(kimi.installed, '2.2.0');
  assert.equal(kimi.updatable, false);
  assert.ok(s.forgot.includes('npm:@moonshot-ai/kimi-code'));
  // a chat is mid-turn: the restart waits for it
  assert.deepEqual(s.restarts, []);
  s.setBusy({});
  await s.tick();
  assert.deepEqual(s.restarts, ['acp:kimi']);
});

test('unchanged: still the old version and a newer one is out; a restart that fails after a later update is only noted', async () => {
  const s = setup({ restartThrows: true });
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.setHealth(() => ({ version: '1.0.0', broken: null }));
  await s.end(0);
  assert.deepEqual(
    s.info('acp:kimi').outcome.message,
    'Still 1.0.0 after npm install -g --prefix /p @moonshot-ai/kimi-code@latest; 2.2.0 is out',
  );
  // Retry, which moves it: updated, and its restart (no chats) throws and is only noted
  await s.updates.update('acp:kimi');
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  await s.end(0);
  assert.equal(s.info('acp:kimi').outcome.message, 'Updated from 1.0.0');
  assert.deepEqual(s.restarts, []);
});

test('failed: a sentence from the last output lines, or that it was stopped, never the exit code (#1863)', async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.ptys[0].h.onData('npm ERR! code EACCES\nnpm ERR! permission denied\n');
  await s.end(243);
  assert.equal(s.info('acp:kimi').outcome.message, "Didn't update. Permission denied.");
  assert.equal(s.info('acp:kimi').outcome.result, 'failed');
  await s.updates.update('acp:kimi');
  await s.end(1);
  assert.equal(s.info('acp:kimi').outcome.message, "Didn't update.");
  const r = await s.updates.update('acp:kimi');
  s.runs.stop(r.runId);
  await s.flush();
  assert.equal(s.info('acp:kimi').outcome, null, 'Stop has not retired the package command yet');
  await s.end(143);
  assert.equal(s.info('acp:kimi').outcome.message, "Didn't update. It was stopped.");
});

test('broken: npm left out a native package, so once more with optional packages; still broken says how to reinstall', async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.setHealth(() => ({ version: null, broken: 'kimi native binary not installed' }));
  await s.end(0);
  // the retry in a terminal as the first run was, pinned to the newest, with optional packages, said to be a retry
  assert.equal(s.quiet.length, 0);
  assert.deepEqual(s.ptys[1].opts.command, [
    '/p/bin/npm',
    'install',
    '-g',
    '--prefix',
    '/p',
    '@moonshot-ai/kimi-code@2.2.0',
    '--include=optional',
  ]);
  assert.equal(s.info('acp:kimi').state, 'updating');
  assert.equal(s.info('acp:kimi').retrying, true);
  assert.equal(s.info('acp:kimi').runId, s.ptys[1].id);
  await s.end(0, s.ptys[1].h);
  assert.equal(s.info('acp:kimi').retrying, false);
  assert.equal(
    s.info('acp:kimi').outcome.message,
    "Updated but won't start: kimi native binary not installed. Reinstall with npm install -g --prefix /p @moonshot-ai/kimi-code@latest",
  );
  assert.equal(s.info('acp:kimi').outcome.result, 'broken');
  // a broken CLI that isn't npm's is reported at once; so is npm's when the retry can't start
  const b = setup({ methods: { 'acp:kimi': npmMethod('@moonshot-ai/kimi-code', { via: 'bun' }), codex: npmMethod('@openai/codex') } });
  await b.updates.check();
  await b.updates.update('acp:kimi');
  b.setHealth(() => ({ version: '2.2.0', broken: 'exit status 1' }));
  await b.end(0);
  assert.equal(b.info('acp:kimi').outcome.result, 'broken');
  assert.equal(b.quiet.length, 0);
});

test('a quiet update (Update all) downloads again quietly', async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi', { quiet: true });
  s.setHealth(() => ({ version: null, broken: 'kimi native binary not installed' }));
  await s.end(0, s.quiet[0].h);
  assert.equal(s.quiet.length, 2);
  assert.equal(s.ptys.length, 0);
  assert.equal(s.info('acp:kimi').retrying, true);
});

test('the running-chat gate: asked first, then now, or once idle (cancellable)', async () => {
  const s = setup();
  await s.updates.check();
  s.setBusy({
    'acp:kimi': [
      { id: 'c1', title: 'Fix login' },
      { id: 'c2', title: 'Refactor' },
    ],
  });
  assert.deepEqual(await s.updates.update('acp:kimi'), {
    ok: false,
    error: 'chats',
    chats: [
      { id: 'c1', title: 'Fix login' },
      { id: 'c2', title: 'Refactor' },
    ],
  });
  assert.deepEqual(await s.updates.update('acp:kimi', { when: 'idle' }), { ok: true, waiting: true });
  assert.equal(s.info('acp:kimi').state, 'waiting');
  assert.equal(s.info('acp:kimi').waitingFor, 2);
  assert.equal(s.ptys.length, 0);
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 'Fix login' }] });
  await s.tick();
  assert.equal(s.info('acp:kimi').waitingFor, 1);
  assert.equal(s.updates.cancelWait('acp:kimi'), true);
  assert.equal(s.info('acp:kimi').state, 'idle');
  assert.equal(s.updates.cancelWait('acp:kimi'), false);
  // waits again, and starts once they are idle
  await s.updates.update('acp:kimi', { when: 'idle' });
  s.setBusy({});
  await s.tick();
  assert.equal(s.ptys.length, 1);
  assert.equal(s.info('acp:kimi').state, 'updating');
  // now: runs under the chats (they restart on the new binary when their turn ends)
  await s.end(1);
  s.setBusy({ codex: [{ id: 'c3', title: 'x' }] });
  assert.equal((await s.updates.update('codex', { when: 'now' })).ok, true);
});

test("a waiting update whose harness left the list doesn't start; a launch refused by the package manager lock says so", async () => {
  const s = setup();
  await s.updates.check();
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 't' }] });
  await s.updates.update('acp:kimi', { when: 'idle' });
  s.setInstalled([{ kind: 'codex', bin: '/p/bin/codex', version: '0.162.0' }]);
  s.updates.infos.delete('acp:kimi');
  s.setBusy({});
  await s.tick();
  assert.equal(s.ptys.length, 0);
  // codex's npm run holds the lock; kimi's npm update is refused
  const t = setup();
  await t.updates.check();
  await t.updates.update('codex');
  const r = await t.updates.update('acp:kimi');
  assert.deepEqual(r, { ok: false, error: 'busy', by: 'codex' });
});

test("an update run whose harness was read away, or another run's end, settles nothing it doesn't own", async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.updates.methods.delete('acp:kimi');
  await s.end(0);
  assert.equal(s.updates.pending.size, 0);
  assert.equal(s.info('acp:kimi').outcome, null);
  // an install run of another harness ends: not an update of ours
  s.runs.start('acp:goose', 0);
  await s.end(0);
  assert.equal(s.updates.pending.size, 0);
});

test('a read after the update that fails keeps what the row had', async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  s.updates.o.method = () => {
    throw new Error('fs gone');
  };
  await s.end(0);
  assert.equal(s.info('acp:kimi').outcome.result, 'updated');
});

test('the daily check runs a day (and up to an hour) apart, never keeping the app up, and stops when asked', async () => {
  const s = setup();
  const stop = s.updates.schedule();
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, 24 * 3600_000 + 1_800_000);
  assert.equal(s.timers[0].unref, true);
  await s.tick();
  assert.ok(s.updates.state().checkedAt, 'checked');
  assert.equal(s.timers.length, 1, 'and armed again');
  stop();
  assert.equal(s.timers.length, 0);
  // a failing check is only noted
  s.updates.check = async () => Promise.reject(new Error('offline'));
  s.updates.schedule();
  await s.tick();
});

test("defaults: the clock port's time and timers", (t) => {
  const clock = useFakeClock(t, 1234);
  const u = new HarnessUpdates({ runs: { onEnd: () => () => undefined }, broadcast: () => undefined });
  assert.equal(u.o.now(), 1234);
  assert.equal(u.o.timers.setTimeout, clock.setTimeout);
});

test("a check that started before an update ended can't write back the old version over the read after it", async () => {
  const s = setup();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  // a check starts while the update runs; its newest-version answer is slow
  let release!: () => void;
  const npm = s.updates.o.latest.npm;
  s.updates.o.latest.npm = (pkg: string) =>
    pkg === '@moonshot-ai/kimi-code' ? new Promise((r) => (release = () => r('2.2.0'))) : npm(pkg);
  const stale = s.updates.check();
  await s.flush();
  // the update ends: its own read (started later) sees 2.2.0
  s.updates.o.latest.npm = npm;
  s.versions['acp:kimi'] = '2.2.0';
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  await s.end(0);
  assert.equal(s.info('acp:kimi').installed, '2.2.0');
  // the older check settles last: dropped
  s.versions['acp:kimi'] = '1.0.0';
  release();
  await stale;
  assert.equal(s.info('acp:kimi').installed, '2.2.0');
  assert.equal(s.info('acp:kimi').updatable, false);
});

test("one harness that can't be read keeps its row; the others are read", async () => {
  const s = setup();
  await s.updates.check();
  const method = s.updates.o.method;
  s.updates.o.method = (kind: string, bin: string) => {
    if (kind === 'codex') throw new Error('fs gone');
    return method(kind, bin);
  };
  s.versions['acp:kimi'] = '2.0.0';
  await s.updates.check();
  assert.equal(s.info('acp:kimi').installed, '2.0.0');
  assert.equal(s.info('codex').installed, '0.162.0', 'kept as it was');
});

test("a CLI's own updater that leaves it older than the package's newest says it may follow a slower channel", async () => {
  const self = {
    ...npmMethod('@anthropic-ai/claude-code'),
    via: 'self',
    argv: ['/c', 'update'],
    shown: 'claude update',
    env: null,
    packageJson: null,
  };
  const s = setup({
    methods: { claude: self },
    installed: [{ kind: 'claude', bin: '/c', version: '2.1.296' }],
    latest: { '@anthropic-ai/claude-code': '2.1.310' },
    versions: {},
  });
  await s.updates.check();
  await s.updates.update('claude');
  s.setHealth(() => ({ version: '2.1.302', broken: null }));
  s.updates.o.readVersion = async () => '2.1.296';
  await s.end(0);
  // 2.1.302 > 2.1.296 moved: updated; were it still 2.1.296, the channel note
  assert.equal(s.info('claude').outcome.message, 'Updated from 2.1.296');
  await s.updates.check();
  await s.updates.update('claude');
  s.setHealth(() => ({ version: '2.1.296', broken: null }));
  await s.end(0);
  assert.equal(s.info('claude').outcome.message, 'Still 2.1.296 after claude update: its updater may follow a slower channel than 2.1.310');
});

test('an update started another way stops waiting for idle; restarts wait once per harness however many updates land', async () => {
  const s = setup();
  await s.updates.check();
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 't' }] });
  await s.updates.update('acp:kimi', { when: 'idle' });
  assert.equal(s.timers.length, 1);
  await s.updates.update('acp:kimi', { when: 'now' });
  assert.equal(s.timers.length, 0, 'the wait is over');
  assert.equal(s.updates.waits.size, 0);
  // two updates land while a chat works: one restart wait
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  s.versions['acp:kimi'] = '2.2.0';
  s.updates.restartWhenIdle('acp:kimi');
  s.updates.restartWhenIdle('acp:kimi');
  assert.equal(s.timers.length, 1);
  s.setBusy({});
  await s.tick();
  assert.deepEqual(s.restarts, ['acp:kimi']);
  // after it restarted, a later update waits again
  s.updates.restartWhenIdle('acp:kimi');
  assert.deepEqual(s.restarts, ['acp:kimi', 'acp:kimi']);
});
