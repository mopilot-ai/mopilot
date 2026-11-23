// Builds native/helper into "MoPilot.app" (LSUIElement), the process that owns the
// Accessibility and Screen Recording grants for computer use.
//   node scripts/build-helper.mjs [--out <dir>] [--debug] [--arch arm64|x64]
// Output: native/helper/build/MoPilot.app unless --out is given.
// Signing: dev builds use the local "Apple Development" identity when the keychain has one, so macOS keeps the
// Screen Recording and Accessibility grants across rebuilds (a grant is tied to the signing identity, and an ad-hoc
// build gets a new cdhash every time). With no such identity the build is ad-hoc signed with an explicit designated
// requirement on the bundle identifier (see signArgs), so the grants still survive rebuilds of the same bundle.
// Set MOPILOT_HELPER_SIGN_IDENTITY=- to force ad-hoc.
// Release signing (WP8-4) sets:
//   MOPILOT_HELPER_SIGN_IDENTITY       "Developer ID Application: … (TEAMID)"; falls back to MOPILOT_SIGN_IDENTITY
//   MOPILOT_HELPER_PEER_REQUIREMENT    code requirement main must satisfy to connect; a team-signed helper
//                                      refuses to start without one. Defaults to MoPilot's identifier
//                                      under the same team when the identity names a team.
// scripts/package.mjs builds it unsigned (sign: false) with the main app's designated requirement and lets
// osx-sign sign it inside-out with the rest of MoPilot.app.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helperStamp from '../electron/capabilities/helperStamp.cjs';
import { swiftArchArgs, swiftProductCli } from './swift-product.mjs';

/**
 * The helper's name: its app folder (launch code, packaging and signing find it by this) and what macOS shows for it in
 * its privacy prompts and System Settings' lists. macOS names an app by its folder, whatever its Info.plist says, so the
 * two are one name here. Grants follow the bundle identifier and the signing requirement, not the name, so renaming it
 * keeps every grant (#2528).
 */
import edition from '../shared/edition.json' with { type: 'json' };

export const HELPER_NAME = 'MoPilot';
export const HELPER_BUNDLE_ID = `${edition.desktop.appId}.computer-use`;
const EXECUTABLE = 'ComputerUseHelper';
const ICON = 'icon.icns';

/**
 * The purpose strings of the privacy prompts the helper's process asks for. macOS reads them from the OUTERMOST app bundle
 * (a request from the helper nested in MoPilot.app aborts the helper, SIGABRT in TCC, when MoPilot.app's own Info.plist lacks
 * one: #5340), so the helper's Info.plist and the main app's both carry exactly this set (scripts/package.mjs extendInfo).
 */
export const HELPER_PURPOSE_STRINGS = Object.freeze({
  NSAppleEventsUsageDescription: 'MoPilot controls apps on your behalf when you allow it.',
  NSSpeechRecognitionUsageDescription: 'MoPilot turns your dictation into text on this Mac when you choose local dictation.',
  // MoMo's Calendar and Reminders sources read through EventKit (macOS 14 full-access keys and the older ones)
  NSCalendarsFullAccessUsageDescription: 'MoMo in MoPilot reads your calendars when you connect Calendar.',
  NSCalendarsUsageDescription: 'MoMo in MoPilot reads your calendars when you connect Calendar.',
  NSRemindersFullAccessUsageDescription: 'MoMo in MoPilot reads your reminders when you connect Reminders.',
  NSRemindersUsageDescription: 'MoMo in MoPilot reads your reminders when you connect Reminders.',
});

/** The purpose strings of the main app's Info.plist (scripts/package.mjs extendInfo): its own microphone one and the helper's. */
export const MAIN_APP_PURPOSE_STRINGS = Object.freeze({
  NSMicrophoneUsageDescription: 'MoPilot uses the microphone for dictation and voice conversations.',
  ...HELPER_PURPOSE_STRINGS,
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'native/helper');

/**
 * Info.plist contents for the helper bundle.
 * @param {{ version: string, build: string, peerRequirement?: string, devBuild?: boolean, sourceDigest?: string | null }} o
 */
export function helperInfo({ version, build, peerRequirement, devBuild = false, sourceDigest = null }) {
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleExecutable: EXECUTABLE,
    CFBundleIdentifier: HELPER_BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: HELPER_NAME,
    CFBundleDisplayName: HELPER_NAME,
    CFBundleIconFile: ICON,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: build,
    LSMinimumSystemVersion: '14.0',
    LSUIElement: true,
    NSHighResolutionCapable: true,
    NSPrincipalClass: 'NSApplication',
    ...HELPER_PURPOSE_STRINGS,
    NSHumanReadableCopyright: `© ${new Date().getFullYear()} MoPilot`,
    // the digest of the sources this binary is built from: its hello returns it and the app compares it with its own (#4320)
    ...(sourceDigest && { MPCSourceDigest: sourceDigest }),
    ...(peerRequirement && { MPCPeerRequirement: peerRequirement }),
    // A build signed with a local development certificate has a team id but no peer requirement; this marks it as a
    // dev build so the helper starts, trusting only the main pid and the per-launch token. It is part of the signed plist.
    ...(devBuild && !peerRequirement && { MPCDevBuild: true }),
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A flat XML plist (strings and booleans are all the helper needs). */
export function plist(obj) {
  const body = Object.entries(obj)
    .map(([k, v]) => `\t<key>${esc(k)}</key>\n\t${typeof v === 'boolean' ? `<${v}/>` : `<string>${esc(v)}</string>`}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/** First "Apple Development" identity in the keychain, for dev builds; '' when there is none. */
export function devIdentity(exec = execFileSync) {
  try {
    const out = exec('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return /"(Apple Development: [^"]+)"/.exec(out)?.[1] || '';
  } catch {
    return '';
  }
}

/**
 * The default peer requirement: MoPilot's main app from the same team. Only a Developer ID build has one; a dev
 * build is reached by the unsigned Electron binary, so it relies on the main pid and the per-launch token alone.
 */
export function defaultPeerRequirement(identity) {
  if (!/^Developer ID Application:/.test(identity || '')) return undefined;
  const team = /\(([A-Z0-9]{10})\)\s*$/.exec(identity)?.[1];
  return team ? `anchor apple generic and identifier "${edition.desktop.appId}" and certificate leaf[subject.OU] = "${team}"` : undefined;
}

/** The designated requirement of an ad-hoc helper: its bundle identifier instead of the default code hash. */
export const ADHOC_REQUIREMENT = `designated => identifier "${HELPER_BUNDLE_ID}"`;

/**
 * `codesign` arguments (before the bundle path) for the helper. Hardened runtime in every mode so dev behaves like
 * release. An ad-hoc signature (no identity) would otherwise get a designated requirement pinned to its code hash,
 * which changes on every rebuild and makes macOS TCC drop the Screen Recording, Accessibility and Input Monitoring
 * grants; pinning it to the bundle identifier keeps them. Trade-off, acceptable for dev builds only: any ad-hoc
 * binary with that identifier matches the grant. Identity-signed builds keep the certificate-based default.
 * @param {{ identity?: string, entitlements: string }} o
 */
export function signArgs({ identity, entitlements }) {
  const args = ['--force', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity || '-'];
  if (!identity) args.push('--requirements', `=${ADHOC_REQUIREMENT}`);
  if (/^Developer ID/.test(identity || '')) args.push('--timestamp');
  return args;
}

/** Writes the digest of the helper's sources beside a packaged app's code, where main reads what its helper must carry (#4320). */
export function writeHelperDigest(appDir) {
  writeFileSync(path.join(appDir, helperStamp.DIGEST_FILE), `${helperStamp.sourceDigest(root)}\n`);
}

/**
 * Why a helper bundle is not built from this tree's sources, or null when it is. An install or build step that finds a reason
 * leaves no bundle behind (an older helper in the place of a newer one drops clicks without an error, #4320).
 * @param {string} appDir @param {string} [tree] the repository root
 */
export function bundleProblem(appDir, tree = root) {
  const plistFile = path.join(appDir, 'Contents/Info.plist');
  if (!existsSync(plistFile)) return `${appDir} has no Info.plist`;
  const have = /<key>MPCSourceDigest<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(plistFile, 'utf8'))?.[1] ?? '';
  const want = helperStamp.sourceDigest(tree);
  if (!have) return `${appDir} carries no build stamp: it is from an older build`;
  return want && have !== want ? `${appDir} was built from other sources (${have}) than this tree (${want})` : null;
}

/** @param {{ out?: string, debug?: boolean, arch?: string, sign?: boolean, peerRequirement?: string, devBuild?: boolean, env?: NodeJS.ProcessEnv, log?: (...data: any[]) => void, exec?: typeof execFileSync, platform?: NodeJS.Platform }} [o] */
export function buildHelper({
  out = path.join(pkgDir, 'build'),
  debug = false,
  arch,
  sign = true,
  peerRequirement,
  devBuild,
  env = process.env,
  log = console.log,
  exec = execFileSync,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') throw new Error('the computer-use helper builds on macOS only');
  const config = debug ? 'debug' : 'release';
  const swiftArgs = ['-c', config, ...swiftArchArgs(arch)];
  log(`swift build ${swiftArgs.join(' ')}`);
  exec('swift', ['build', ...swiftArgs, '--product', EXECUTABLE], { cwd: pkgDir, stdio: ['ignore', 'inherit', 'inherit'] });
  const binDir = exec('swift', ['build', ...swiftArgs, '--show-bin-path'], { cwd: pkgDir, encoding: 'utf8' }).trim();

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  let identity = env.MOPILOT_HELPER_SIGN_IDENTITY || env.MOPILOT_SIGN_IDENTITY || (env === process.env ? devIdentity(exec) : '');
  if (identity === '-') identity = '';
  peerRequirement ??= env.MOPILOT_HELPER_PEER_REQUIREMENT || defaultPeerRequirement(identity);
  devBuild ??= !!identity && !/^Developer ID/.test(identity);

  const app = path.join(out, `${HELPER_NAME}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  const resources = path.join(app, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  copyFileSync(path.join(root, 'build', ICON), path.join(resources, ICON));
  const exe = path.join(app, 'Contents/MacOS', EXECUTABLE);
  copyFileSync(path.join(binDir, EXECUTABLE), exe);
  chmodSync(exe, 0o755);
  writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    plist(
      helperInfo({
        version: pkg.version,
        build: env.BUILD_NUMBER || pkg.version,
        peerRequirement,
        devBuild,
        sourceDigest: helperStamp.sourceDigest(root),
      }),
    ),
  );
  writeFileSync(path.join(app, 'Contents/PkgInfo'), 'APPL????');

  if (!sign) {
    log(`Built ${app} (unsigned)`);
    return app;
  }
  const entitlements = path.join(root, 'build/entitlements.helper.plist');
  exec('codesign', [...signArgs({ identity, entitlements }), app], { stdio: 'inherit' });
  exec('codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
  log(`Built ${app} (${identity ? `signed: ${identity}` : 'ad-hoc signed'})`);
  return app;
}

/** The command line (see the top of this file); --help prints the usage. */
export function cli(argv, { build = buildHelper, log = console.log } = {}) {
  swiftProductCli(argv, 'scripts/build-helper.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
