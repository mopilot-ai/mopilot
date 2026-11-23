// Reads the Electron fuses of a packaged app and fails if any differs from FUSES.
//   node scripts/check-fuses.mjs [path/to/MoPilot.app]   (default: out/<productName>-darwin-<arch>/<productName>.app)
// scripts/package.mjs flips FUSES and runs this check on its output.
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FUSES = {
  version: FuseVersion.V1,
  // ELECTRON_RUN_AS_NODE=1 would turn the signed binary into a plain node that runs any script as the app.
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // packager records the app.asar hash in Info.plist (ElectronAsarIntegrity) and embeds its digest.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // Cookies are encrypted with the keychain's "MoPilot Code Safe Storage" key. Plaintext cookies survive
  // turning it on, and the pre-rebrand app's are carried over by electron/migrations/2026-10-cookies.cjs.
  // It is one-way: a build without the fuse (a downgrade, an unfused dev build on the same profile)
  // reads encrypted cookies back as empty.
  [FuseV1Options.EnableCookieEncryption]: true,
};

/** Linux has no embedded ASAR integrity implementation; keep every other required fuse enforced. */
export const fusesFor = (platform) =>
  platform === 'linux' ? { ...FUSES, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false } : FUSES;

export async function checkFuses(appPath, { readWire = getCurrentFuseWire, log = console.log, fuses = FUSES } = {}) {
  const wire = await readWire(appPath);
  const wrong = [];
  for (const [key, want] of Object.entries(fuses)) {
    if (key === 'version') continue;
    const have = wire[key];
    if (have !== (want ? FuseState.ENABLE : FuseState.DISABLE))
      wrong.push(
        `${FuseV1Options[key]}: want ${want ? 'on' : 'off'}, got ${have === FuseState.ENABLE ? 'on' : have === FuseState.DISABLE ? 'off' : 'missing'}`,
      );
  }
  if (wrong.length) throw new Error(`Electron fuses are wrong in ${appPath}:\n  ${wrong.join('\n  ')}`);
  log('Fuses OK:', appPath);
}

/** The command line: checks the given app (or this arch's default package). Returns the exit code. */
export async function main(argv, { check = checkFuses, arch = process.arch, error = console.error } = {}) {
  const { productName } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = argv[0] || `out/${productName}-darwin-${arch}/${productName}.app`;
  try {
    await check(app);
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
