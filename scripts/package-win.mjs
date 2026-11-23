// Builds the Windows installer out/MoPilot-Setup-<version>-x64.exe (NSIS, per-user) from the
// folder scripts/package.mjs made. Runs on macOS too: electron-builder brings makensis; nothing is
// signed here. The full release flow, with signing as separate steps (jsign + Azure Artifact Signing):
//   npm run package:win:dir                   1. vite build + out/MoPilot-win32-x64/
//   <sign "out/MoPilot-win32-x64/MoPilot.exe">               2. sign the app (optional)
//   node scripts/package-win.mjs              3. out/MoPilot-Setup-<version>-x64.exe
//   <sign out/MoPilot-Setup-<version>-x64.exe>                     4. sign the installer
// `npm run package:win` does 1 and 3 in one go (unsigned). With MOPILOT_WIN_SIGN set to an
// executable, steps 2 and 4 run it with the file to sign as its only argument.
//   node scripts/package-win.mjs [--arch x64]
import { build, Platform, Arch } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue } from './argv.mjs';
import { packageExit } from './package-exit.mjs';
import edition from '../shared/edition.json' with { type: 'json' };

const { desktop } = edition;
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The electron-builder options for the NSIS installer of the prepackaged folder `dir`. */
export function builderOptions(arch, dir) {
  return {
    targets: Platform.WINDOWS.createTarget('nsis', Arch[/** @type {'x64'|'arm64'} */ (arch)]),
    prepackaged: dir,
    publish: /** @type {const} */ ('never'),
    config: {
      appId: desktop.appId,
      productName: desktop.name,
      copyright: `© ${new Date().getFullYear()} MoPilot`,
      // the uninstall entry's Publisher
      extraMetadata: { author: { name: 'MoPilot LLC' } },
      directories: { output: 'out' },
      win: {
        icon: 'build/icon.ico',
        // the exe's icon and version info were set when packaging; signing is a separate step
        signAndEditExecutable: false,
      },
      nsis: {
        // assisted installer, "Only for me" (no admin rights) preselected
        oneClick: false,
        perMachine: false,
        selectPerMachineByDefault: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: desktop.name,
        uninstallDisplayName: desktop.name,
        installerIcon: 'build/icon.ico',
        uninstallerIcon: 'build/icon.ico',
        deleteAppDataOnUninstall: false,
        // updates download the whole installer (no electron-updater), so no .blockmap
        differentialPackage: false,
        artifactName: desktop.artifactPrefix + '-Setup-${version}-${arch}.${ext}',
      },
    },
  };
}

/** Signs (when MOPILOT_WIN_SIGN is set) and builds the installer. Returns the installer path; throws on failure. */
export async function packageWin(
  argv,
  {
    env = process.env,
    pkg = PKG,
    builder = build,
    exec = execFileSync,
    exists = existsSync,
    stat = statSync,
    log = console.log,
    warn = console.warn,
  } = {},
) {
  const arch = flagValue(argv, 'arch') || 'x64';
  const dir = path.join('out', `${desktop.name}-win32-${arch}`);
  const exe = path.join(dir, `${desktop.name}.exe`);
  const setup = path.join('out', `${desktop.artifactPrefix}-Setup-${pkg.version}-${arch}.exe`);
  if (!exists(exe))
    throw new Error(
      `${exe} not found: run \`npm run package:win:dir\` (or node scripts/package.mjs --platform win32 --arch ${arch}) first`,
    );

  const signer = env.MOPILOT_WIN_SIGN;
  const sign = (file) => {
    if (!signer) return;
    log(`Signing ${file}`);
    exec(signer, [file], { stdio: 'inherit' });
  };

  sign(exe);
  await builder(builderOptions(arch, dir));
  if (!exists(setup)) throw new Error(`electron-builder finished without ${setup}`);
  sign(setup);
  if (!signer) warn('MOPILOT_WIN_SIGN not set: the app and installer are unsigned.');
  log(`Installer: ${setup} (${(stat(setup).size / 1048576).toFixed(1)} MB)`);
  return setup;
}

/** packageWin(), with a failure printed instead of thrown. Returns the exit code. */
export async function main(argv, { error = console.error, ...deps } = {}) {
  try {
    await packageWin(argv, deps);
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageExit(await main(process.argv.slice(2)));
