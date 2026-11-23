// Builds Linux deb and tar.gz artifacts from the app folder produced by scripts/package.mjs.
import { build, Platform, Arch } from 'electron-builder';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue } from './argv.mjs';
import { packageExit } from './package-exit.mjs';
import edition from '../shared/edition.json' with { type: 'json' };

const { desktop } = edition;
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The distribution configuration for a prepackaged Linux app; publishing is a separate release action. */
export function linuxBuilderOptions(arch, dir, pkg = PKG) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux architecture ${arch}`);
  return {
    targets: Platform.LINUX.createTarget(['deb', 'tar.gz'], Arch[/** @type {'x64'|'arm64'} */ (arch)]),
    prepackaged: dir,
    publish: /** @type {const} */ ('never'),
    config: {
      appId: desktop.appId,
      productName: desktop.name,
      executableName: desktop.linuxExecutable,
      extraMetadata: { homepage: 'https://mopilot.ai', author: { name: 'MoPilot LLC', email: 'admin@mopilot.ai' } },
      directories: { output: 'out' },
      protocols: [{ name: desktop.name, schemes: [desktop.scheme] }],
      linux: {
        category: 'Development',
        icon: 'build/icon.png',
        executableName: desktop.linuxExecutable,
        synopsis: 'A desktop home for coding agents',
        artifactName: desktop.artifactPrefix + '-${version}-${arch}.${ext}',
        desktop: { entry: { StartupWMClass: desktop.name } },
      },
      // Preserve electron-builder's Debian desktop dependencies when adding the terminal/audio/peer-check requirements.
      deb: {
        // Retain the installed Debian identity so upgrades replace existing installations. A package's name is the
        // deb target's option: under `linux` electron-builder refuses the whole configuration.
        packageName: desktop.debianPackage,
        artifactName: `${desktop.artifactPrefix}-${pkg.version}-${arch}.deb`,
        depends: [
          'libgtk-3-0',
          'libnotify4',
          'libnss3',
          'libxss1',
          'libxtst6',
          'xdg-utils',
          'libatspi2.0-0',
          'libuuid1',
          'libsecret-1-0',
          'libgbm1',
          'libasound2t64 | libasound2',
          'iproute2',
        ],
      },
    },
  };
}

/** @param {string[]} argv @param {{ pkg?: typeof PKG, arch?: string, builder?: typeof build, exists?: typeof existsSync, log?: typeof console.log }} [deps] */
export async function packageLinux(
  argv,
  { pkg = PKG, arch: hostArch = process.arch, builder = build, exists = existsSync, log = console.log } = {},
) {
  const arch = flagValue(argv, 'arch') || hostArch;
  const dir = path.join('out', `${desktop.name}-linux-${arch}`);
  const options = linuxBuilderOptions(arch, dir, pkg);
  const bin = path.join(dir, desktop.linuxExecutable);
  if (!exists(bin)) throw new Error(`${bin} not found: run npm run package:linux:dir first`);
  await builder(options);
  const files = ['deb', 'tar.gz'].map((extension) => path.join('out', `${desktop.artifactPrefix}-${pkg.version}-${arch}.${extension}`));
  for (const file of files) if (!exists(file)) throw new Error(`electron-builder finished without ${file}`);
  log(`Linux packages: ${files.join(', ')}`);
  return files;
}

/** The command line reports a failed package without publishing or installing it.
 * @param {string[]} argv
 * @param {NonNullable<Parameters<typeof packageLinux>[1]> & { error?: typeof console.error }} [deps]
 */
export async function main(argv, { error = console.error, ...deps } = {}) {
  try {
    await packageLinux(argv, deps);
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageExit(await main(process.argv.slice(2)));
