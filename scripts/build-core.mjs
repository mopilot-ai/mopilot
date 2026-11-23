// Builds the Rust core's Node addon (core/crates/node) for macOS/Linux arm64 or x64, or Windows x64, as mopilot_core.node,
// for scripts/package.mjs, which ships it in the app's resources/core where electron/platform/core.cjs looks
// (docs/architecture/rust-core.md §8). macOS signs it with the app (osx-sign), and library validation is its integrity
// check; Windows has no such check, so the release signs it before packaging and the package records its hash. Windows
// and Linux also get sage-mcp (core/crates/sage-mcp) beside it, the tool bridge macOS has as a Swift helper.
// It also builds the addons a Host carries, one per machine (shared/host/coreBuild.mjs): the app holds them all in
// resources/host-core and sends each machine its own (electron/host/bundle.cjs). Node-API makes one addon load under
// Electron and any Node 22+, so the same crate serves. Linux builds run in a container, which is what sets their floors.
// A checkout's own addon, for the E2E and performance runs that run from one, is core/target/release's (ensureCore), with
// sage-mcp.exe beside it on Windows.
//   node scripts/build-core.mjs --platform win32 --arch x64 --out <dir>    (the release's Windows core job)
//   node scripts/build-core.mjs --host linux-x64-musl --out <dir>          (the release's Host core jobs: <dir>/<build>/)
//   node scripts/build-core.mjs --ensure                                   (tests/e2e/global-setup.ts)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_BUILDS, HOST_CORE_ADDON } from '../shared/host/coreBuild.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Each macOS architecture's Rust target. */
export const TRIPLES = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
/** Windows' Rust targets: the release ships x64. */
export const WINDOWS_TRIPLES = { x64: 'x86_64-pc-windows-msvc' };
/** Linux's GNU targets, built on the corresponding Linux release runner. */
export const LINUX_TRIPLES = { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' };
/** The app's minimum macOS (LSMinimumSystemVersion in scripts/build-helper.mjs), so the addon links no newer API. */
export const MACOS_TARGET = '14.0';
/** The addon's name in the app: the one electron/platform/core.cjs loads. */
export const ADDON = HOST_CORE_ADDON;
/** Windows' sage-mcp, beside the addon, where electron/capabilities/mcp/socket.cjs sageMcpPath looks. */
export const WINDOWS_SAGE_MCP = 'sage-mcp.exe';
/** Linux's, beside the addon there too: the package's harnesses start it, a Linux checkout runs host/bin/sage-mcp.mjs. */
export const LINUX_SAGE_MCP = 'sage-mcp';

/** The C runtime linked in on Windows: the app does not start without its core, and a stock Windows has no VC++ runtime. */
export const STATIC_CRT = '-C target-feature=+crt-static';

/** The oldest macOS the Host's pinned Node runs on (electron/host/nodeRuntime.cjs), lower than the app's own minimum. */
export const HOST_MACOS_TARGET = '13.5';
/**
 * The oldest glibc a Host addon may need. Official Node needs 2.28, but a machine older than that runs the Host on its own Node 22+ (electron/host/installRuntime.cjs): 2.17 is the oldest a Node 22 is built for (unofficial-builds' glibc-217) and the oldest Rust supports, so every Node that can run a Host can load the addon.
 */
export const GLIBC_FLOOR = '2.17';
/** The container each Linux build is made in, for its C library and floor; pinned, and the Rust in the musl one is the channel core/ pins. */
export const MANYLINUX_X64 = 'quay.io/pypa/manylinux2014_x86_64@sha256:dc58399aca4cfb0de257f92e2de71b4f8421e60cce8542fcd5e28df0c0760942';
const MANYLINUX_ARM64 = 'quay.io/pypa/manylinux2014_aarch64@sha256:db68ee9e5e879da5945dfbc8cab446f02245da6522aca0a9e4cda9256c911d2f';
export const RUST_ALPINE = 'rust:1.99.1-alpine@sha256:f432d4b8663fbc50b29e33846bf6a1fb9f17f142023598899d641cddf57c6b22';
/** The rustup-init a manylinux container installs the pinned toolchain with: the image has no Rust. */
const RUSTUP = 'https://static.rust-lang.org/rustup/archive/1.29.3';
const RUSTUP_SHA256 = {
  x86_64: 'b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55',
  aarch64: '9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282',
};

/**
 * Each Linux Host build. The musl target links musl statically by default, and then rustc makes no cdylib at all, so `crt-static` goes off: the addon must share the libc of the Node that loads it.
 * @type {Record<string, { triple: string, image: string, platform: string, libc: 'gnu' | 'musl' }>}
 */
export const LINUX_BUILDS = {
  'linux-x64-gnu': { triple: 'x86_64-unknown-linux-gnu', image: MANYLINUX_X64, platform: 'linux/amd64', libc: 'gnu' },
  'linux-arm64-gnu': { triple: 'aarch64-unknown-linux-gnu', image: MANYLINUX_ARM64, platform: 'linux/arm64', libc: 'gnu' },
  'linux-x64-musl': { triple: 'x86_64-unknown-linux-musl', image: RUST_ALPINE, platform: 'linux/amd64', libc: 'musl' },
  'linux-arm64-musl': { triple: 'aarch64-unknown-linux-musl', image: RUST_ALPINE, platform: 'linux/arm64', libc: 'musl' },
};

/**
 * What a container runs: the crate's build, after installing Rust where the image has none.
 * @param {{ triple: string, libc: string }} b @param {string} crate the package cargo builds (`node`, the addon, or `sage-mcp`)
 */
function containerScript({ triple, libc }, crate) {
  const build = `cargo build --release --locked -p ${crate} --target ${triple}`;
  if (libc === 'musl') return build;
  const arch = /** @type {'x86_64' | 'aarch64'} */ (triple.split('-')[0]);
  return [
    'set -e',
    `curl -fsSL -o /tmp/rustup-init ${RUSTUP}/${triple}/rustup-init`,
    `echo '${RUSTUP_SHA256[arch]}  /tmp/rustup-init' | sha256sum -c -`,
    'chmod +x /tmp/rustup-init',
    '/tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none',
    'export PATH="$CARGO_HOME/bin:$PATH"',
    build,
  ].join(' && ');
}

/** The highest `GLIBC_x.y` an ELF file names. @param {Buffer} bytes @returns {number[]} */
function neededGlibc(bytes) {
  const versions = [...bytes.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  return versions.reduce((top, v) => (v[0] > top[0] || (v[0] === top[0] && v[1] > top[1]) ? v : top), [0, 0]);
}

/**
 * Throws when `addon` needs a newer glibc than the floor: such an addon builds and passes on a new machine, and only an old one finds out.
 * @param {string} addon @param {(f: string) => Buffer} [read]
 */
export function checkGlibcFloor(addon, read = readFileSync) {
  const [major, minor] = neededGlibc(read(addon));
  const [floorMajor, floorMinor] = GLIBC_FLOOR.split('.').map(Number);
  if (major > floorMajor || (major === floorMajor && minor > floorMinor))
    throw new Error(`${addon} needs glibc ${major}.${minor}, newer than the floor ${GLIBC_FLOOR}.`);
}

/**
 * Build one Host addon into `out`/<build>/mopilot_core.node, a macOS one on this Mac for Node's minimum, a Linux one in its container.
 * @param {{ build: string, out: string, repoRoot?: string, run?: (cmd: string, args: string[], o: object) => { status: number | null, error?: Error }, copy?: (from: string, to: string) => void, read?: (f: string) => Buffer }} o
 * @returns {string} the addon's path
 */
export function buildHostCore({ build, out, repoRoot = root, run = spawnSync, copy = copyFileSync, read = readFileSync }) {
  if (!CORE_BUILDS.includes(build)) throw new Error(`There is no Host build ${build}: the builds are ${CORE_BUILDS.join(', ')}.`);
  const dir = path.join(out, build);
  const linux = LINUX_BUILDS[build];
  if (!linux) return buildCore({ arch: build.replace('darwin-', ''), out: dir, macos: HOST_MACOS_TARGET, repoRoot, run, copy });
  const release = buildInContainer(build, 'node', { repoRoot, run });
  mkdirSync(dir, { recursive: true });
  const addon = path.join(dir, ADDON);
  copy(path.join(release, 'libmopilot_core.so'), addon);
  if (linux.libc === 'gnu') checkGlibcFloor(addon, read);
  return addon;
}

/**
 * Build `crate` for the Linux build `build` in its container (LINUX_BUILDS). Returns the folder cargo left it in.
 * @param {string} build @param {string} crate
 * @param {{ repoRoot: string, run: (cmd: string, args: string[], o: object) => { status: number | null, error?: Error } }} o
 */
function buildInContainer(build, crate, { repoRoot, run }) {
  const linux = LINUX_BUILDS[build];
  const core = path.join(repoRoot, 'core');
  const env = [`CARGO_TARGET_DIR=/core/target/${build}`, 'CARGO_HOME=/tmp/cargo', 'RUSTUP_HOME=/tmp/rustup'];
  if (linux.libc === 'musl') env.splice(1, 2, 'RUSTFLAGS=-C target-feature=-crt-static', 'RUSTUP_TOOLCHAIN=1.99.1');
  const built = run(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      linux.platform,
      '-v',
      `${core}:/core`,
      '-w',
      '/core',
      ...env.flatMap((e) => ['-e', e]),
      linux.image,
      'sh',
      '-c',
      containerScript(linux, crate),
    ],
    { stdio: 'inherit' },
  );
  if (built.error || built.status !== 0)
    throw new Error(
      `The Rust core did not build for ${build}${built.error ? ` (${built.error.message})` : ''}. It builds in Docker, on a ${linux.platform} machine.`,
    );
  return path.join(core, 'target', build, linux.triple, 'release');
}

/**
 * Build the addon for `platform` and `arch` and copy it to `out`/mopilot_core.node, with sage-mcp beside it on Windows and
 * Linux. A Linux `prebuilt` addon (the release's Host build, held to the lowest glibc) is copied instead, and sage-mcp is
 * built in that build's container, to the same floor. Throws when the build fails: an app that should hold the core does
 * not ship without it.
 * @param {{ platform?: string, arch: string, out: string, macos?: string, repoRoot?: string, run?: (cmd: string, args: string[], o: object) => { status: number | null, error?: Error }, prebuilt?: string | null, exists?: (f: string) => boolean, copy?: (from: string, to: string) => void, read?: (f: string) => Buffer }} o
 * @returns {string} the addon's path
 */
export function buildCore({
  platform = 'darwin',
  arch,
  out,
  macos = MACOS_TARGET,
  repoRoot = root,
  run = spawnSync,
  copy = copyFileSync,
  prebuilt = null,
  exists = existsSync,
  read = readFileSync,
}) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  const targets = /** @type {Record<string, string>} */ (win ? WINDOWS_TRIPLES : mac ? TRIPLES : linux ? LINUX_TRIPLES : {});
  const triple = Object.hasOwn(targets, arch) ? targets[arch] : undefined;
  if (!triple) throw new Error(`The Rust core is built for macOS and Linux arm64 or x64 and Windows x64, not ${platform} ${arch}.`);
  const addon = path.join(out, ADDON);
  const bridge = win ? WINDOWS_SAGE_MCP : linux ? LINUX_SAGE_MCP : null;
  if (prebuilt && exists(prebuilt)) {
    mkdirSync(out, { recursive: true });
    copy(prebuilt, addon);
    if (linux) {
      const shipped = path.join(out, LINUX_SAGE_MCP);
      copy(path.join(buildInContainer(`linux-${arch}-gnu`, 'sage-mcp', { repoRoot, run }), LINUX_SAGE_MCP), shipped);
      checkGlibcFloor(shipped, read);
    }
    return addon;
  }
  const core = path.join(repoRoot, 'core');
  const packages = bridge ? ['-p', 'node', '-p', 'sage-mcp'] : ['-p', 'node'];
  const built = run('cargo', ['build', '--release', '--locked', ...packages, '--target', triple], {
    cwd: core,
    stdio: 'inherit',
    env: mac ? { ...process.env, MACOSX_DEPLOYMENT_TARGET: macos } : win ? { ...process.env, RUSTFLAGS: STATIC_CRT } : process.env,
  });
  if (built.error || built.status !== 0) {
    throw new Error(
      `The Rust core did not build for ${platform} ${arch}${built.error ? ` (${built.error.message})` : ''}. Install its toolchain in core/ (rustup toolchain install) and \`rustup target add ${triple}\`.`,
    );
  }
  mkdirSync(out, { recursive: true });
  const release = path.join(core, 'target', triple, 'release');
  const library = win ? 'mopilot_core.dll' : mac ? 'libmopilot_core.dylib' : 'libmopilot_core.so';
  copy(path.join(release, library), addon);
  if (bridge) copy(path.join(release, bridge), path.join(out, bridge));
  return addon;
}

/**
 * Throws when a Linux core folder that holds the addon has no sage-mcp beside it, which would ship Codex and the basic
 * harnesses without their tools.
 * @param {string} dir @param {(f: string) => boolean} exists
 */
export function checkLinuxCore(dir, exists) {
  if (!exists(path.join(dir, LINUX_SAGE_MCP))) throw new Error(`${dir} has no ${LINUX_SAGE_MCP}: build the core again.`);
}

/**
 * Throws when a Windows core folder that holds the addon has no sage-mcp.exe beside it, which would ship the basic
 * harnesses without their tools, or when either file needs a runtime a stock Windows does not have.
 * @param {string} dir @param {(f: string) => boolean} exists @param {(f: string) => Buffer} [read]
 */
export function checkWindowsCore(dir, exists, read = readFileSync) {
  if (!exists(path.join(dir, WINDOWS_SAGE_MCP))) throw new Error(`${dir} has no ${WINDOWS_SAGE_MCP}: build the core again.`);
  // its import table names the DLL it would need, and a machine without it could not load the core
  for (const file of [ADDON, WINDOWS_SAGE_MCP])
    if (/vcruntime\d+/i.test(read(path.join(dir, file)).toString('latin1')))
      throw new Error(`${file} needs the VC++ runtime: build the core again.`);
}

/** Where a Windows package records its addon's hash, in app.asar beside the loader (electron/platform/core.cjs). */
export const CORE_HASH_FILE = 'electron/platform/core-hash.json';

/**
 * Record `addon`'s SHA-256 in `file` as `{ sha256 }`, for the packaged loader to check before it loads it. Taken from the
 * signed addon: signing changes the file.
 * @param {string} addon @param {string} file
 * @param {{ read?: (f: string) => Buffer, write?: (f: string, text: string) => void }} [io]
 * @returns {string} the hash
 */
export function recordCoreHash(addon, file, { read = readFileSync, write = writeFileSync } = {}) {
  const sha256 = createHash('sha256').update(read(addon)).digest('hex');
  write(file, `${JSON.stringify({ sha256 })}\n`);
  return sha256;
}

/** Where a package records the hash of each Host build it carries, in app.asar beside the code that sends them (electron/host/bundle.cjs). */
export const HOST_CORE_HASH_FILE = 'electron/host/host-core-hashes.json';

/** What a checkout's addon is built from, under core/: the same list as the `core-addon-` Actions cache key. */
export const CORE_SOURCES = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', 'crates'];
/** Beside a checkout's addon, the hash of the sources it was built from. */
export const CORE_SOURCES_STAMP = 'core-sources.sha256';

/** The files at `p`, in a stable order. */
const filesIn = (/** @type {string} */ p) =>
  statSync(p).isDirectory()
    ? readdirSync(p)
        .sort()
        .flatMap((/** @type {string} */ f) => filesIn(path.join(p, f)))
    : [p];

/**
 * The hash of `core`'s sources, by name and content: a restored cache gives every file a new time, and without cargo's
 * own records a build would start over, so neither can say whether an addon is current.
 * @param {string} core the core/ folder
 */
export function coreSourcesHash(core) {
  const hash = createHash('sha256');
  for (const file of CORE_SOURCES.flatMap((name) => filesIn(path.join(core, name))))
    hash.update(path.relative(core, file).split(path.sep).join('/')).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}

/** The addon electron/platform/core.cjs looks for in a checkout, as Cargo names it. */
const checkoutAddon = (/** @type {string} */ repoRoot) =>
  createRequire(import.meta.url)('../electron/platform/core.cjs').corePath({ env: {}, root: repoRoot, resources: '', packaged: false });

/**
 * A checkout's addon, where electron/platform/core.cjs finds it, built when it is missing or not from these sources, so
 * the app can start. On Windows sage-mcp.exe is built with it, into the same folder, where
 * electron/capabilities/mcp/socket.cjs sageMcpPath looks in a checkout: Windows has no Swift sage-mcp. Returns the addon's
 * path, or null when there is no toolchain to build it with (a self-hosted runner's cache miss: the app then refuses to
 * start and says why); with a toolchain, a failed build throws.
 * @param {{ repoRoot?: string, addon?: string, platform?: string, run?: (cmd: string, args: string[], o: object) => { status: number | null, error?: NodeJS.ErrnoException }, log?: (line: string) => void }} [o]
 */
export function ensureCore({
  repoRoot = root,
  addon = checkoutAddon(repoRoot),
  platform = process.platform,
  run = spawnSync,
  log = console.log,
} = {}) {
  const core = path.join(repoRoot, 'core');
  const stamp = path.join(path.dirname(addon), CORE_SOURCES_STAMP);
  const bridge = platform === 'win32' ? path.join(path.dirname(addon), WINDOWS_SAGE_MCP) : null;
  const sources = coreSourcesHash(core);
  if (existsSync(addon) && (!bridge || existsSync(bridge)) && existsSync(stamp) && readFileSync(stamp, 'utf8') === sources) return addon;
  // the toolchain core/rust-toolchain.toml pins; a blip here is cargo's to try again, and no rustup leaves cargo's own
  run('rustup', ['toolchain', 'install'], { cwd: core, stdio: 'inherit' });
  const packages = bridge ? ['-p', 'node', '-p', 'sage-mcp'] : ['-p', 'node'];
  const built = run('cargo', ['build', '--release', '--locked', ...packages], { cwd: core, stdio: 'inherit' });
  if (built.error?.code === 'ENOENT') {
    log('No Rust toolchain: the app does not start without a Rust core of these sources. Install rustup.');
    return null;
  }
  if (built.error || built.status !== 0) throw new Error(`The Rust core did not build${built.error ? ` (${built.error.message})` : ''}.`);
  writeFileSync(stamp, sources);
  return addon;
}

/**
 * Record each Host addon's SHA-256 in `file`, as `{ <build>: sha256 }`. Taken from the file that ships: signing changes it. Throws when a build is missing: a package with a hole would refuse those machines only once someone adds one.
 * @param {string} dir the folder of builds @param {string} file
 * @param {{ read?: (f: string) => Buffer, write?: (f: string, text: string) => void, exists?: (f: string) => boolean }} [io]
 * @returns {Record<string, string>} the hashes
 */
export function recordHostCores(dir, file, { read = readFileSync, write = writeFileSync, exists = existsSync } = {}) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const build of CORE_BUILDS) {
    const addon = path.join(dir, build, ADDON);
    if (!exists(addon)) throw new Error(`${dir} has no ${build} build: every Host build ships, or none.`);
    hashes[build] = createHash('sha256').update(read(addon)).digest('hex');
  }
  write(file, `${JSON.stringify(hashes)}\n`);
  return hashes;
}

/**
 * The command line's options: `--platform`, `--arch` and `--out`, each required, or `--host` and `--out`.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['platform', 'arch', 'out', 'host'].includes(key) || argv[i + 1] === undefined)
      throw new Error(`Unknown or empty option ${argv[i]}`);
    o[key] = argv[i + 1];
  }
  for (const key of o.host ? ['out'] : ['platform', 'arch', 'out']) if (!o[key]) throw new Error(`--${key} is required`);
  return /** @type {{ platform: string, arch: string, out: string, host?: string }} */ (o);
}

/** What the command line asks for: `--ensure`, or a build for the release, the app's or a Host's. @param {string[]} argv */
export function runCli(argv, { ensure = ensureCore, build = buildCore, buildHost = buildHostCore } = {}) {
  if (argv[0] === '--ensure') {
    const addon = ensure();
    // a checkout with no core does not start, so a run of it stops here rather than at every launch
    if (!addon) throw new Error('This checkout has no Rust core, and no toolchain to build one.');
    return addon;
  }
  const o = parseArgs(argv);
  return o.host ? buildHost({ build: o.host, out: o.out }) : build(o);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(runCli(process.argv.slice(2)));
}
