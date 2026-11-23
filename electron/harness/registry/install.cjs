// Installs one explicitly selected ACP distribution into a private staging folder and writes a literal-argument launcher.
const path = require('node:path');
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const { shQuote } = require('../../platform/disclaim.cjs');
const { containedCommand } = require('../../../shared/acpRegistry.mjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');

/** A launcher never evaluates registry arguments or environment values as shell syntax. */
function launcher(program, args, env) {
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return `#!/bin/sh\nexec /usr/bin/env ${[...pairs, program, ...args].map(shQuote).join(' ')} "$@"\n`;
}

/** Tar links/special files and paths that leave the extraction root are refused before extraction. */
function checkTar(names, listing) {
  for (const name of names.trim().split('\n')) {
    const clean = name.replace(/\/$/, '');
    if (clean === '.' || clean === './') continue;
    if (!containedCommand(clean)) throw new Error('The ACP archive contains a path outside its install folder.');
  }
  if (listing.split('\n').some((line) => line && !['-', 'd'].includes(line[0])))
    throw new Error('The ACP archive contains a link or special file.');
}

/**
 * @param {{ agent: import('../../../shared/acpRegistry.mjs').RegistryAgent, distribution: any, stage: string, packageCache?: string,
 *   which: (name: string) => string | null, runPackage: (spec: any) => Promise<void>,
 *   signal?: AbortSignal, fetch?: typeof fetch, extractZip?: (file: string, destination: string) => Promise<void>, exec?: typeof import('../../platform/ports/proc.cjs').proc.execFileSync }} o
 */
async function installDistribution({
  agent,
  distribution: d,
  stage,
  packageCache = path.join(stage, 'package-cache'),
  which,
  runPackage,
  signal = new AbortController().signal,
  fetch: fetchFn = fetch,
  extractZip,
  exec = require('../../platform/ports/proc.cjs').proc.execFileSync,
}) {
  signal.throwIfAborted();
  let program;
  let args = d.args;
  let env = d.env;
  let prefix = [];
  if (d.kind === 'binary') {
    const response = await fetchFn(d.archive, { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`The agent download answered HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    signal.throwIfAborted();
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== d.sha256)
      throw new Error('The ACP agent download does not match its published checksum.');
    const archive = path.join(stage, 'download');
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    const extracted = path.join(stage, 'agent');
    fs.mkdirSync(extracted, { mode: 0o700 });
    const urlPath = new URL(d.archive).pathname.toLowerCase();
    if (urlPath.endsWith('.zip')) {
      const unzip = extractZip ?? (await import('../../platform/archives/zipExtract.mjs')).extractZip;
      await unzip(archive, extracted);
      signal.throwIfAborted();
    } else if (/\.(?:tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|tar)$/.test(urlPath)) {
      const names = String(exec('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      const listing = String(exec('tar', ['-tvf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      checkTar(names, listing);
      exec('tar', ['-xf', archive, '-C', extracted]);
    } else {
      if (/\.(?:dmg|pkg|deb|rpm|msi|appimage)$/.test(urlPath))
        throw new Error('That ACP distribution uses an unsupported installer format.');
      program = path.join(extracted, d.cmd);
      fs.mkdirSync(path.dirname(program), { recursive: true, mode: 0o700 });
      fs.renameSync(archive, program);
    }
    program = path.join(extracted, d.cmd);
    if (!fs.statSync(program, { throwIfNoEntry: false })?.isFile())
      throw new Error('The ACP archive did not contain its declared executable.');
    fs.chmodSync(program, 0o700);
    fs.rmSync(archive, { force: true });
  } else if (d.kind === 'npx') {
    const npm = which('npm');
    program = which('npx');
    if (!npm || !program) throw new Error('Install Node.js and npm before installing this ACP agent.');
    await runPackage({
      via: 'npm',
      argv: [npm, 'exec', '--cache', packageCache, '--yes', '--package', d.package, '--call', 'exit 0'],
      cwd: stage,
      signal,
    });
    signal.throwIfAborted();
    prefix = ['--cache', packageCache, '--yes', d.package];
  } else {
    program = which('uvx');
    if (!program) throw new Error('Install uv before installing this ACP agent.');
    await runPackage({
      via: 'uv',
      argv: [program, '--cache-dir', packageCache, '--from', d.package, 'python', '-c', 'pass'],
      cwd: stage,
      signal,
    });
    signal.throwIfAborted();
    prefix = ['--cache-dir', packageCache, d.package];
  }
  return { program, prefix, args, env };
}

/** Publish the launcher only after all program paths were moved into their final private directory. */
function writeLauncher(file, spec) {
  writeAtomic(file, launcher(spec.program, spec.args, spec.env), fs, 0o700);
}

module.exports = { installDistribution, launcher, checkTar, writeLauncher };
