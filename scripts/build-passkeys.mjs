// Builds native/passkeys, the built-in browser's bridge to macOS's passkey sheet (a Node-API addon main loads).
//   node scripts/build-passkeys.mjs [--out <dir>] [--debug] [--arch arm64|x64]
// Output: native/passkeys/build/passkeys.node unless --out is given. clang links into native/passkeys/build first, made
// here since it is gitignored and a fresh clone (the release's runners) has none. Node-API is ABI-stable, so it builds
// against the node-api-headers package with clang alone and links against whichever runtime loads it (Electron's).
// Signing: ad-hoc (a checkout); scripts/package.mjs builds it unsigned (sign: false) and osx-sign signs it inside
// MoPilot.app, whose own entitlements (the web-browser passkey one) are what macOS checks.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishNativeBinary } from './publish-native.mjs';
import { swiftProductCli } from './swift-product.mjs';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/passkeys');

/**
 * clang arguments for passkeys.mm (macOS 12 is Electron's floor; the code checks 13.5 and 14.4 at run time).
 * @param {{ arch?: string, debug?: boolean, include: string, source: string, output: string }} o
 */
export function clangArgs({ arch = process.arch, debug = false, include, source, output }) {
  return [
    '-std=c++17',
    '-ObjC++',
    '-fobjc-arc',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-Wunguarded-availability',
    '-Werror',
    debug ? '-g' : '-O2',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-mmacosx-version-min=12.0',
    '-arch',
    arch === 'x64' ? 'x86_64' : arch,
    `-I${include}`,
    '-framework',
    'AuthenticationServices',
    '-framework',
    'AppKit',
    '-framework',
    'Security',
    source,
    '-o',
    output,
  ];
}

/**
 * @param {{ out?: string, scratch?: string, arch?: string, debug?: boolean, sign?: boolean, exec?: (cmd: string, args: string[], o?: object) => unknown, platform?: NodeJS.Platform, log?: (...data: any[]) => void, publish?: typeof publishNativeBinary, headers?: () => string }} [o]
 */
export function buildPasskeys({
  out = path.join(pkgDir, 'build'),
  scratch = path.join(pkgDir, 'build'),
  arch = process.arch,
  debug = false,
  sign = true,
  exec = execFileSync,
  platform = process.platform,
  log = console.log,
  publish = publishNativeBinary,
  headers = () => createRequire(import.meta.url)('node-api-headers').include_dir,
} = {}) {
  if (platform !== 'darwin') throw new Error('passkeys.node builds on macOS only');
  mkdirSync(scratch, { recursive: true });
  const built = path.join(scratch, `.passkeys-${arch}.node`);
  const args = clangArgs({ arch, debug, include: headers(), source: path.join(pkgDir, 'passkeys.mm'), output: built });
  log(`clang++ ${args.join(' ')}`);
  exec('clang++', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const target = path.join(out, 'passkeys.node');
  publish(built, target, sign ? (staged) => exec('codesign', ['--force', '--sign', '-', staged], { stdio: 'inherit' }) : undefined);
  log(`Built ${target} (${sign ? 'ad-hoc signed' : 'unsigned'})`);
  return target;
}

/** The command line (see the top of this file); --help prints the usage. */
export function cli(argv, { build = buildPasskeys, log = console.log } = {}) {
  swiftProductCli(argv, 'scripts/build-passkeys.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
