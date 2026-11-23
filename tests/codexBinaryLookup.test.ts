// Which Codex binary main runs (electron/app/codexServer.cjs): the saved choice, else the newest installed copy, its
// versions asked off main's event loop all at once; callers share the probe in flight, a forced refresh replaces it,
// and the latest started is remembered. Electron, the filesystem's system paths and child processes are faked.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
const ready = async (cfg: any = {}) => {
  const h = await loadMain(cfg);
  await h.ready();
  return h;
};
/** Answers each `--version` by hand, in any order; other commands answer at once. */
function versionGate(h: any) {
  const asked: { cmd: string; answer: (stdout: string) => void }[] = [];
  h.cp.exec = (cmd: string, args: string[]) => {
    if (args[0] !== '--version') return { stdout: '' };
    const d = deferred();
    asked.push({ cmd, answer: (stdout) => d.resolve({ stdout }) });
    return d.promise;
  };
  return asked;
}
const installed = (h: any, ...paths: string[]) => {
  for (const p of paths) h.exists.add(p);
};

test('codex binary: the saved choice, else the newest installed copy, else plain "codex"', async () => {
  const h = await ready();
  const findBin = h.one('Accounts').opts.findBin;
  const bin = (name: string) => {
    const p = path.join(h.tmp, name);
    fs.writeFileSync(p, '');
    return p;
  };
  const a = bin('codex-a');
  const b = bin('codex-b');
  const link = path.join(h.tmp, 'codex-link');
  fs.symlinkSync(a, link);
  const plain = bin('codex-plain');
  process.env.CODEX_BIN = a;
  h.mod('platform/env.cjs').which.mock.mockImplementation(() => link);
  h.exists.add('/opt/homebrew/bin/codex');
  h.exists.add('/usr/local/bin/codex');
  const versions: Record<string, string> = {
    [a]: 'codex-cli 0.190.0\n',
    '/opt/homebrew/bin/codex': '0.200.1',
    '/usr/local/bin/codex': '0.200',
  };
  h.cp.exec = (c: string) => (c in versions ? { stdout: versions[c] } : { err: new Error('no version') });
  const real = fs.realpathSync;
  const rp = mock.method(fs, 'realpathSync', (p: string) => {
    if (p.startsWith('/opt') || p.startsWith('/usr')) throw new Error('no realpath');
    return real(p);
  });
  try {
    const r = await h.invoke('codex:binaries');
    assert.deepEqual(r.candidates, [
      { path: a, version: '0.190.0', via: 'unknown', from: '' },
      { path: '/opt/homebrew/bin/codex', version: '0.200.1', via: 'unknown', from: '' },
      { path: '/usr/local/bin/codex', version: '0.200', via: 'unknown', from: '' },
    ]);
    assert.equal(r.current, '/opt/homebrew/bin/codex');
    assert.equal(findBin(), '/opt/homebrew/bin/codex', 'cached');
    h.writeState({ codexBin: b });
    assert.equal(findBin(), b);
    h.writeState({ codexBin: path.join(h.tmp, 'gone') });
    assert.equal(findBin(), '/opt/homebrew/bin/codex');
    // copies without a version sort last
    process.env.CODEX_BIN = plain;
    h.exists.clear();
    h.mod('platform/env.cjs').which.mock.mockImplementation(() => a);
    const r2 = await h.invoke('codex:binaries');
    assert.deepEqual(r2.candidates, [
      { path: plain, version: null, via: 'unknown', from: '' },
      { path: a, version: '0.190.0', via: 'unknown', from: '' },
    ]);
    assert.equal(r2.current, a);
    // either side of the comparison may lack a version
    process.env.CODEX_BIN = a;
    h.mod('platform/env.cjs').which.mock.mockImplementation(() => plain);
    assert.equal((await h.invoke('codex:binaries')).current, a);
    process.env.CODEX_BIN = plain;
    h.mod('platform/env.cjs').which.mock.mockImplementation(() => a);
    // both updated in place: a binary's version is asked again only once the file changes
    versions[plain] = '1.0-beta';
    versions[a] = '1.0';
    fs.writeFileSync(plain, 'updated');
    fs.writeFileSync(a, 'updated');
    assert.equal((await h.invoke('codex:binaries')).current, a, 'a release ranks above its prerelease');
    delete process.env.CODEX_BIN;
    h.mod('platform/env.cjs').which.mock.mockImplementation(() => null);
    assert.deepEqual(await h.invoke('codex:binaries'), { candidates: [], current: 'codex' });
  } finally {
    rp.mock.restore();
    delete process.env.CODEX_BIN;
  }
  const server = h.one('AppServer');
  assert.equal(server.opts.findBin, findBin, 'the app-server and the account helpers look it up alike');
  assert.equal(findBin(), 'codex');
  // the login shell's, with loopback kept off any proxy so the account relay sees the app-server itself
  assert.deepEqual(server.opts.env(), { PATH: '/bin', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  server.opts.onCrashReport(1, null, 'x'.repeat(3000));
  server.opts.onCrashReport(null, 'SIGKILL', 'err');
  const errs = calls(h.one('Telemetry').error).map((c: any) => [c[0].message, c[0].stack.length]);
  assert.deepEqual(errs, [
    ['codex app-server exited (1)', 2000],
    ['codex app-server exited (SIGKILL)', 3],
  ]);
});

test('codex binary on Windows: candidates from the usual places, compared without case', async () => {
  const h = await ready({ platform: 'win32' });
  const p = path.join(h.tmp, 'Codex.exe');
  fs.writeFileSync(p, '');
  h.mod('platform/winbin.cjs').windowsCandidates.mock.mockImplementation(() => [p, p.toUpperCase()]);
  const r = await h.invoke('codex:binaries');
  assert.deepEqual(
    r.candidates.map((c: any) => c.path),
    [p],
  );
  assert.equal(calls(h.mod('platform/winbin.cjs').windowsCandidates)[0][0], 'codex');
});

test("the versions are asked at once, off main's event loop, and callers meanwhile share that probe", async () => {
  const h = await ready();
  const findBin = h.one('Accounts').opts.findBin;
  installed(h, '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  const asked = versionGate(h);
  const first = findBin();
  const second = findBin();
  assert.ok(first instanceof Promise, 'not known yet: a promise of it');
  await flush();
  assert.deepEqual(
    asked.map((a) => a.cmd),
    ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    'both asked before either answered, once for both callers',
  );
  asked[1].answer('codex-cli 0.20.0');
  asked[0].answer('codex-cli 0.10.0');
  assert.deepEqual(await Promise.all([first, second]), ['/usr/local/bin/codex', '/usr/local/bin/codex']);
  assert.equal(findBin(), '/usr/local/bin/codex', 'known now: answered at once');
  assert.equal(asked.length, 2);
  assert.equal(h.cp.execFileSync.mock.callCount(), 0, 'nothing ran synchronously');
});

test('a forced refresh replaces the probe in flight, and only the latest started is remembered, in either order', async () => {
  for (const order of ['newer first', 'older first']) {
    const h = await ready();
    const findBin = h.one('Accounts').opts.findBin;
    installed(h, '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
    const asked = versionGate(h);
    const older = findBin();
    await flush();
    const newer = h.invoke('codex:binaries');
    await flush();
    assert.equal(asked.length, 4, 'the refresh asks again rather than waiting on the older probe');
    const answerOlder = () => {
      asked[0].answer('1.0.0');
      asked[1].answer('0.1.0');
    };
    const answerNewer = () => {
      asked[2].answer('0.1.0');
      asked[3].answer('2.0.0');
    };
    if (order === 'newer first') {
      answerNewer();
      await flush();
      answerOlder();
    } else {
      answerOlder();
      await flush();
      answerNewer();
    }
    assert.equal(await older, '/opt/homebrew/bin/codex', `${order}: the older caller gets its own probe's answer`);
    assert.deepEqual(await newer, {
      candidates: [
        { path: '/opt/homebrew/bin/codex', version: '0.1.0', via: 'unknown', from: '' },
        { path: '/usr/local/bin/codex', version: '2.0.0', via: 'unknown', from: '' },
      ],
      current: '/usr/local/bin/codex',
    });
    assert.equal(findBin(), '/usr/local/bin/codex', `${order}: the newer probe is the one remembered`);
  }
});

test('a choice saved while the copies are asked wins over the newest one', async () => {
  const h = await ready();
  const findBin = h.one('Accounts').opts.findBin;
  installed(h, '/opt/homebrew/bin/codex');
  const asked = versionGate(h);
  const p = findBin();
  await flush();
  const mine = path.join(h.tmp, 'my-codex');
  fs.writeFileSync(mine, '');
  h.writeState({ codexBin: mine });
  asked[0].answer('9.9.9');
  assert.equal(await p, mine);
});

test('a version probe that cannot be launched lists the copy without a version', async () => {
  const h = await ready();
  installed(h, '/opt/homebrew/bin/codex');
  h.mod('platform/winbin.cjs').spawnArgs.mock.mockImplementation(() => {
    throw new Error('no launcher');
  });
  assert.deepEqual(await h.invoke('codex:binaries'), {
    candidates: [{ path: '/opt/homebrew/bin/codex', version: null, via: 'unknown', from: '' }],
    current: '/opt/homebrew/bin/codex',
  });
});

test('each copy says how it was installed, as Settings names it: the one bundled with ChatGPT.app too', async () => {
  const h = await ready();
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  installed(h, app, '/opt/homebrew/bin/codex');
  h.cp.exec = () => ({ stdout: '1.0.0' });
  const r = await h.invoke('codex:binaries');
  const by = Object.fromEntries(r.candidates.map((c: any) => [c.path, [c.via, c.from]]));
  assert.deepEqual(by, { [app]: ['app-bundle', 'ChatGPT.app'], '/opt/homebrew/bin/codex': ['unknown', ''] });
});

test('a lookup that fails is not remembered: the next one asks again', async () => {
  const h = await ready();
  const findBin = h.one('Accounts').opts.findBin;
  const which = h.mod('platform/env.cjs').which;
  which.mock.mockImplementationOnce(() => {
    throw new Error('no shell');
  });
  await assert.rejects(findBin(), /no shell/);
  assert.equal(await findBin(), 'codex');
  assert.equal(calls(which).length, 2);
});

test('the IPC that report the binary wait for the lookup', async () => {
  const h = await ready();
  installed(h, '/opt/homebrew/bin/codex');
  const asked = versionGate(h);
  const info = h.invoke('app:info');
  await flush();
  asked[0].answer('1.0.0');
  assert.equal((await info).codexBin, '/opt/homebrew/bin/codex');
  assert.deepEqual(await h.invoke('codex:start'), { bin: '/opt/homebrew/bin/codex', status: 'idle' });
  assert.equal((await h.invoke('app:diagnostics')).diagnostics.harnesses.Codex, '/opt/homebrew/bin/codex');
});

const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

test('opt-in Codex selection picks a later PATH copy for the next process while reporting the live path', async () => {
  const h = await ready({ state: { prefs: { preferHighestCli: true } } });
  const claudeOptions = calls(h.mod('harness/claude/index.cjs').createClaudeHarness)[0][0];
  assert.equal(claudeOptions.preferHighestCli(), true, 'Claude Code uses the same saved startup policy');
  const server = h.one('AppServer');
  const stable = path.join(h.tmp, 'stable', 'codex');
  const beta = path.join(h.tmp, 'beta', 'codex');
  const removed = path.join(h.tmp, 'removed', 'codex');
  const notRunnable = path.join(h.tmp, 'not-a-program');
  for (const p of [stable, beta, removed]) {
    fs.mkdirSync(path.dirname(p));
    fs.writeFileSync(p, '', { mode: 0o755 });
  }
  fs.mkdirSync(notRunnable);
  h.mod('platform/env.cjs').whichAll.mock.mockImplementation(() => [stable, beta, removed, notRunnable]);
  const asked = versionGate(h);
  const starting = server.opts.findBin();
  const status = h.invoke('codex:binaries');
  await flush();
  assert.deepEqual(
    asked.map((a) => a.cmd),
    [stable, beta, removed],
    'the start and status share one scan of executable files',
  );
  fs.rmSync(removed);
  asked[2].answer('codex-cli 9.0.0');
  asked[1].answer('codex-cli 0.170.0-alpha.10');
  asked[0].answer('codex-cli 0.169.0');
  assert.equal(await starting, beta);
  const discovered = await status;
  assert.equal(discovered.current, beta);
  assert.deepEqual(
    discovered.candidates.map((c: { path: string }) => c.path),
    [stable, beta],
  );
  server.bin = stable;
  server.status = 'running';
  assert.equal((await h.invoke('codex:binaries')).current, stable);
  assert.equal((await h.invoke('codex:start')).bin, stable);
  fs.rmSync(stable);
  assert.equal((await h.invoke('app:info')).codexBin, beta, 'new executable lookups ignore a removed running path');
  fs.writeFileSync(stable, '', { mode: 0o755 });
  h.cp.exec = (p: string) => ({ stdout: p === stable ? 'codex-cli 0.169.0' : 'codex-cli 0.170.0-alpha.10' });
  server.status = 'idle';
  h.writeState({ prefs: { preferHighestCli: false }, codexBin: stable });
  assert.equal(await server.opts.findBin(), stable, 'a manual choice takes priority');
  h.writeState({ prefs: { preferHighestCli: false } });
  assert.equal(await server.opts.findBin(), beta, 'the app keeps its launch-time preference');
  assert.equal(server.opts.copies.fallBack(beta).path, stable);
  assert.equal(await server.opts.findBin(), stable, 'a copy that keeps crashing still gives way to the next one');
});

/** A fresh main whose installed copies answer `--version` with these versions (absent: no version). */
async function withCopies(versions: Record<string, string | null>) {
  const h = await ready();
  installed(h, ...Object.keys(versions));
  h.cp.exec = (c: string) => (versions[c] ? { stdout: `codex-cli ${versions[c]}` } : { err: new Error('no version') });
  return h;
}

test('the default is the newest release: an alpha bundled with ChatGPT.app ranks below a release, and is used only when no release is installed', async () => {
  for (const [versions, expected, why] of [
    [
      { [APP_CODEX]: '0.163.0-alpha.10.2', '/opt/homebrew/bin/codex': '0.162.0' },
      '/opt/homebrew/bin/codex',
      'an older release beats a newer alpha',
    ],
    [{ [APP_CODEX]: '0.163.0-alpha.10.2', '/opt/homebrew/bin/codex': '0.163.0' }, '/opt/homebrew/bin/codex', 'the release it leads to'],
    [{ [APP_CODEX]: '0.163.0-alpha.10.2', '/opt/homebrew/bin/codex': '0.163.0-alpha.9' }, APP_CODEX, 'only prereleases: the newest'],
    [{ [APP_CODEX]: '0.163.0-alpha.10.2', '/opt/homebrew/bin/codex': null }, APP_CODEX, 'a prerelease beats a copy with no version'],
    [{ '/usr/local/bin/codex': '0.150.0', '/opt/homebrew/bin/codex': '0.162.0' }, '/opt/homebrew/bin/codex', 'releases: the newest'],
  ] as const) {
    const h = await withCopies(versions);
    assert.equal((await h.invoke('codex:binaries')).current, expected, why);
    assert.equal(h.one('Accounts').opts.findBin(), expected, `${why}: the binary the app-server runs`);
  }
});

test("a default copy that keeps quitting is set aside for the next one installed; the user's own pick never is", async () => {
  const h = await withCopies({
    [APP_CODEX]: '0.163.0-alpha.10.2',
    '/opt/homebrew/bin/codex': '0.164.0',
    '/usr/local/bin/codex': '0.163.0',
  });
  const findBin = h.one('Accounts').opts.findBin;
  const { copyOf, fallBack } = h.one('AppServer').opts.copies;
  // nothing is known before the copies are asked
  assert.equal(fallBack('/opt/homebrew/bin/codex'), null);
  assert.deepEqual(copyOf(null), { copy: { path: 'codex', version: null, via: null, from: null }, pinned: false });
  await h.invoke('codex:binaries');
  assert.deepEqual(copyOf(APP_CODEX), {
    copy: { path: APP_CODEX, version: '0.163.0-alpha.10.2', via: 'app-bundle', from: 'ChatGPT.app' },
    pinned: false,
  });
  assert.equal(fallBack(null), null, 'no start ran a binary');
  // the newest release keeps quitting: the older release, then the alpha
  assert.deepEqual(fallBack('/opt/homebrew/bin/codex'), { path: '/usr/local/bin/codex', version: '0.163.0', via: 'unknown', from: '' });
  assert.equal(findBin(), '/usr/local/bin/codex');
  assert.equal((await h.invoke('codex:binaries')).current, '/usr/local/bin/codex', 'Settings names the copy in use');
  assert.equal(fallBack('/usr/local/bin/codex')?.path, APP_CODEX);
  assert.equal(findBin(), APP_CODEX);
  // every copy set aside: none to move to, and the best one is still the one run
  assert.equal(fallBack(APP_CODEX), null);
  assert.equal(findBin(), '/opt/homebrew/bin/codex');
  // the user's own pick stays, and is said to be theirs
  const mine = path.join(h.tmp, 'my-codex');
  fs.writeFileSync(mine, '');
  h.writeState({ codexBin: mine });
  assert.equal(fallBack(mine), null);
  assert.deepEqual(copyOf(mine), { copy: { path: mine, version: null, via: null, from: null }, pinned: true });
  // its version is asked as it starts (it is not among the copies probed), and names it from then on
  h.cp.exec = (c: string) => (c === mine ? { stdout: 'codex-cli 0.170.0-alpha.1' } : { err: new Error('no version') });
  assert.equal(findBin(), mine);
  await flush();
  await flush();
  assert.equal(copyOf(mine).copy.version, '0.170.0-alpha.1');
  // asked once per pick: the next start does not ask again
  h.cp.exec = () => {
    throw new Error('asked again');
  };
  assert.equal(findBin(), mine);
  await flush();
  assert.equal(copyOf(mine).copy.version, '0.170.0-alpha.1');
});
