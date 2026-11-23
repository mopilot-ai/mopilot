// How an installed harness CLI was installed, read from where its binary really is, and the command that updates
// it that same way: the CLI's own updater, Homebrew, or the package manager that owns its global folder. When the
// path says nothing sure (or a version manager, an app bundle or a root-owned folder owns it), the update is not
// offered and the reason is said instead. Reference: magpie internal/agent/cliupdate.go (howInstalled).
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { HARNESS_INSTALL } = require('../../shared/harnessInstall.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * What the install table can't say: the CLI's own updater, by where its vendor's installer puts it (real path,
 * forward slashes), and Homebrew names a harness is still found under though the table no longer offers them.
 * @type {Record<string, { self?: { at: RegExp, args: string[] }[], brew?: string[] }>}
 */
const EXTRA = {
  // ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>; on Windows the binary itself in ~\.local\bin
  claude: { self: [{ at: /\/\.local\/share\/claude\/versions\/|\/\.local\/bin\/claude\.exe$/i, args: ['update'] }] },
  // the standalone installer's ~/.codex/packages/standalone/releases/...
  codex: { self: [{ at: /\/\.codex\/packages\/standalone\//, args: ['update'] }] },
  'acp:opencode': { self: [{ at: /\/\.opencode\/bin\//, args: ['upgrade'] }], brew: ['opencode'] },
  // cursor.com/install: ~/.local/bin/cursor-agent -> ~/.local/share/cursor-agent/versions/<v>/cursor-agent
  'acp:cursor': { self: [{ at: /\/\.local\/share\/cursor-agent\/versions\//, args: ['update'] }] },
  // download_cli.sh puts the binary itself in ~/.local/bin
  'acp:goose': { self: [{ at: /\/\.local\/bin\/goose$/, args: ['update'] }] },
  // Homebrew's gemini-cli formula, deprecated but still installed on machines that took it
  'acp:gemini': { brew: ['gemini-cli'] },
};

/** The npm packages and Homebrew names a harness is published under. */
function published(kind) {
  const methods = HARNESS_INSTALL[kind]?.methods ?? [];
  const npm = methods.flatMap((m) => (m.npm ? [m.npm] : []));
  // a tap's formula installs under its last segment (anomalyco/tap/opencode -> Cellar/opencode)
  const brew = methods.flatMap((m) => (m.brew ? [m.brew.name.split('/').pop()] : []));
  return { npm, brew: [...new Set([...brew, ...(EXTRA[kind]?.brew ?? [])])], self: EXTRA[kind]?.self ?? [] };
}

/**
 * @typedef {'self' | 'brew' | 'npm' | 'bun' | 'pnpm' | 'app-bundle' | 'unknown'} Via
 * @typedef {'unknown-install' | 'needs-admin' | 'app-bundle' | 'version-manager'} Blocked
 * @typedef {{ via: Via, argv: string[] | null, shown: string | null, pkg: string | null, cask: boolean,
 *   env: Record<string, string> | null, blocked: Blocked | null, from: string, packageJson: string | null,
 *   pathVersion: string | null }} Method
 * @typedef {{ realpath: (p: string) => string, exists: (p: string) => boolean, canWrite: (p: string) => boolean,
 *   which: (name: string) => string | null, platform: string, home: string, pathEnv: string }} Io
 */

/** A folder with the home folder as ~. */
const tilde = (p, home) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** The update as a person would type it: the program's name, then its arguments (home as ~, quoted where they have
 * spaces). */
const shown = (argv, home) =>
  [path.basename(argv[0]), ...argv.slice(1).map((a) => tilde(a, home))].map((p) => (/[\s"]/.test(p) ? JSON.stringify(p) : p)).join(' ');

/** @returns {Method} */
const method = (o, home = '') => ({
  via: 'unknown',
  argv: null,
  pkg: null,
  cask: false,
  env: null,
  blocked: null,
  from: '',
  packageJson: null,
  pathVersion: null,
  ...o,
  shown: o.argv ? shown(o.argv, home) : null,
});

/**
 * How the CLI at `bin` was installed and what updates it.
 * @param {string} kind the registry kind
 * @param {string} bin the binary chats run, as found
 * @param {Io} io
 * @returns {Method}
 */
function howInstalled(kind, bin, io) {
  let real = bin;
  try {
    real = io.realpath(bin);
  } catch (error) {
    // a link that leads nowhere: the path as found is all there is to read
    noteIgnored('resolve a harness binary to see how it was installed', error, ['ENOENT']);
  }
  const slash = real.replace(/\\/g, '/');
  const spec = published(kind);
  // the CLI's own updater installs what its npm package has, so that is where its newest version is read
  // its version folder (…/versions/2.1.302) says which version this binary is, without running it
  const pathVersion = /\/versions\/v?(\d+\.\d+[^/]*)/.exec(slash)?.[1] ?? null;
  for (const s of spec.self)
    if (s.at.test(slash))
      return method({ via: 'self', argv: [bin, ...s.args], pkg: spec.npm[0] ?? null, from: 'standalone install', pathVersion }, io.home);
  // a desktop app's bundled CLI updates with the app; Claude desktop keeps its copies in its data folder
  // (…/Claude/claude-code/<v>/<hash>/claude.app on macOS, …\Claude\claude-code\<v>\claude.exe on Windows)
  if (/\/(Library\/Application Support|AppData\/Roaming)\/Claude\/claude-code\//i.test(slash))
    return method({ via: 'app-bundle', blocked: 'app-bundle', from: 'Claude.app', pathVersion });
  const app = /\/([^/]+)\.app\/Contents\//.exec(slash);
  if (app) return method({ via: 'app-bundle', blocked: 'app-bundle', from: `${app[1]}.app` });
  // a formula of the harness's own is Homebrew's, though a Node one keeps the npm package inside its keg
  // (Cellar/gemini-cli/<v>/libexec/lib/node_modules/...), where npm would change the keg behind brew's back
  const keg = /\/(Cellar|Caskroom)\/([^/]+)\//.exec(slash);
  if (keg && spec.brew.includes(keg[2])) return fromBrew(slash, keg, io);
  for (const pkg of spec.npm) {
    const m = fromNodeModules(pkg, bin, slash, io);
    if (m) return m;
  }
  return method({ blocked: 'unknown-install' });
}

/** Homebrew's formula or cask `keg[2]`, updated by the brew of the prefix it is under. */
function fromBrew(slash, keg, io) {
  // the match is in `slash` (it was found there), so its index is where Homebrew's prefix ends
  const prefix = slash.slice(0, keg.index);
  const own = `${prefix}/bin/brew`;
  const brew = io.exists(own) ? own : io.which('brew');
  const cask = keg[1] === 'Caskroom';
  const from = `Homebrew${cask ? ' cask' : ''}`;
  // Cellar/<name>/<version>/…, Caskroom/<name>/<version>/…: the version this binary is
  const pathVersion = /^(\d[^/,_]*)/.exec(slash.slice(keg.index + keg[0].length))?.[1] ?? null;
  if (!brew) return method({ via: 'brew', pkg: keg[2], cask, blocked: 'unknown-install', from, pathVersion });
  const argv = [brew, 'upgrade', ...(cask ? ['--cask'] : []), keg[2]];
  return method({ via: 'brew', pkg: keg[2], cask, from, argv, pathVersion }, io.home);
}

/** A CLI package `pkg` installed in a global node_modules: by the manager that owns that folder. */
function fromNodeModules(pkg, bin, slash, io) {
  const mark = `/node_modules/${pkg}/`;
  let modules = '';
  const at = slash.indexOf(mark);
  if (at >= 0) modules = `${slash.slice(0, at)}/node_modules`;
  else if (/\.(cmd|ps1)$/i.test(bin)) {
    // npm's Windows shim beside its node_modules
    const dir = path.posix.dirname(bin.replace(/\\/g, '/'));
    if (io.exists(`${dir}/node_modules/${pkg}`)) modules = `${dir}/node_modules`;
  }
  if (!modules) return null;
  const lower = `${slash}|${bin.replace(/\\/g, '/')}`.toLowerCase();
  const packageJson = `${modules}/${pkg}/package.json`;
  if (lower.includes('/.bun/')) return viaManager('bun', pkg, io, packageJson);
  if (lower.includes('/pnpm/') || lower.includes('/.pnpm/')) return viaManager('pnpm', pkg, io, packageJson);
  if (/\/(\.volta|\.?yarn|mise|\.asdf|\.nodenv)\//.test(lower))
    return method({ via: 'npm', pkg, blocked: 'version-manager', from: 'a version manager', packageJson });
  // the prefix npm installed it under: <prefix>/lib/node_modules on macOS and Linux, <prefix>\node_modules on Windows
  let prefix = path.posix.dirname(modules);
  let npm = `${prefix}/npm.cmd`;
  if (io.platform !== 'win32') {
    if (path.posix.basename(prefix) !== 'lib') return null;
    prefix = path.posix.dirname(prefix);
    npm = `${prefix}/bin/npm`;
  }
  const own = io.exists(npm);
  const runner = own ? npm : io.which('npm');
  const from = `npm (${tilde(prefix, io.home)})`;
  if (!runner) return method({ via: 'npm', pkg, blocked: 'unknown-install', from, packageJson });
  const argv = [runner, 'install', '-g', '--prefix', prefix, `${pkg}@latest`];
  // a root-owned prefix (a system Node's /usr/local): npm would want sudo, which we never run; the command is copied
  if (!io.canWrite(modules)) return method({ via: 'npm', pkg, argv, blocked: 'needs-admin', from, packageJson }, io.home);
  // that prefix's own npm and node first on PATH, so a system node elsewhere on PATH doesn't install into its folder
  const env = own ? { PATH: `${path.posix.dirname(npm)}${io.platform === 'win32' ? ';' : ':'}${io.pathEnv}` } : null;
  return method({ via: 'npm', pkg, argv, env, from, packageJson }, io.home);
}

/** A global package bun or pnpm installed, updated by that manager. */
function viaManager(via, pkg, io, packageJson) {
  const runner = io.which(via);
  if (!runner) return method({ via, pkg, blocked: 'unknown-install', from: via, packageJson });
  return method({ via, pkg, argv: [runner, 'add', '-g', `${pkg}@latest`], from: via, packageJson }, io.home);
}

/**
 * How the CLI at `bin` was installed, in the two fields Settings names each install found by (cliSource.ts
 * installSource): no update is worked out from them.
 * @param {string} kind
 * @param {string} bin
 * @param {Io} io
 * @returns {{ via: Via, from: string }}
 */
function installSource(kind, bin, io) {
  const { via, from } = howInstalled(kind, bin, io);
  return { via, from };
}

/** The real filesystem, for production. */
const realIo = (/** @type {Pick<Io, 'which' | 'platform' | 'home' | 'pathEnv'>} */ o) => ({
  ...o,
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => fs.existsSync(p),
  canWrite: (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch (error) {
      // not there, or not ours to write (EACCES, EPERM): no
      noteIgnored('check whether an npm folder can be written', error, ['ENOENT', 'EACCES', 'EPERM']);
      return false;
    }
  },
});

/**
 * This machine's filesystem with the login shell's PATH (platform/env.cjs), as every caller in main reads installs.
 * @param {{ which: (name: string) => string | null, childEnv: () => Record<string, string | undefined> }} shellEnv
 * @returns {Io}
 */
const hostIo = (shellEnv) =>
  realIo({
    which: (n) => shellEnv.which(n),
    platform: process.platform,
    home: os.homedir(),
    pathEnv: String(shellEnv.childEnv().PATH),
  });

module.exports = { howInstalled, installSource, published, realIo, hostIo, EXTRA };
