// scripts/build-core.mjs: the Rust core's addon built for one macOS architecture, for the app's minimum macOS, and copied
// where the packager ships it; a failed build stops the package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADDON,
  GLIBC_FLOOR,
  HOST_MACOS_TARGET,
  LINUX_BUILDS,
  LINUX_SAGE_MCP,
  LINUX_TRIPLES,
  MACOS_TARGET,
  RUST_ALPINE,
  TRIPLES,
  WINDOWS_SAGE_MCP,
  WINDOWS_TRIPLES,
  CORE_SOURCES,
  CORE_SOURCES_STAMP,
  buildCore,
  buildHostCore,
  checkGlibcFloor,
  checkLinuxCore,
  checkWindowsCore,
  coreSourcesHash,
  ensureCore,
  parseArgs,
  recordCoreHash,
  recordHostCores,
  runCli,
} from '../scripts/build-core.mjs';
import { CORE_BUILDS } from '../shared/host/coreBuild.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('each architecture builds its own target for the minimum macOS, and the addon is copied under its app name', (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'build-core-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const [arch, triple] of Object.entries(TRIPLES)) {
    const runs: any[] = [];
    const copies: string[][] = [];
    const addon = buildCore({
      arch,
      out,
      repoRoot: '/r',
      run: (cmd, args, o: any) => (runs.push([cmd, args, o.cwd, o.env.MACOSX_DEPLOYMENT_TARGET]), { status: 0 }),
      copy: (from, to) => copies.push([from, to]),
    });
    assert.deepEqual(runs, [
      ['cargo', ['build', '--release', '--locked', '-p', 'node', '--target', triple], path.join('/r', 'core'), MACOS_TARGET],
    ]);
    assert.deepEqual(copies, [[path.join('/r', 'core', 'target', triple, 'release', 'libmopilot_core.dylib'), path.join(out, ADDON)]]);
    assert.equal(addon, path.join(out, ADDON));
  }
});

test('Windows x64 builds its MSVC target with no macOS minimum, its .dll copied under the app name and sage-mcp.exe beside it', (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'build-core-win-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const runs: any[] = [];
  const copies: string[][] = [];
  const addon = buildCore({
    platform: 'win32',
    arch: 'x64',
    out,
    repoRoot: '/r',
    run: (cmd, args, o: any) => (runs.push([cmd, args, o.env.RUSTFLAGS]), { status: 0 }),
    copy: (from, to) => copies.push([from, to]),
  });
  const triple = WINDOWS_TRIPLES.x64;
  assert.deepEqual(runs, [
    ['cargo', ['build', '--release', '--locked', '-p', 'node', '-p', 'sage-mcp', '--target', triple], '-C target-feature=+crt-static'],
  ]);
  const release = path.join('/r', 'core', 'target', triple, 'release');
  assert.deepEqual(copies, [
    [path.join(release, 'mopilot_core.dll'), path.join(out, ADDON)],
    [path.join(release, WINDOWS_SAGE_MCP), path.join(out, WINDOWS_SAGE_MCP)],
  ]);
  assert.equal(addon, path.join(out, ADDON));
  // no Windows arm64, and no unknown platform
  const copy = () => assert.fail('nothing is copied');
  assert.throws(() => buildCore({ platform: 'win32', arch: 'arm64', out: '/o', run: () => ({ status: 0 }), copy }), /not win32 arm64/);
  assert.throws(() => buildCore({ platform: 'freebsd', arch: 'x64', out: '/o', run: () => ({ status: 0 }), copy }), /not freebsd x64/);
});

test('Linux builds each GNU target and ships its shared object with sage-mcp beside it, without macOS build settings', (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'build-core-linux-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.deepEqual(LINUX_TRIPLES, { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' });
  for (const [arch, triple] of Object.entries(LINUX_TRIPLES)) {
    const runs: any[] = [];
    const copies: string[][] = [];
    const addon = buildCore({
      platform: 'linux',
      arch,
      out,
      repoRoot: '/r',
      run: (cmd, args, options: any) => (runs.push([cmd, args, options]), { status: 0 }),
      copy: (from, to) => copies.push([from, to]),
    });
    assert.deepEqual(runs, [
      [
        'cargo',
        ['build', '--release', '--locked', '-p', 'node', '-p', 'sage-mcp', '--target', triple],
        { cwd: path.join('/r', 'core'), stdio: 'inherit', env: process.env },
      ],
    ]);
    const release = path.join('/r', 'core', 'target', triple, 'release');
    assert.deepEqual(copies, [
      [path.join(release, 'libmopilot_core.so'), path.join(out, ADDON)],
      [path.join(release, LINUX_SAGE_MCP), path.join(out, LINUX_SAGE_MCP)],
    ]);
    assert.equal(addon, path.join(out, ADDON));
  }
  assert.throws(() => buildCore({ platform: 'linux', arch: 'ia32', out }), /not linux ia32/);
});

test('the command line takes --platform, --arch and --out, each required', () => {
  assert.deepEqual(parseArgs(['--platform', 'win32', '--arch', 'x64', '--out', 'build/core']), {
    platform: 'win32',
    arch: 'x64',
    out: 'build/core',
  });
  assert.throws(() => parseArgs(['--platform', 'win32', '--arch', 'x64']), /--out is required/);
  assert.throws(() => parseArgs(['--target', 'x']), /Unknown or empty option --target/);
  assert.throws(() => parseArgs(['--out']), /Unknown or empty option --out/);
});

test('an architecture with no target, a build that fails or a cargo that does not start stops the package', () => {
  const copy = () => assert.fail('nothing is copied');
  assert.throws(
    () => buildCore({ arch: 'ia32', out: '/o', run: () => ({ status: 0 }), copy }),
    /built for macOS and Linux arm64 or x64 and Windows x64, not darwin ia32/,
  );
  assert.throws(
    () => buildCore({ arch: 'arm64', out: '/o', run: () => ({ status: 101 }), copy }),
    /The Rust core did not build for darwin arm64\. Install its toolchain in core\/ \(rustup toolchain install\) and `rustup target add aarch64-apple-darwin`/,
  );
  assert.throws(
    () => buildCore({ arch: 'x64', out: '/o', run: () => ({ status: null, error: new Error('spawn cargo ENOENT') }), copy }),
    /did not build for darwin x64 \(spawn cargo ENOENT\)/,
  );
});

test('by default it runs the real cargo and copies the real file', (t) => {
  // here cargo itself runs in a core/ that does not exist
  assert.throws(
    () => buildCore({ arch: 'arm64', out: '/o', repoRoot: path.join(os.tmpdir(), 'no-such-repo') }),
    /did not build for darwin arm64/,
  );
  // a build that left its library: the real copy puts it under the app's name
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'build-core-repo-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const release = path.join(repoRoot, 'core', 'target', TRIPLES.arm64, 'release');
  mkdirSync(release, { recursive: true });
  writeFileSync(path.join(release, 'libmopilot_core.dylib'), 'built');
  const addon = buildCore({ arch: 'arm64', out: path.join(repoRoot, 'out'), repoRoot, run: () => ({ status: 0 }) });
  assert.equal(readFileSync(addon, 'utf8'), 'built');
});

test("the package records the signed addon's SHA-256 as { sha256 } for the loader", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const addon = path.join(dir, ADDON);
  writeFileSync(addon, 'signed bytes');
  const file = path.join(dir, 'core-hash.json');
  const sha256 = createHash('sha256').update('signed bytes').digest('hex');
  assert.equal(recordCoreHash(addon, file), sha256);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sha256 });
});

test('run as a command it builds what its options name, and stops on a platform it does not build', () => {
  const script = fileURLToPath(new URL('../scripts/build-core.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--platform', 'freebsd', '--arch', 'x64', '--out', os.tmpdir()], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not freebsd x64/);
});

test('a Windows core folder without sage-mcp.exe beside the addon stops the package', () => {
  const seen: string[] = [];
  const clean = () => Buffer.from('MZ KERNEL32.dll');
  assert.doesNotThrow(() => checkWindowsCore('/c', (f) => (seen.push(f), true), clean));
  for (const file of ['mopilot_core.node', 'sage-mcp.exe'])
    assert.throws(
      () =>
        checkWindowsCore(
          '/c',
          () => true,
          (f) => Buffer.from(f.endsWith(file) ? 'MZ VCRUNTIME140.dll' : 'MZ'),
        ),
      new RegExp(`^Error: ${file} needs the VC\\+\\+ runtime`),
    );
  assert.deepEqual(seen, [path.join('/c', WINDOWS_SAGE_MCP)]);
  assert.throws(() => checkWindowsCore('/c', () => false), /\/c has no sage-mcp\.exe: build the core again/);
});

test('every Host build is made: macOS here, for the oldest macOS the Host’s Node runs on; each Linux one in its container', () => {
  assert.deepEqual([...CORE_BUILDS].sort(), [...Object.keys(LINUX_BUILDS), 'darwin-arm64', 'darwin-x64'].sort());
  const out = mkdtempSync(path.join(os.tmpdir(), 'build-host-core-'));
  const mac: any[] = [];
  const addon = buildHostCore({
    build: 'darwin-x64',
    out,
    repoRoot: '/r',
    run: (cmd, args, o: any) => (mac.push([cmd, args, o.env.MACOSX_DEPLOYMENT_TARGET]), { status: 0 }),
    copy: () => undefined,
  });
  assert.equal(addon, path.join(out, 'darwin-x64', ADDON));
  assert.deepEqual(mac, [['cargo', ['build', '--release', '--locked', '-p', 'node', '--target', TRIPLES.x64], HOST_MACOS_TARGET]]);

  try {
    for (const [build, target] of Object.entries(LINUX_BUILDS)) {
      const runs: any[] = [];
      const copies: string[][] = [];
      const made = buildHostCore({
        build,
        out,
        repoRoot: '/r',
        run: (cmd, args) => (runs.push([cmd, args]), { status: 0 }),
        copy: (from, to) => copies.push([from, to]),
        read: () => Buffer.from('GLIBC_2.2.5\0GLIBC_2.17\0'),
      });
      assert.equal(made, path.join(out, build, ADDON));
      assert.deepEqual(copies, [[path.join('/r', 'core', 'target', build, target.triple, 'release', 'libmopilot_core.so'), made]]);
      const [cmd, args] = runs[0];
      assert.equal(cmd, 'docker');
      assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--platform', target.platform]);
      assert.ok(args.includes(`${path.join('/r', 'core')}:/core`));
      assert.ok(args.includes(target.image));
      assert.match(args.at(-1), new RegExp(`cargo build --release --locked -p node --target ${target.triple}$`));
      // musl's default links its C library statically, and then rustc makes no cdylib: the addon must share the Node's
      assert.equal(args.includes('RUSTFLAGS=-C target-feature=-crt-static'), target.libc === 'musl');
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the toolchain the Linux containers use is the one core/ pins, and each image is pinned', () => {
  const channel = /channel = "([\d.]+)"/.exec(readFileSync(new URL('../core/rust-toolchain.toml', import.meta.url), 'utf8'))?.[1];
  assert.ok(RUST_ALPINE.startsWith(`rust:${channel}-alpine@sha256:`));
  for (const { image } of Object.values(LINUX_BUILDS)) assert.match(image, /@sha256:[0-9a-f]{64}$/);
  const script = readFileSync(new URL('../scripts/build-core.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes(`RUSTUP_TOOLCHAIN=${channel}`));
});

test('a Host build that is not one, that fails, or that needs a newer glibc than the floor stops', () => {
  const fake = { out: '/out', repoRoot: '/r', copy: () => undefined };
  assert.throws(
    () => buildHostCore({ ...fake, build: 'linux-riscv64-gnu', run: () => ({ status: 0 }) }),
    /no Host build linux-riscv64-gnu/,
  );
  assert.throws(
    () => buildHostCore({ ...fake, build: 'linux-x64-musl', run: () => ({ status: 1 }) }),
    /did not build for linux-x64-musl\. It builds in Docker, on a linux\/amd64 machine\./,
  );
  assert.throws(
    () => buildHostCore({ ...fake, build: 'linux-x64-musl', run: () => ({ status: null, error: new Error('docker not found') }) }),
    /\(docker not found\)/,
  );
  const out = mkdtempSync(path.join(os.tmpdir(), 'build-host-floor-'));
  try {
    assert.throws(
      () =>
        buildHostCore({
          ...fake,
          out,
          build: 'linux-arm64-gnu',
          run: () => ({ status: 0 }),
          read: () => Buffer.from('GLIBC_2.17\0GLIBC_2.28\0'),
        }),
      new RegExp(`needs glibc 2\\.28, newer than the floor ${GLIBC_FLOOR.replace('.', '\\.')}`),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  checkGlibcFloor('/a', () => Buffer.from('no versions here'));
  checkGlibcFloor('/a', () => Buffer.from('GLIBC_2.2.5\0GLIBC_2.17\0GLIBC_1.99\0'));
  assert.throws(() => checkGlibcFloor('/a', () => Buffer.from('GLIBC_3.0')), /needs glibc 3\.0/);
});

test('a package records every Host build’s SHA-256, or stops on a hole', () => {
  const written: string[][] = [];
  const hashes = recordHostCores('/d', '/f.json', {
    exists: () => true,
    read: (f) => Buffer.from(f),
    write: (f, text) => written.push([f, text]),
  });
  assert.deepEqual(Object.keys(hashes), CORE_BUILDS);
  const one = createHash('sha256')
    .update(path.join('/d', 'darwin-x64', ADDON))
    .digest('hex');
  assert.equal(hashes['darwin-x64'], one);
  assert.deepEqual(written, [['/f.json', `${JSON.stringify(hashes)}\n`]]);
  assert.throws(
    () =>
      recordHostCores('/d', '/f.json', {
        exists: (f) => !f.includes('linux-x64-musl'),
        read: () => Buffer.from(''),
        write: () => undefined,
      }),
    /\/d has no linux-x64-musl build/,
  );
});

test('the command line takes --host and --out for a Host build', () => {
  assert.deepEqual(parseArgs(['--host', 'linux-x64-gnu', '--out', '/o']), { host: 'linux-x64-gnu', out: '/o' });
  assert.throws(() => parseArgs(['--host', 'linux-x64-gnu']), /--out is required/);
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/build-core.mjs', import.meta.url)), '--host', 'plan9-x64', '--out', '/nowhere'],
    {
      encoding: 'utf8',
    },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no Host build plan9-x64/);
});

/** A checkout with a core/ of its sources and an empty target/release. */
function checkout(t: { after: (fn: () => void) => void }) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'ensure-core-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = path.join(repoRoot, 'core');
  mkdirSync(path.join(core, 'crates', 'node', 'src'), { recursive: true });
  mkdirSync(path.join(core, 'target', 'release'), { recursive: true });
  for (const file of CORE_SOURCES.filter((f) => f !== 'crates')) writeFileSync(path.join(core, file), file);
  writeFileSync(path.join(core, 'crates', 'node', 'src', 'lib.rs'), 'one');
  return { repoRoot, core, addon: path.join(core, 'target', 'release', 'libmopilot_core.dylib') };
}

test('the hash of the sources follows their names and content, and nothing under target', (t) => {
  const { core, addon } = checkout(t);
  const lib = path.join(core, 'crates', 'node', 'src', 'lib.rs');
  const first = coreSourcesHash(core);
  writeFileSync(addon, 'built');
  assert.equal(coreSourcesHash(core), first);
  writeFileSync(lib, 'two');
  assert.notEqual(coreSourcesHash(core), first);
  writeFileSync(lib, 'one');
  renameSync(lib, path.join(core, 'crates', 'node', 'src', 'main.rs'));
  assert.notEqual(coreSourcesHash(core), first);
});

test('a checkout builds its addon once for the sources, with the pinned toolchain, and again when they change', (t) => {
  const { repoRoot, core, addon } = checkout(t);
  const runs: any[] = [];
  const run = (cmd: string, args: string[], o: any) => {
    runs.push([cmd, args, o.cwd]);
    if (cmd === 'cargo') writeFileSync(addon, 'built');
    return { status: 0 };
  };
  assert.equal(ensureCore({ repoRoot, addon, run }), addon);
  assert.deepEqual(runs, [
    ['rustup', ['toolchain', 'install'], core],
    ['cargo', ['build', '--release', '--locked', '-p', 'node'], core],
  ]);
  assert.equal(readFileSync(path.join(path.dirname(addon), CORE_SOURCES_STAMP), 'utf8'), coreSourcesHash(core));
  runs.length = 0;
  assert.equal(ensureCore({ repoRoot, addon, run }), addon);
  assert.deepEqual(runs, [], 'current: a restored cache is used as it is');
  writeFileSync(path.join(core, 'crates', 'node', 'src', 'lib.rs'), 'two');
  assert.equal(ensureCore({ repoRoot, addon, run }), addon);
  assert.equal(runs.length, 2, 'stale');
  rmSync(addon);
  runs.length = 0;
  assert.equal(ensureCore({ repoRoot, addon, run }), addon);
  assert.equal(runs.length, 2, 'a stamp with no addon builds it');
  rmSync(path.join(path.dirname(addon), CORE_SOURCES_STAMP));
  runs.length = 0;
  assert.equal(ensureCore({ repoRoot, addon, run }), addon);
  assert.equal(runs.length, 2, 'an addon with no stamp builds it');
});

test('a Windows checkout builds sage-mcp.exe beside its addon, and builds again while it is missing', (t) => {
  const { repoRoot, core } = checkout(t);
  const release = path.join(core, 'target', 'release');
  const addon = path.join(release, 'mopilot_core.dll');
  const bridge = path.join(release, WINDOWS_SAGE_MCP);
  const runs: any[] = [];
  const run = (cmd: string, args: string[]) => {
    runs.push([cmd, args]);
    if (cmd === 'cargo') for (const file of [addon, bridge]) writeFileSync(file, 'built');
    return { status: 0 };
  };
  assert.equal(ensureCore({ repoRoot, addon, platform: 'win32', run }), addon);
  assert.deepEqual(runs[1], ['cargo', ['build', '--release', '--locked', '-p', 'node', '-p', 'sage-mcp']]);
  assert.equal(readFileSync(bridge, 'utf8'), 'built');
  runs.length = 0;
  assert.equal(ensureCore({ repoRoot, addon, platform: 'win32', run }), addon);
  assert.deepEqual(runs, [], 'current, the tool bridge included');
  // a restored cache from before the bridge was in it: the addon and its stamp, no sage-mcp.exe
  rmSync(bridge);
  assert.equal(ensureCore({ repoRoot, addon, platform: 'win32', run }), addon);
  assert.equal(runs.length, 2, 'no sage-mcp.exe builds them');
  // elsewhere a checkout's tool bridge is not the core's (Swift on macOS, host/bin/sage-mcp.mjs on Linux)
  rmSync(bridge);
  runs.length = 0;
  assert.equal(ensureCore({ repoRoot, addon, platform: 'linux', run }), addon);
  assert.deepEqual(runs, []);
});

test('no toolchain leaves the checkout without a core, and says what the app then does; a failed build stops it', (t) => {
  const { repoRoot, addon } = checkout(t);
  const lines: string[] = [];
  const failing = (code: string) => () => ({ status: null, error: Object.assign(new Error(`spawn cargo ${code}`), { code }) });
  assert.equal(ensureCore({ repoRoot, addon, run: failing('ENOENT'), log: (l) => lines.push(l) }), null);
  assert.match(lines[0], /does not start without a Rust core/);
  assert.throws(() => ensureCore({ repoRoot, addon, run: () => ({ status: 101 }) }), /^Error: The Rust core did not build\.$/);
  assert.throws(() => ensureCore({ repoRoot, addon, run: failing('EACCES') }), /did not build \(spawn cargo EACCES\)/);
  assert.equal(existsSync(path.join(path.dirname(addon), CORE_SOURCES_STAMP)), false, 'no build, no stamp');
});

test('the default addon is the one the loader looks for in this checkout', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const found: string[] = [];
  const addon = ensureCore({
    run: (cmd) => {
      if (cmd === 'cargo') found.push(cmd);
      return { status: null, error: Object.assign(new Error('none'), { code: 'ENOENT' }) };
    },
    log: () => undefined,
  });
  // built here already, or asked for through the fake above
  assert.ok(addon === null ? found.length === 1 : addon.startsWith(path.join(repoRoot, 'core', 'target', 'release')));
});

test('the command line ensures the checkout, or builds what the release asks for', () => {
  const stubs = { ensure: () => 'ensured', build: (o: any) => `built ${o.arch}` };
  assert.equal(runCli(['--ensure'], stubs), 'ensured');
  assert.throws(() => runCli(['--ensure'], { ...stubs, ensure: () => null }), /no Rust core, and no toolchain to build one/);
  assert.equal(runCli(['--platform', 'win32', '--arch', 'x64', '--out', '/o'], stubs), 'built x64');
  assert.equal(
    runCli(['--host', 'linux-x64-musl', '--out', '/o'], { ...stubs, buildHost: ({ build, out }) => `${build} in ${out}` } as any),
    'linux-x64-musl in /o',
  );
});

test('a build already made for the lowest glibc is copied, and sage-mcp is built in its container to that floor', () => {
  for (const [arch, build] of [
    ['x64', 'linux-x64-gnu'],
    ['arm64', 'linux-arm64-gnu'],
  ]) {
    const copied: string[][] = [];
    const runs: string[][] = [];
    const run = (cmd: string, args: string[]) => (runs.push([cmd, ...args]), { status: 0 });
    const copy = (from: string, to: string) => copied.push([from, to]);
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'core-')), 'core');
    const prebuilt = `/host/${build}/mopilot_core.node`;
    const o = { platform: 'linux', arch, out, repoRoot: '/r', run: run as any, copy: copy as any, prebuilt, exists: () => true };
    const read = () => Buffer.from('GLIBC_2.2.5\0GLIBC_2.17\0');
    assert.equal(buildCore({ ...o, read }), path.join(out, ADDON));
    const { triple, image, platform } = LINUX_BUILDS[build];
    assert.deepEqual(copied, [
      [prebuilt, path.join(out, ADDON)],
      [path.join('/r', 'core', 'target', build, triple, 'release', LINUX_SAGE_MCP), path.join(out, LINUX_SAGE_MCP)],
    ]);
    // one container run, the same image and target dir the Host build uses, and only the bridge is built
    assert.equal(runs.length, 1);
    const [cmd, ...args] = runs[0];
    assert.deepEqual([cmd, ...args.slice(0, 4)], ['docker', 'run', '--rm', '--platform', platform]);
    assert.ok(args.includes(image) && args.includes(`CARGO_TARGET_DIR=/core/target/${build}`));
    assert.match(args.at(-1)!, new RegExp(`cargo build --release --locked -p sage-mcp --target ${triple}$`));
    // a bridge that needs a newer glibc than the addon's floor stops the package
    assert.throws(() => buildCore({ ...o, read: () => Buffer.from('GLIBC_2.34') }), /sage-mcp needs glibc 2\.34, newer than the floor/);
  }
  const fails = (cmd: string) => (cmd === 'docker' ? { status: 125 } : assert.fail('no native build'));
  const failed = path.join(mkdtempSync(path.join(os.tmpdir(), 'core-')), 'core');
  assert.throws(
    () =>
      buildCore({
        platform: 'linux',
        arch: 'x64',
        out: failed,
        prebuilt: '/p',
        exists: () => true,
        copy: () => undefined,
        run: fails as any,
      }),
    /did not build for linux-x64-gnu\. It builds in Docker, on a linux\/amd64 machine/,
  );
  // without one it builds here, the addon and the bridge together; an architecture with no target is refused either way
  const run = () => assert.fail('nothing to build');
  const o = { platform: 'linux', arch: 'x64', out: '/o', run: run as any, copy: () => undefined };
  assert.throws(() => buildCore({ ...o, prebuilt: '/none', exists: () => false }), /nothing to build/);
  assert.throws(() => buildCore({ ...o, arch: 'ia32', prebuilt: '/p', exists: () => true }), /not linux ia32/);
});

test('a Linux core folder without sage-mcp beside the addon stops the package', () => {
  const seen: string[] = [];
  assert.doesNotThrow(() => checkLinuxCore('/c', (f) => (seen.push(f), true)));
  assert.deepEqual(seen, [path.join('/c', LINUX_SAGE_MCP)]);
  assert.throws(() => checkLinuxCore('/c', () => false), /\/c has no sage-mcp: build the core again/);
});
