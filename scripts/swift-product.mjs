// Builds one product of a native Swift package and publishes it signed: `swift build --product`, then codesign with the
// hardened runtime (ad-hoc, or MOPILOT_SIGN_IDENTITY for a release). build-auth-command, build-disclaim and
// build-sage-mcp are each this with their own product, identifier and package.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { publishNativeBinary } from './publish-native.mjs';
import { flagValue } from './argv.mjs';

/** `swift build` arguments for a Node arch name (x64 builds on an arm64 runner and the other way round). */
export function swiftArchArgs(arch) {
  if (!arch) return [];
  return ['--arch', arch === 'x64' ? 'x86_64' : arch];
}

/**
 * @param {{ product: string, identifier: string, pkgDir: string, linux?: boolean }} what `linux`: the package also builds with a Linux toolchain (sage-mcp, for the E2E specs on Linux runners), where nothing is codesigned
 * @param {{ out?: string, debug?: boolean, arch?: string, sign?: boolean, env?: NodeJS.ProcessEnv, log?: (...data: any[]) => void, exec?: typeof execFileSync, platform?: NodeJS.Platform, publish?: typeof publishNativeBinary }} [o]
 */
export function buildSwiftProduct(
  { product, identifier, pkgDir, linux = false },
  {
    out = path.join(pkgDir, 'build'),
    debug = false,
    arch,
    sign = true,
    env = process.env,
    log = console.log,
    exec = execFileSync,
    platform = process.platform,
    publish = publishNativeBinary,
  } = {},
) {
  const onLinux = linux && platform === 'linux';
  if (platform !== 'darwin' && !onLinux) throw new Error(`${product} builds on macOS only`);
  const config = debug ? 'debug' : 'release';
  const swiftArgs = ['-c', config, ...swiftArchArgs(arch)];
  log(`swift build ${swiftArgs.join(' ')} --product ${product}`);
  exec('swift', ['build', ...swiftArgs, '--product', product], { cwd: pkgDir, stdio: ['ignore', 'inherit', 'inherit'] });
  const binDir = exec('swift', ['build', ...swiftArgs, '--show-bin-path'], { cwd: pkgDir, encoding: 'utf8' }).trim();
  const exe = path.join(out, product);
  const identity = onLinux ? '' : env.MOPILOT_SIGN_IDENTITY || '';
  const signed = sign && !onLinux;
  const signArgs = ['--force', '--options', 'runtime', '--identifier', identifier, '--sign', identity || '-'];
  if (identity) signArgs.push('--timestamp');
  publish(
    path.join(binDir, product),
    exe,
    signed
      ? (staged) => {
          exec('codesign', [...signArgs, staged], { stdio: 'inherit' });
          exec('codesign', ['--verify', '--strict', staged], { stdio: 'inherit' });
        }
      : undefined,
  );
  log(`Built ${exe} (${!signed ? 'unsigned' : identity ? `signed: ${identity}` : 'ad-hoc signed'})`);
  return exe;
}

/**
 * A builder's command line: [--out <dir>] [--debug] [--arch arm64|x64]; --help prints the usage.
 * @param {string[]} argv
 * @param {string} script the script's path in the usage line
 * @param {(o: { out?: string, arch?: string, debug: boolean }) => unknown} build
 */
export function swiftProductCli(argv, script, build, log = console.log) {
  if (argv.includes('--help')) return log(`usage: node ${script} [--out <dir>] [--debug] [--arch arm64|x64]`);
  const out = flagValue(argv, '--out');
  build({ out: out && path.resolve(out), arch: flagValue(argv, '--arch'), debug: argv.includes('--debug') });
}
