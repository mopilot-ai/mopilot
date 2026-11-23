// scripts/build-{helper,sage-mcp,auth-command,disclaim}.mjs with swift, codesign and publishing replaced:
// the commands each runs, how it signs, the build lock, and the command lines.
import edition from '../shared/edition.json' with { type: 'json' };
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const helper = await import('../scripts/build-helper.mjs');
const sageMcp = await import('../scripts/build-sage-mcp.mjs');
const authCommand = await import('../scripts/build-auth-command.mjs');
const disclaim = await import('../scripts/build-disclaim.mjs');

/** A fake execFileSync: swift prints `binDir` for --show-bin-path; every call is recorded. */
const fakeExec = (binDir: string) =>
  recorder((cmd: string, args: string[]) => (cmd === 'swift' && args.includes('--show-bin-path') ? `${binDir}\n` : ''));

const SIMPLE = [
  { name: 'auth-command', build: authCommand.buildAuthCommand, cli: authCommand.cli, id: authCommand.AUTH_COMMAND_IDENTIFIER },
  { name: 'disclaim', build: disclaim.buildDisclaim, cli: disclaim.cli, id: disclaim.DISCLAIM_IDENTIFIER },
  { name: 'sage-mcp', build: sageMcp.buildSageMcp, cli: sageMcp.cli, id: sageMcp.SAGE_MCP_IDENTIFIER },
];

for (const b of SIMPLE) {
  test(`${b.name}: builds on macOS only`, () => {
    // sage-mcp also builds on Linux (below); a platform with no toolchain for it still throws
    assert.throws(() => b.build({ platform: 'win32', log: () => {} }), new RegExp(`${b.name} builds on macOS only`));
    if (b.name !== 'sage-mcp')
      assert.throws(() => b.build({ platform: 'linux', log: () => {} }), new RegExp(`${b.name} builds on macOS only`));
  });

  test(`${b.name}: a release build for an arch is ad-hoc signed by default`, () => {
    const exec = fakeExec('/bin/dir');
    const publish = recorder((_src: string, _dest: string, sign?: (s: string) => void) => sign?.('/staged'));
    const log = recorder();
    const exe = b.build({ out: '/out', arch: 'x64', env: {}, log, exec: exec as any, platform: 'darwin', publish });
    assert.equal(exe, `/out/${b.name}`);
    assert.deepEqual(
      exec.calls.map((c) => [c[0], c[1]]),
      [
        ['swift', ['build', '-c', 'release', '--arch', 'x86_64', '--product', b.name]],
        ['swift', ['build', '-c', 'release', '--arch', 'x86_64', '--show-bin-path']],
        ['codesign', ['--force', '--options', 'runtime', '--identifier', b.id, '--sign', '-', '/staged']],
        ['codesign', ['--verify', '--strict', '/staged']],
      ],
    );
    assert.deepEqual(publish.calls[0].slice(0, 2), [`/bin/dir/${b.name}`, `/out/${b.name}`]);
    assert.deepEqual(log.calls, [[`swift build -c release --arch x86_64 --product ${b.name}`], [`Built /out/${b.name} (ad-hoc signed)`]]);
  });

  test(`${b.name}: a release identity signs with a timestamp; unsigned builds skip codesign`, () => {
    const exec = fakeExec('/b');
    const log = recorder();
    b.build({
      out: '/o',
      env: { MOPILOT_SIGN_IDENTITY: 'Developer ID Application: X (AB12CD34EF)' },
      log,
      exec: exec as any,
      platform: 'darwin',
      publish: ((_s: string, _d: string, sign: (s: string) => void) => sign('/st')) as any,
    });
    assert.deepEqual(exec.calls[2][1], [
      '--force',
      '--options',
      'runtime',
      '--identifier',
      b.id,
      '--sign',
      'Developer ID Application: X (AB12CD34EF)',
      '--timestamp',
      '/st',
    ]);
    assert.equal(log.calls[1][0], `Built /o/${b.name} (signed: Developer ID Application: X (AB12CD34EF))`);
    const exec2 = fakeExec('/b');
    const publish = recorder();
    const log2 = recorder();
    b.build({ out: '/o', debug: true, sign: false, env: {}, log: log2, exec: exec2 as any, platform: 'darwin', publish });
    assert.equal(publish.calls[0][2], undefined);
    assert.deepEqual(exec2.calls[0][1], ['build', '-c', 'debug', '--product', b.name]);
    assert.equal(log2.calls[1][0], `Built /o/${b.name} (unsigned)`);
  });

  test(`${b.name}: the command line passes its options and has --help`, () => {
    const build = recorder();
    b.cli(['--out', 'rel/out', '--arch', 'arm64', '--debug'], { build });
    b.cli([], { build });
    assert.deepEqual(build.calls, [
      [{ out: path.resolve('rel/out'), arch: 'arm64', debug: true }],
      [{ out: undefined, arch: undefined, debug: false }],
    ]);
    const log = recorder();
    b.cli(['--help'], { build, log });
    assert.equal(build.calls.length, 2);
    assert.match(log.calls[0][0], new RegExp(`^usage: node scripts/build-${b.name}\\.mjs`));
    const r = runScript(`scripts/build-${b.name}.mjs`, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage: /);
  });
}

test('sage-mcp --ensure reports the binary, or that there is no swift', () => {
  const log = recorder();
  sageMcp.cli(['--ensure'], { ensure: () => '/x/sage-mcp', log });
  sageMcp.cli(['--ensure'], { ensure: () => null, log });
  assert.deepEqual(log.calls, [['sage-mcp is current: /x/sage-mcp'], ['no swift toolchain: sage-mcp not built']]);
});

test('sage-mcp --ensure on Windows leaves the Rust one to the core, and builds no Swift', () => {
  const log = recorder();
  sageMcp.cli(['--ensure'], { ensure: () => assert.fail('no Swift on Windows'), log, platform: 'win32' });
  assert.deepEqual(log.calls, [["sage-mcp on Windows is the Rust core's: scripts/build-core.mjs --ensure builds it"]]);
});

test('sage-mcp on Linux is built unsigned: no codesign, whatever identity the environment holds', () => {
  const exec = fakeExec('/lin');
  const publish = recorder((_src: string, _dest: string, sign?: (s: string) => void) => sign);
  const log = recorder();
  const exe = sageMcp.buildSageMcp({
    out: '/out',
    env: { MOPILOT_SIGN_IDENTITY: 'X' },
    log,
    exec: exec as any,
    platform: 'linux',
    publish,
  });
  assert.equal(exe, '/out/sage-mcp');
  assert.deepEqual(
    exec.calls.map((c) => c[0]),
    ['swift', 'swift'],
  );
  assert.equal(publish.calls[0][2], undefined);
  assert.equal(log.calls[1][0], 'Built /out/sage-mcp (unsigned)');
});

test('swift is available on macOS and Linux with a working toolchain, nowhere else', () => {
  assert.equal(
    sageMcp.swiftAvailable('win32', () => assert.fail('not run')),
    false,
  );
  assert.equal(
    sageMcp.swiftAvailable('linux', () => ({ status: 0 }) as any),
    true,
  );
  const run = recorder(() => ({ status: 0 }));
  assert.equal(sageMcp.swiftAvailable('darwin', run as any), true);
  assert.deepEqual(run.calls[0], ['swift', ['--version'], { stdio: 'ignore' }]);
  assert.equal(
    sageMcp.swiftAvailable('darwin', () => ({ status: 1 }) as any),
    false,
  );
});

test('the process helpers: newest walks folders, pidAlive tells live, foreign and dead pids apart', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'f'), 'x');
  fs.utimesSync(path.join(dir, 'a', 'f'), new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.equal(sageMcp.newest(dir), fs.statSync(path.join(dir, 'a', 'f')).mtimeMs);
  assert.equal(sageMcp.pidAlive(process.pid), true);
  assert.equal(sageMcp.pidAlive(1), true); // launchd: alive, but not ours to signal
  assert.equal(sageMcp.pidAlive(2 ** 22 + 12345), false);
  assert.equal(sageMcp.sleepSync(1), 'timed-out');
});

/** A sources folder and an exe path; `fresh` writes an exe newer than the sources, `stale` an older one. */
function project() {
  const dir = tempDir();
  const src = path.join(dir, 'Sources');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'main.swift'), '');
  fs.utimesSync(path.join(src, 'main.swift'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(src, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const exe = path.join(dir, 'build', 'sage-mcp');
  const fresh = () => {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'bin');
  };
  const stale = () => {
    fresh();
    fs.utimesSync(exe, new Date(2019, 0, 1), new Date(2019, 0, 1));
  };
  return { dir, exe, sources: [src], lock: path.join(dir, 'build.lock'), fresh, stale };
}

test('ensure: a current binary is used as is; without swift a stale one is kept and a missing one is null', () => {
  const p = project();
  p.fresh();
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => assert.fail('no swift check') }), p.exe);
  p.stale();
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => false }), p.exe);
  fs.rmSync(p.exe);
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => false }), null);
});

test('ensure: builds under the lock into the exe folder, then releases it', () => {
  const p = project();
  const build = recorder((o: any) => {
    assert.equal(o.log('quiet by default'), undefined);
    assert.match(fs.readFileSync(p.lock, 'utf8'), new RegExp(`^${process.pid} `));
    assert.equal(o.out, path.dirname(p.exe));
    p.fresh();
  });
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => true, build: build as any }), p.exe);
  assert.equal(build.calls.length, 1);
  assert.equal(fs.existsSync(p.lock), false);
});

test('ensure: a build that leaves no current binary is an error, and the lock is still released', () => {
  const p = project();
  assert.throws(
    () => sageMcp.ensureBuilt({ ...p, swift: () => true, build: (() => {}) as any }),
    /the build finished but .*sage-mcp is missing or older than its sources/,
  );
  assert.equal(fs.existsSync(p.lock), false);
  assert.throws(
    () =>
      sageMcp.ensureBuilt({
        ...p,
        swift: () => true,
        build: () => {
          throw new Error('swift failed');
        },
      }),
    /swift failed/,
  );
  assert.equal(fs.existsSync(p.lock), false);
});

test('ensure: a lock left by a dead builder, or an old one without a pid, is taken over', () => {
  const p = project();
  fs.writeFileSync(p.lock, '999 tok\n');
  const alive = recorder(() => false);
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => true, alive, build: p.fresh as any }), p.exe);
  assert.deepEqual(alive.calls, [[999]]);
  const q = project();
  fs.writeFileSync(q.lock, '');
  fs.utimesSync(q.lock, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(sageMcp.ensureBuilt({ ...q, swift: () => true, build: q.fresh as any }), q.exe);
});

test('ensure: waits while another builder holds the lock, and skips the build it already did', () => {
  const p = project();
  fs.writeFileSync(p.lock, '');
  const sleep = recorder(() => {
    // the other builder finishes: a current binary, and the lock gone
    p.fresh();
    fs.rmSync(p.lock);
  });
  const build = recorder();
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => true, sleep: sleep as any, build }), p.exe);
  assert.deepEqual(sleep.calls, [[200]]);
  assert.equal(build.calls.length, 0);
});

test('ensure: gives up when the lock stays held too long, naming its owner', () => {
  const p = project();
  fs.writeFileSync(p.lock, '4242 tok\n');
  let t = 0;
  assert.throws(
    () =>
      sageMcp.ensureBuilt({
        ...p,
        swift: () => true,
        alive: () => true,
        sleep: (() => {}) as any,
        now: () => (t += 1000),
        maxWaitMs: 2500,
      }),
    /gave up waiting 3s for the build lock .* \(held by pid 4242\)/,
  );
  const q = project();
  fs.writeFileSync(q.lock, '');
  let u = fs.statSync(q.lock).mtimeMs;
  assert.throws(
    () => sageMcp.ensureBuilt({ ...q, swift: () => true, sleep: (() => {}) as any, now: () => (u += 1000), maxWaitMs: 2000 }),
    /held by pid \?\)/,
  );
});

test('ensure: a lock that cannot be created for another reason is an error', () => {
  const p = project();
  assert.throws(() => sageMcp.ensureBuilt({ ...p, lock: path.join(p.dir, 'no', 'such', 'lock'), swift: () => true }), /ENOENT/);
});

test('ensureSageMcp keeps the binary it found for the rest of the process', () => {
  const p = project();
  p.fresh();
  assert.equal(sageMcp.ensureSageMcp({ ...p }), p.exe);
  assert.equal(sageMcp.ensureSageMcp({ exe: '/elsewhere', swift: () => assert.fail('cached') }), p.exe);
});

// ---------- the computer-use helper ----------
function helperBin() {
  const binDir = tempDir();
  fs.writeFileSync(path.join(binDir, 'ComputerUseHelper'), '#!/bin/sh\n');
  return binDir;
}

test('helper: builds on macOS only', () => {
  assert.throws(() => helper.buildHelper({ platform: 'win32', log: () => {} }), /builds on macOS only/);
});

test('helper: an unsigned build is a complete bundle with the given peer requirement', () => {
  const out = tempDir();
  const exec = fakeExec(helperBin());
  const log = recorder();
  const app = helper.buildHelper({
    out,
    arch: 'arm64',
    sign: false,
    peerRequirement: 'anchor apple',
    env: { BUILD_NUMBER: '42' },
    log,
    exec: exec as any,
    platform: 'darwin',
  });
  assert.equal(app, path.join(out, `${helper.HELPER_NAME}.app`));
  assert.equal(fs.statSync(path.join(app, 'Contents/MacOS/ComputerUseHelper')).mode & 0o777, 0o755);
  const info = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  assert.match(info, /<key>CFBundleVersion<\/key>\n\t<string>42<\/string>/);
  assert.match(info, /<key>MPCPeerRequirement<\/key>\n\t<string>anchor apple<\/string>/);
  assert.equal(fs.readFileSync(path.join(app, 'Contents/PkgInfo'), 'utf8'), 'APPL????');
  assert.equal(exec.calls.length, 2);
  assert.deepEqual(
    log.calls.map((c) => c[0]),
    ['swift build -c release --arch arm64', `Built ${app} (unsigned)`],
  );
});

test('helper: a Developer ID build gets a timestamp and the team peer requirement', () => {
  const exec = fakeExec(helperBin());
  const log = recorder();
  const identity = 'Developer ID Application: MoPilot (AB12CD34EF)';
  const app = helper.buildHelper({
    out: tempDir(),
    debug: true,
    env: { MOPILOT_HELPER_SIGN_IDENTITY: identity },
    log,
    exec: exec as any,
    platform: 'darwin',
  });
  assert.deepEqual(exec.calls[2][1].slice(-4), ['--sign', identity, '--timestamp', app]);
  assert.deepEqual(exec.calls[3][1], ['--verify', '--strict', app]);
  const info = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  assert.ok(info.includes('certificate leaf[subject.OU] = "AB12CD34EF"'));
  assert.doesNotMatch(info, /MPCDevBuild/);
  assert.equal(log.calls[1][0], `Built ${app} (signed: ${identity})`);
});

test('helper: "-" forces ad-hoc; a dev identity from the keychain marks a dev build', () => {
  const exec = fakeExec(helperBin());
  const log = recorder();
  const app = helper.buildHelper({ out: tempDir(), env: { MOPILOT_SIGN_IDENTITY: '-' }, log, exec: exec as any, platform: 'darwin' });
  assert.deepEqual(exec.calls[2][1].slice(-4), ['-', '--requirements', `=${helper.ADHOC_REQUIREMENT}`, app]);
  assert.equal(log.calls[1][0], `Built ${app} (ad-hoc signed)`);

  const saved = { ...process.env };
  for (const k of ['MOPILOT_HELPER_SIGN_IDENTITY', 'MOPILOT_SIGN_IDENTITY', 'MOPILOT_HELPER_PEER_REQUIREMENT', 'BUILD_NUMBER'])
    delete process.env[k];
  try {
    const bin = helperBin();
    const devExec = recorder((cmd: string, args: string[]) => {
      if (cmd === 'security') return '  1) ABC "Apple Development: Jane (29RC33CGL6)"\n';
      return args.includes('--show-bin-path') ? bin : '';
    });
    const app2 = helper.buildHelper({ out: tempDir(), log: () => {}, exec: devExec as any, platform: 'darwin' });
    assert.deepEqual(devExec.calls[2], ['security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }]);
    assert.deepEqual(devExec.calls[3][1].slice(-2), ['Apple Development: Jane (29RC33CGL6)', app2]);
    assert.match(fs.readFileSync(path.join(app2, 'Contents/Info.plist'), 'utf8'), /<key>MPCDevBuild<\/key>\n\t<true\/>/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('helper: an ad-hoc signature pins the bundle identifier, not the code hash, so TCC grants survive a rebuild', () => {
  assert.equal(helper.ADHOC_REQUIREMENT, `designated => identifier "${edition.desktop.appId}.computer-use"`);
  const base = ['--force', '--options', 'runtime', '--entitlements', '/e.plist', '--sign'];
  assert.deepEqual(helper.signArgs({ entitlements: '/e.plist' }), [...base, '-', '--requirements', `=${helper.ADHOC_REQUIREMENT}`]);
  assert.deepEqual(helper.signArgs({ identity: '', entitlements: '/e.plist' }), [
    ...base,
    '-',
    '--requirements',
    `=${helper.ADHOC_REQUIREMENT}`,
  ]);
  // A certificate identity keeps its certificate-based default requirement; only Developer ID gets a timestamp.
  const dev = 'Apple Development: Jane (29RC33CGL6)';
  assert.deepEqual(helper.signArgs({ identity: dev, entitlements: '/e.plist' }), [...base, dev]);
  const release = 'Developer ID Application: MoPilot (AB12CD34EF)';
  assert.deepEqual(helper.signArgs({ identity: release, entitlements: '/e.plist' }), [...base, release, '--timestamp']);
});

test('helper: the keychain lookup finds no identity when security fails or lists none', () => {
  assert.equal(
    helper.devIdentity(() => {
      throw new Error('no security');
    }),
    '',
  );
  assert.equal(
    helper.devIdentity(() => '0 valid identities found' as any),
    '',
  );
});

test('helper: the command line passes its options and has --help', () => {
  const build = recorder();
  helper.cli(['--arch', 'x64'], { build });
  helper.cli(['--out', 'o', '--debug'], { build });
  assert.deepEqual(build.calls, [
    [{ out: undefined, arch: 'x64', debug: false }],
    [{ out: path.resolve('o'), arch: undefined, debug: true }],
  ]);
  assert.equal(helper.defaultPeerRequirement('Developer ID Application: No Team'), undefined);
  assert.equal(helper.defaultPeerRequirement(undefined), undefined);
  const log = recorder();
  helper.cli(['--help'], { build, log });
  assert.match(log.calls[0][0], /^usage: node scripts\/build-helper\.mjs/);
  const r = runScript('scripts/build-helper.mjs', ['--help']);
  assert.equal(r.status, 0);
});

test("ensure: a lock that can't be read for another reason than missing fails the build instead of waiting", () => {
  const p = project();
  fs.mkdirSync(p.lock); // EISDIR on read
  assert.throws(() => sageMcp.ensureBuilt({ ...p, swift: () => true, build: p.fresh as any }), /EISDIR/);
});

test('ensure: a lock released between finding it and reading it is taken at once', async () => {
  const { syncBuiltinESMExports } = await import('node:module');
  const p = project();
  fs.writeFileSync(p.lock, '4242 tok\n');
  const real = fs.readFileSync;
  const m = mock.method(fs, 'readFileSync', (f: any, ...rest: any[]) => {
    if (String(f) === p.lock) {
      // the other builder finished and removed its lock just now
      fs.rmSync(p.lock);
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    }
    return (real as any)(f, ...rest);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => true, build: p.fresh as any }), p.exe);
  } finally {
    m.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.existsSync(p.lock), false);
});
