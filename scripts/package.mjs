// Packages the built app into out/MoPilot-<platform>-<arch>/
//   node scripts/package.mjs [--arch arm64|x64]                    macOS: MoPilot.app (the default)
//   node scripts/package.mjs --platform win32 --arch x64           Windows: MoPilot.exe + resources
// The Windows folder is what scripts/package-win.mjs turns into the NSIS installer; it has no computer-use helper
// (macOS Swift), and is signed separately (see package-win.mjs). Windows and Linux ship the Rust sage-mcp
// (core/crates/sage-mcp) beside the core in resources/core, where macOS has the Swift one.
// macOS: builds the computer-use helper (native/helper) and sage-mcp (native/sage-mcp) for --arch into
// Contents/Helpers, and signs the whole bundle inside-out with osx-sign (scripts/signing.mjs gives each its
// own entitlements). A release helper's Info.plist carries the main app's designated requirement so it only
// accepts this app as its caller; a dev build signed with a local identity is marked MPCDevBuild instead
// (it then trusts the main pid and the per-launch token, as a dev checkout does).
// Signs and notarizes when the matching env vars are set (see .github/workflows/release.yml):
//   MOPILOT_SIGN_IDENTITY             "Developer ID Application: MoPilot … (TEAMID)"
//   MOPILOT_DEV_SIGN_IDENTITY         dev builds: a fixed identity (else the keychain's "MoPilot Code Dev",
//                                     Developer ID or Apple Development identity, else ad-hoc)
//   APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER   App Store Connect API key for notarytool
//   BUILD_NUMBER                      CFBundleVersion (CI run number)
//   MOPILOT_PROVISIONING_PROFILE      release: a Developer ID provisioning profile granting the WebAuthn keychain
//                                     group; embedded in the app, which then gets the group (Touch ID passkeys)
//   RELEASE_VERSION                   the release workflow's version (it stamps package.json with it first): the
//                                     app's package.json is marked a release build, the only kind that reports
//                                     install pings and usage data (electron/platform/install.cjs); any other is a local build
//   MOPILOT_SKIP_HOST_BUNDLE_CHECK=1  skip the Host archive check in afterPrune (scripts/host-bundle-check.mjs: the pruned app
//                                     must build the checkout's Host archive; about a second); for a package that must go out
//                                     while the check is wrong, never a way around a real mismatch
// Electron fuses (FUSES in scripts/check-fuses.mjs) are flipped on the copied Electron.app before packager
// signs it, then read back from the finished app. scripts/check-entitlements.mjs then checks macOS will launch it.
// A release is then notarized and stapled (scripts/notary.mjs).
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { flipFuses } from '@electron/fuses';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUSES, checkFuses, fusesFor } from './check-fuses.mjs';
import { rebuildLinuxPty } from './linux-pty.mjs';
import { checkEntitlements } from './check-entitlements.mjs';
import {
  ADDON,
  CORE_HASH_FILE,
  HOST_CORE_HASH_FILE,
  buildCore,
  checkLinuxCore,
  checkWindowsCore,
  recordCoreHash,
  recordHostCores,
} from './build-core.mjs';
import { buildHelper, MAIN_APP_PURPOSE_STRINGS, writeHelperDigest } from './build-helper.mjs';
import { buildSageMcp } from './build-sage-mcp.mjs';
import { buildAuthCommand } from './build-auth-command.mjs';
import { buildDisclaim } from './build-disclaim.mjs';
import { buildPasskeys } from './build-passkeys.mjs';
import { fetchRipgrep } from './fetch-vendor.mjs';
import { stripChromiumLocales } from './chromium-locales.mjs';
import { notarizeApp, sleepSync } from './notary.mjs';
import { SHIPPED, checkRuntimeDependencies, missingFromBuild } from './runtime-deps.mjs';
import {
  DESKTOP_IDENTITY as desktop,
  ENTITLEMENTS,
  mainSigningInfo,
  webAuthnSigning,
  nestedCodePaths,
  resolveIdentity,
  signHostCores,
  signOptionsForFile,
  isHostCore,
} from './signing.mjs';
import { flagValue } from './argv.mjs';
import { packageExit } from './package-exit.mjs';
import { checkHostBundle } from './host-bundle-check.mjs';
import { analyticsMode, verifyAnalyticsBundle } from './analytics-boundary.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * A build the release workflow ships: it set RELEASE_VERSION and stamped package.json with it (as npm version cleans
 * it). A RELEASE_VERSION package.json does not carry is refused: that release would never report.
 */
export function isReleaseBuild(env, pkg) {
  if (!env.RELEASE_VERSION) return false;
  if (env.RELEASE_VERSION.trim().replace(/^[=v]+/, '') === pkg.version) return true;
  throw new Error(`RELEASE_VERSION ${env.RELEASE_VERSION} is not package.json's version ${pkg.version}: run npm version first`);
}

/** Marks the staged app's package.json a release build (`mopilotBuild: "release"`, read by electron/platform/install.cjs). */
export function markReleaseBuild(appDir, fs = { readFileSync, writeFileSync }) {
  const file = path.join(appDir, 'package.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...json, mopilotBuild: 'release' }, null, 2)}\n`);
}

/**
 * Sets the staged app's package.json version, what app.getVersion() returns, back to `version`: packager writes its
 * appVersion there after the afterCopy and afterPrune hooks, and on Windows that is the numeric resource version.
 */
export function restoreAppVersion(appDir, version, fs = { readFileSync, writeFileSync }) {
  const file = path.join(appDir, 'package.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.version !== version) fs.writeFileSync(file, `${JSON.stringify({ ...json, version }, null, 2)}\n`);
}

const TOOLS = {
  packager,
  flipFuses,
  checkFuses,
  checkEntitlements,
  buildHelper,
  writeHelperDigest,
  buildSageMcp,
  buildAuthCommand,
  buildDisclaim,
  buildPasskeys,
  buildCore,
  checkWindowsCore,
  checkLinuxCore,
  rebuildLinuxPty,
  recordCoreHash,
  recordHostCores,
  signHostCores,
  fetchRipgrep,
  stripChromiumLocales,
  mainSigningInfo,
  webAuthnSigning,
  resolveIdentity,
  checkRuntimeDependencies,
  checkHostBundle,
  verifyAnalyticsBundle,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  chmodSync,
  notarizeApp,
  markReleaseBuild,
  restoreAppVersion,
  exec: execFileSync,
  sleep: sleepSync,
};

/**
 * Packages the app; dependencies replace tools, environment and output for focused tests.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, pkg?: any, hostArch?: string, hostPlatform?: string, log?: typeof console.log, warn?: typeof console.warn } & Record<string, any>} [options]
 */
export async function packageApp(
  argv,
  {
    env = process.env,
    pkg = PKG,
    hostArch = process.arch,
    hostPlatform = process.platform,
    log = console.log,
    warn = console.warn,
    ...deps
  } = {},
) {
  const {
    packager,
    flipFuses,
    checkFuses,
    checkEntitlements,
    buildHelper,
    writeHelperDigest: stampDigest,
    buildSageMcp,
    buildAuthCommand,
    buildDisclaim,
    buildPasskeys,
    buildCore,
    checkWindowsCore: checkCore,
    checkLinuxCore: checkLinux,
    rebuildLinuxPty,
    recordCoreHash: recordHash,
    recordHostCores: recordHosts,
    signHostCores: signHosts,
    fetchRipgrep,
    stripChromiumLocales: stripLocales,
    mainSigningInfo,
    webAuthnSigning,
    resolveIdentity,
    checkRuntimeDependencies,
    checkHostBundle,
    verifyAnalyticsBundle,
    existsSync,
    mkdtempSync,
    rmSync,
    mkdirSync,
    cpSync,
    chmodSync,
    notarizeApp,
    markReleaseBuild: markRelease,
    restoreAppVersion: restoreVersion,
    exec,
    sleep,
  } = { ...TOOLS, ...deps };
  const platform = flagValue(argv, 'platform') || hostPlatform;
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`Unsupported --platform ${platform} (darwin, win32 or linux)`);
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  if (linux && hostPlatform !== 'linux') throw new Error('Build Linux packages on a Linux machine or isolated Linux runner.');
  // checked before the long build: a release package.json was not stamped for is refused
  const releaseBuild = isReleaseBuild(env, pkg);
  const analytics = analyticsMode(env);
  verifyAnalyticsBundle(process.cwd(), analytics);
  const { identity, release } = mac ? resolveIdentity(env) : { identity: null, release: false };
  // notarized here after packaging, not by packager's osxNotarize, whose staple is never retried (scripts/notary.mjs)
  const notaryAuth =
    mac && release && env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
      ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
      : null;
  const arch = /** @type {any} */ (flagValue(argv, 'arch') || hostArch);
  const otherArch = arch === 'arm64' ? 'x64' : 'arm64';

  // The packages main loads must survive the prune below (scripts/runtime-deps.mjs): refused before a long build,
  // and checked again in the pruned app folder.
  const runtimeDeps = checkRuntimeDependencies(path.resolve('.'));

  // ripgrep 15.2.0 is fetched from its release page and checked against a pinned SHA-256
  // (scripts/fetch-vendor.mjs); it ships in Contents/Resources/ripgrep (resources/ripgrep on Windows),
  // where electron/platform/search.cjs looks first. The @vscode/ripgrep packages are not shipped.
  const rgDir = path.resolve('build', 'vendor', `${platform}-${arch}`, 'ripgrep');
  await fetchRipgrep({ platform, arch, out: rgDir });
  if (win && !existsSync(`node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`))
    throw new Error(`node-pty has no win32-${arch} prebuild`);
  // The Rust core's addon (scripts/build-core.mjs), in resources/core where electron/platform/core.cjs looks first.
  // macOS: built here, and osx-sign signs it with the app. Windows: the one the release built and signed (its core-win
  // job), when it is there, with its hash recorded in app.asar for the loader to check: Windows checks no signature when
  // a library loads (docs/architecture/rust-core.md §8). The app does not start without it. A hash left
  // by an earlier build never reaches another.
  const coreHashFile = path.resolve(CORE_HASH_FILE);
  rmSync(coreHashFile, { force: true });
  const hostCoreDir = path.resolve('build', 'vendor', 'host-core');
  const coreDir = path.resolve('build', 'vendor', `${platform}-${arch}`, 'core');
  if (mac) buildCore({ arch, out: coreDir });
  else if (linux) {
    // the release's Host build when there is one: it is held to the lowest glibc, and this machine's own build needs this
    // machine's, which would stop the app from starting on anything older
    buildCore({ platform, arch, out: coreDir, prebuilt: path.join(hostCoreDir, `linux-${arch}-gnu`, ADDON) });
    // sage-mcp beside it is the harnesses' tool bridge (core/crates/sage-mcp): the package has no other
    checkLinux(coreDir, existsSync);
    recordHash(path.join(coreDir, ADDON), coreHashFile);
  } else if (existsSync(path.join(coreDir, ADDON))) {
    checkCore(coreDir, existsSync);
    log(`Rust core ${recordHash(path.join(coreDir, ADDON), coreHashFile)}`);
  } else throw new Error(`The Windows ${arch} package needs the Rust core: none was built and signed in ${coreDir}.`);

  // The core for the machines a Host runs on (shared/host/coreBuild.mjs), in resources/host-core where
  // electron/host/bundle.cjs reads them, with their hashes in app.asar: nothing here loads them, but what the app sends a
  // machine runs there. The release's Host core jobs build them; a package without them installs Hosts without the core.
  // macOS: notarization refuses an unsigned Mach-O anywhere in the app, so the macOS builds are signed here, before their
  // hashes are taken, and osx-sign leaves the folder alone: it would change those bytes and try to sign the Linux files.
  const hostCoreHashFile = path.resolve(HOST_CORE_HASH_FILE);
  rmSync(hostCoreHashFile, { force: true });
  const hostCores = existsSync(hostCoreDir);
  if (hostCores) {
    if (mac) signHosts(hostCoreDir, { identity, release });
    log(`Host core builds ${Object.keys(recordHosts(hostCoreDir, hostCoreHashFile)).length}`);
  } else log(`The package carries no Host builds of the Rust core: none were built in ${hostCoreDir}.`);

  // macOS: the helper and sage-mcp are built unsigned here; osx-sign signs them with the app below.
  /** @type {string | null} */
  let nativeOut = null;
  /** @type {string | null} */
  let helperApp = null;
  /** @type {string | null} */
  let sageMcp = null;
  /** @type {string | null} */
  let authCommand = null;
  /** @type {string | null} */
  let disclaim = null;
  /** @type {string | null} */
  let passkeys = null;
  let appEntitlements = release ? ENTITLEMENTS.app : ENTITLEMENTS.dev;
  /** @type {string | null} */
  let webAuthnAccessGroup = null;
  /** @type {string | null} */
  let provisioningProfile = null;
  if (mac) {
    nativeOut = mkdtempSync(path.join(os.tmpdir(), 'mopilot-native-'));
    const signing = mainSigningInfo(identity);
    const peerRequirement = release ? env.MOPILOT_HELPER_PEER_REQUIREMENT || signing.designatedRequirement : undefined;
    ({ appEntitlements, webAuthnAccessGroup, provisioningProfile } = webAuthnSigning({
      teamId: signing.teamId,
      release,
      out: nativeOut,
      profile: env.MOPILOT_PROVISIONING_PROFILE,
    }));
    helperApp = buildHelper({ out: nativeOut, arch, sign: false, peerRequirement, devBuild: !release && identity !== '-' });
    sageMcp = buildSageMcp({ out: nativeOut, arch, sign: false });
    authCommand = buildAuthCommand({ out: nativeOut, arch, sign: false });
    disclaim = buildDisclaim({ out: nativeOut, arch, sign: false });
    passkeys = buildPasskeys({ out: nativeOut, arch, sign: false });
  }

  const executableName = linux ? desktop.linuxExecutable : desktop.name;
  const executable = (dir) => path.join(dir, mac ? `${desktop.name}.app` : win ? `${executableName}.exe` : executableName);
  const numericVersion = pkg.version.replace(/-.*$/, '');
  const paths = await packager({
    dir: '.',
    name: desktop.name,
    appBundleId: desktop.appId,
    // Windows version resources take one to four numbers, so a prerelease tag (0.4.0-dogfood.2) is left out
    // there: ProductVersion 0.4.0, FileVersion 0.4.0.<build>. Packager also writes appVersion into the app's
    // package.json, so beforeAsar below puts the full version back for app.getVersion().
    appVersion: win ? numericVersion : pkg.version,
    buildVersion: win ? [numericVersion, env.BUILD_NUMBER].filter(Boolean).join('.') : env.BUILD_NUMBER || pkg.version,
    appCopyright: `© ${new Date().getFullYear()} MoPilot`,
    arch,
    platform: /** @type {'darwin'|'win32'|'linux'} */ (platform),
    executableName,
    icon: win ? 'build/icon.ico' : mac ? 'build/icon.icns' : 'build/icon.png',
    // macOS: afterCopy runs on the staged Electron.app, before packager writes the asar integrity digest and
    // before osx-sign: flipping fuses rewrites the Electron Framework binary, so it must precede signing.
    // buildPath is <Electron.app>/Contents/Resources/app. (Windows flips them on the finished exe below.)
    // a release build is marked first, on both platforms (buildPath is the app folder, before it becomes the asar)
    afterCopy: [
      ...(releaseBuild ? [async ({ buildPath }) => markRelease(buildPath)] : []),
      ...(mac
        ? [
            async ({ buildPath }) => {
              await flipFuses(path.resolve(buildPath, '../../..'), { ...FUSES, resetAdHocDarwinSignature: true });
            },
            // the digest of the sources the helper above was built from: main compares it with what the helper reports (#4320)
            async ({ buildPath }) => {
              stampDigest(buildPath);
            },
            // Contents/Helpers, next to Contents/MacOS: where nested code belongs, and where main looks for it.
            async ({ buildPath }) => {
              const nested = nestedCodePaths(path.resolve(buildPath, '../../..'));
              mkdirSync(path.dirname(nested.helper), { recursive: true });
              // these hooks run only on macOS, where the native parts were built above
              cpSync(/** @type {string} */ (helperApp), nested.helper, { recursive: true, verbatimSymlinks: true });
              cpSync(/** @type {string} */ (sageMcp), nested.sageMcp);
              cpSync(/** @type {string} */ (authCommand), nested.authCommand);
              cpSync(/** @type {string} */ (disclaim), nested.disclaim);
              cpSync(/** @type {string} */ (passkeys), nested.passkeys);
            },
            // Electron's own licenses sit next to the app in the staging folder; they go inside it (signed with it) so
            // the DMG and the update zip hold the app alone and the licenses still ship with every copy.
            async ({ buildPath }) => {
              const stage = path.resolve(buildPath, '../../../..');
              const resources = path.resolve(buildPath, '..');
              for (const f of ['LICENSE', 'LICENSES.chromium.html']) cpSync(path.join(stage, f), path.join(resources, f));
            },
            // node-pty's npm tarball ships spawn-helper without its exec bit; the pty can't start without it.
            async ({ buildPath }) => {
              chmodSync(path.join(buildPath, `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`), 0o755);
            },
          ]
        : []),
      ...(linux ? [async ({ buildPath }) => rebuildLinuxPty({ buildPath, arch })] : []),
      // Chromium's locales for the interface languages only (scripts/chromium-locales.mjs), on every platform: about 36 MB
      // unpacked, before macOS signs the framework
      async ({ buildPath }) => {
        const { kept, removed } = stripLocales({ platform: /** @type {'darwin'|'win32'|'linux'} */ (platform), buildPath });
        log(`Chromium locales: ${kept} kept for the interface languages, ${removed} removed`);
      },
    ],
    afterPrune: [
      async ({ buildPath }) => {
        const missing = missingFromBuild(buildPath, runtimeDeps, existsSync);
        if (missing.length) throw new Error(`The pruned app is missing packages main loads: ${missing.join(', ')}`);
      },
      // the Host archive the app uploads is built from these files: it must be the checkout's (scripts/host-bundle-check.mjs,
      // about a second, both platforms); MOPILOT_SKIP_HOST_BUNDLE_CHECK=1 packages without it
      async ({ buildPath }) => {
        if (env.MOPILOT_SKIP_HOST_BUNDLE_CHECK === '1') return log('Host archive check skipped (MOPILOT_SKIP_HOST_BUNDLE_CHECK=1)');
        try {
          log(`Host archive ${checkHostBundle(buildPath)}`);
        } catch (e) {
          throw new Error(
            `${e.message} The Host install builds its archive from the packaged app: fix the packager's ignore list or prune in scripts/package.mjs, or set MOPILOT_SKIP_HOST_BUNDLE_CHECK=1 to package anyway.`,
          );
        }
      },
    ],
    // after packager wrote appVersion into the app's package.json, before that folder becomes app.asar
    beforeAsar: [async ({ buildPath }) => restoreVersion(buildPath, pkg.version)],
    out: 'out',
    overwrite: true,
    // Settings > About opens this from Contents/Resources (electron/support/notices.cjs); npm run third-party writes it.
    extraResource: ['build/THIRD_PARTY_NOTICES.md', rgDir, coreDir, ...(hostCores ? [hostCoreDir] : [])],
    // Native code can't load from inside app.asar: node-pty's pty.node and spawn-helper are unpacked to
    // app.asar.unpacked (node-pty looks there), and osx-sign signs them like any other Mach-O (and the
    // ripgrep in Resources). Windows unpacks all of node-pty (conpty.dll,
    // OpenConsole.exe, winpty-agent.exe and the conout worker script; electron/platform/pty.cjs loads it from there).
    asar: {
      unpack: mac ? '{**/*.node,**/node-pty/prebuilds/*/spawn-helper}' : '{**/*.node,**/node_modules/node-pty/**}',
    },
    prune: true,
    ignore: [
      ...(analytics === 'none' ? [/^\/electron\/private\/analytics(\/|$)/] : []),
      // The app.asar allowlist includes runtime files and project notices (scripts/runtime-deps.mjs).
      // Sources, scripts, tests, docs, Rust targets, bench, lint, mobile, relay and dot folders stay out.
      // The Rust addon ships separately in Resources/core.
      new RegExp(`^/(?!(?:${SHIPPED.map((e) => e.replaceAll('.', '\\.')).join('|')})(?:/|$))[^/]`),
      /\.map$/,
      // type declarations and zod's TypeScript sources (its @zod/source export) are never loaded
      /\.d\.[cm]?ts$/,
      /^\/node_modules\/zod\/src(\/|$)/,
      // The Agent SDK's bundled Claude Code binaries (~230 MB): MoPilot always runs the user's own `claude`.
      /^\/node_modules\/@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)/,
      // each platform's tray icon stays on its own platform
      win ? /^\/electron\/trayTemplate(@2x)?\.png$/ : /^\/electron\/tray\.ico$/,
      // node-pty: only this platform and arch's prebuild is needed (no sources to rebuild from); Windows
      // keeps its conpty/winpty files, debug symbols aside.
      linux
        ? /^\/node_modules\/node-pty\/prebuilds\//
        : win
          ? new RegExp(
              `^/node_modules/node-pty/(prebuilds/(darwin-.*|win32-(?!${arch}(/|$)).*)|third_party|deps|src|scripts|binding\\.gyp)(/|$)|^/node_modules/node-pty/prebuilds/.*\\.pdb$`,
            )
          : new RegExp(
              `^/node_modules/node-pty/(prebuilds/(win32-.*|darwin-${otherArch})|third_party|deps|src|scripts|binding\\.gyp)(/|$)`,
            ),
      // sodium-native (Mobile Remote): only this platform and arch's prebuild; the other platforms' and the phone ones are ~22 MB
      new RegExp(`^/node_modules/sodium-native/prebuilds/(?!${platform}-${arch}(/|$))`),
      ...(linux ? [] : [/^\/node_modules\/node-addon-api(\/|$)/]),
      // xlsx (MoMo's spreadsheets, electron/momo/xlsx.cjs) is loaded through require, which reads xlsx.js and its dist/cpexcel.js
      // only: the prebuilt browser bundles, the ES module copy, the worker and the CLI (~6.5 MB) stay out
      /^\/node_modules\/xlsx\/(dist\/(?!cpexcel\.js$)|bin(\/|$)|xlsx\.mjs$|xlsxworker\.js$|bower\.json$)/,
      // ripgrep ships from Resources (above), not from these packages
      /^\/node_modules\/@vscode\/ripgrep-/,
    ],
    ...(win
      ? {
          win32metadata: {
            CompanyName: 'MoPilot LLC',
            ProductName: desktop.name,
            FileDescription: desktop.name,
            OriginalFilename: `${desktop.name}.exe`,
            InternalName: desktop.name,
          },
        }
      : mac
        ? {
            // mopilot:// links (the Quick Actions' new-chat links, shared/deepLink.mjs) open this app
            protocols: [{ name: desktop.name, schemes: [desktop.scheme] }],
            extendInfo: {
              NSHighResolutionCapable: true,
              LSApplicationCategoryType: 'public.app-category.developer-tools',
              ...MAIN_APP_PURPOSE_STRINGS, // incl. the nested helper's: macOS reads them from this plist (#5340)
              ...(webAuthnAccessGroup && { MPCWebAuthnAccessGroup: webAuthnAccessGroup }),
            },
            osxSign: {
              // the macOS branch: resolveIdentity() gave an identity
              identity: /** @type {string} */ (identity),
              // '-' (ad-hoc) isn't in the keychain
              identityValidation: identity !== '-',
              // embedded as Contents/embedded.provisionprofile: what lets the main app claim the WebAuthn group
              ...(provisioningProfile && { provisioningProfile }),
              // Every Mach-O in the bundle gets the hardened runtime. Only the main app gets appEntitlements (with the
              // profile's WebAuthn group); other code, such as app.asar.unpacked's pty.node, spawn-helper, rg and
              // passkeys.node, gets the plain set, and the helper and sage-mcp get their own (signOptionsForFile).
              // dev builds skip Apple's timestamp server through optionsForFile (osx-sign reads it per file)
              optionsForFile: (filePath) => signOptionsForFile(filePath, { release, appEntitlements, adHoc: identity === '-' }),
              // the Host's builds: already signed above where they are Mach-O, and the rest are not this Mac's code
              ignore: isHostCore,
            },
          }
        : {}),
  });
  // packed into app.asar now; the working tree keeps no hash for another build
  rmSync(coreHashFile, { force: true });
  rmSync(hostCoreHashFile, { force: true });
  if (nativeOut) rmSync(nativeOut, { recursive: true, force: true });
  if (!mac) {
    // The exe is unsigned at this point, so the fuses are flipped on it directly (signing comes after).
    for (const dir of paths) {
      // Packager preserves its 0700 temporary root; a root-owned Linux install must remain traversable by its user.
      if (linux) chmodSync(dir, 0o755);
      await flipFuses(executable(dir), fusesFor(platform));
    }
    if (win) warn('Windows build is unsigned: sign MoPilot.exe, then build the installer (scripts/package-win.mjs).');
  } else if (!release)
    warn(`MOPILOT_SIGN_IDENTITY not set: dev build signed ${identity === '-' ? 'ad-hoc' : `with ${identity}`}; it cannot auto-update.`);
  log('Packaged:', paths.join(', '));
  for (const dir of paths) {
    if (linux) await checkFuses(executable(dir), { fuses: fusesFor(platform) });
    else await checkFuses(executable(dir));
    if (mac) checkEntitlements(executable(dir));
  }
  if (notaryAuth) for (const dir of paths) notarizeApp(path.join(dir, `${desktop.name}.app`), notaryAuth, { exec, log, sleep });
  return paths;
}

/** packageApp(), with a failure printed instead of thrown. Returns the exit code. */
export async function main(argv, { error = console.error, ...deps } = {}) {
  try {
    await packageApp(argv, deps);
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageExit(await main(process.argv.slice(2)));
