// Signing for scripts/package.mjs: which identity signs, which entitlements each nested piece of code
// gets, and the main app's designated requirement the computer-use helper checks its caller against.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADHOC_REQUIREMENT, HELPER_NAME } from './build-helper.mjs';
import { SAGE_MCP_IDENTIFIER } from './build-sage-mcp.mjs';
import { AUTH_COMMAND_IDENTIFIER } from './build-auth-command.mjs';
import { CODE_PAIR_APPROVE_IDENTIFIER } from './build-code-pair-approve.mjs';
import { DISCLAIM_IDENTIFIER } from './build-disclaim.mjs';
import { UPDATE_INSTALL_IDENTIFIER } from './build-update-install.mjs';
import { CORE_BUILDS, HOST_CORE_ADDON } from '../shared/host/coreBuild.mjs';
import edition from '../shared/edition.json' with { type: 'json' };

export const DESKTOP_IDENTITY = edition.desktop;
export const APP_BUNDLE_ID = DESKTOP_IDENTITY.appId;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTITLEMENTS = {
  app: path.join(root, 'build/entitlements.mac.plist'),
  dev: path.join(root, 'build/entitlements.dev.plist'),
  helper: path.join(root, 'build/entitlements.helper.plist'),
  sageMcp: path.join(root, 'build/entitlements.sage-mcp.plist'),
  authCommand: path.join(root, 'build/entitlements.auth-command.plist'),
  codePairApprove: path.join(root, 'build/entitlements.code-pair-approve.plist'),
  disclaim: path.join(root, 'build/entitlements.disclaim.plist'),
  updateInstall: path.join(root, 'build/entitlements.update-install.plist'),
};

/**
 * Picks a fixed signing identity for a dev build from `security find-identity -v -p codesigning`
 * output, so the cdhash-independent requirement (and the helper's TCC grants) survive rebuilds.
 * Prefers a "MoPilot Code Dev" certificate, then Developer ID, then Apple Development. Null: ad-hoc.
 */
export function pickDevIdentity(findIdentityOutput) {
  const found = [...String(findIdentityOutput).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({
    hash: m[1],
    name: m[2],
  }));
  for (const want of [/^MoPilot Code Dev\b/, /^MoPilot Dev\b/, /^Developer ID Application:/, /^Apple Development:/]) {
    const hit = found.find((i) => want.test(i.name));
    if (hit) return hit;
  }
  return null;
}

/** `security find-identity` output listing the keychain's valid code-signing identities. */
export function findCodesigningIdentities(exec = execFileSync) {
  return exec('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
}

/**
 * The identity that signs the package: MOPILOT_SIGN_IDENTITY for a release, MOPILOT_DEV_SIGN_IDENTITY or
 * a fixed identity from the keychain for a dev build, otherwise '-' (ad-hoc).
 */
export function resolveIdentity(env = process.env, findIdentities = findCodesigningIdentities) {
  if (env.MOPILOT_SIGN_IDENTITY) return { identity: env.MOPILOT_SIGN_IDENTITY, release: true };
  if (env.MOPILOT_DEV_SIGN_IDENTITY) return { identity: env.MOPILOT_DEV_SIGN_IDENTITY, release: false };
  let out = '';
  try {
    out = findIdentities();
  } catch (error) {
    // no keychain or security tool: fall back to ad-hoc signing, and say why
    console.warn(`signing: could not list code-signing identities, signing ad hoc (${error?.message ?? error})`);
  }
  const picked = pickDevIdentity(out);
  return { identity: picked ? picked.hash : '-', release: false };
}

/** The `designated => …` line of `codesign -d -r-`; undefined when there is none or it pins a cdhash (ad-hoc). */
export function parseDesignated(output) {
  const req = /^designated => (.+)$/m.exec(String(output))?.[1]?.trim();
  return req && !/^cdhash\b/.test(req) ? req : undefined;
}

/**
 * The designated requirement MoPilot.app will have once `identity` signs it, read from a scratch
 * binary signed with the same identity and identifier. The helper is sealed inside the main app, so it
 * can't be read from the app itself. Also reads the Apple team for WebAuthn entitlements; empty for ad-hoc.
 */
export function mainSigningInfo(identity, { exec = execFileSync, spawn = spawnSync } = {}) {
  if (!identity || identity === '-') return {};
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mopilot-dr-'));
  try {
    const probe = path.join(dir, 'probe');
    copyFileSync('/usr/bin/true', probe);
    exec('codesign', ['--force', '--sign', identity, '--identifier', APP_BUNDLE_ID, '--timestamp=none', probe], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const result = spawn('codesign', ['-d', '-r-', '--verbose=4', probe], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw result.error || new Error('Could not inspect the signing identity.');
    const output = `${result.stdout}\n${result.stderr}`;
    const teamId = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(output)?.[1];
    return { designatedRequirement: parseDesignated(output), teamId };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The WebAuthn keychain group, only for a release signed with a provisioning profile that grants it.
 * keychain-access-groups is a restricted entitlement: macOS kills an app that claims it without an embedded
 * profile at launch (SIGKILL, before any of its code runs), which is how 0.3.1 to 0.3.7 shipped. A Team ID
 * alone does not authorize it. Without a profile the app signs without the group and electron/capabilities/
 * browser/auth.cjs leaves Touch ID passkeys off.
 * @param {{ teamId?: string, release: boolean, out: string, profile?: string }} o
 */
export function webAuthnSigning({ teamId, release, out, profile }) {
  const base = release ? ENTITLEMENTS.app : ENTITLEMENTS.dev;
  if (!release || !teamId || !profile) return { appEntitlements: base, webAuthnAccessGroup: null, provisioningProfile: null };
  const webAuthnAccessGroup = `${teamId}.${APP_BUNDLE_ID}.webauthn`;
  const plist = readFileSync(base, 'utf8').replace(
    '</dict>',
    `  <key>keychain-access-groups</key>\n  <array><string>${webAuthnAccessGroup}</string></array>\n</dict>`,
  );
  const appEntitlements = path.join(out, 'entitlements.mac.plist');
  writeFileSync(appEntitlements, plist);
  return { appEntitlements, webAuthnAccessGroup, provisioningProfile: profile };
}

/**
 * Whether `filePath` is the main app itself: its bundle, or its main executable (Contents/MacOS/<bundle name>, the one
 * file scripts/check-entitlements.mjs lets claim a profiled entitlement). Nested code (Electron's helper apps and
 * frameworks, Contents/Helpers, the Mach-Os in Resources, any other file in Contents/MacOS) is everything else.
 */
export function isMainApp(filePath) {
  const file = filePath.replace(/\/+$/, '');
  const at = file.indexOf('.app/Contents/');
  if (at === -1) return file.endsWith('.app');
  return file.slice(at + '.app/Contents/'.length) === `MacOS/${path.basename(file.slice(0, at))}`;
}

/**
 * Native helpers keep their own entitlements. Only the main app (isMainApp) gets `appEntitlements` (release,
 * local dev, or release with the WebAuthn group); every other Mach-O, wherever it sits (Electron's helper apps,
 * frameworks, Resources, an addon in Contents/Helpers such as passkeys.node), gets the plain release or dev ones.
 * The profile that grants a restricted entitlement is embedded in the main app only, and macOS refuses to load
 * nested code claiming one (scripts/check-entitlements.mjs fails the release on it, as 0.4.7-dogfood.5 did).
 * Dev builds skip Apple's timestamp server (`timestamp: 'none'`): osx-sign reads the timestamp per
 * file only, so a global option has no effect, and a local build shouldn't fail when that server is down.
 * An ad-hoc package (`adHoc`) pins the computer-use helper's designated requirement to its bundle identifier, as
 * scripts/build-helper.mjs does, so its TCC grants survive a rebuild instead of following the code hash.
 */
export function signOptionsForFile(
  filePath,
  { release = true, appEntitlements = release ? ENTITLEMENTS.app : ENTITLEMENTS.dev, adHoc = false } = {},
) {
  const base = release ? ENTITLEMENTS.app : ENTITLEMENTS.dev;
  const options = fileSignOptions(filePath, isMainApp(filePath) ? appEntitlements : base, adHoc);
  return release ? options : { ...options, timestamp: 'none' };
}

/** Whether `file` is one of the Host's builds of the core, in the app's Resources/host-core. @param {string} file */
export const isHostCore = (file) => file.includes('/Contents/Resources/host-core/');

/**
 * Sign the macOS Host addons in `dir` with the app's identity and the hardened runtime, as notarization wants of any Mach-O in the app. They load on a machine by Node, which checks no signature: the machine's check is the signed manifest's hash. An ad-hoc build leaves them as cargo made them.
 * @param {string} dir @param {{ identity: string | null, release: boolean, exec?: typeof execFileSync }} o
 */
export function signHostCores(dir, { identity, release, exec = execFileSync }) {
  if (!identity || identity === '-') return;
  for (const build of CORE_BUILDS.filter((b) => b.startsWith('darwin-'))) {
    const addon = path.join(dir, build, HOST_CORE_ADDON);
    exec('codesign', ['--force', '--sign', identity, '--options', 'runtime', release ? '--timestamp' : '--timestamp=none', addon], {
      stdio: 'inherit',
    });
  }
}

function fileSignOptions(filePath, appEntitlements, adHoc) {
  if (filePath.includes(`/Contents/Helpers/${HELPER_NAME}.app`)) {
    return { hardenedRuntime: true, entitlements: ENTITLEMENTS.helper, ...(adHoc && { requirements: `=${ADHOC_REQUIREMENT}` }) };
  }
  if (filePath.endsWith('/Contents/Helpers/sage-mcp')) {
    return { hardenedRuntime: true, entitlements: ENTITLEMENTS.sageMcp, additionalArguments: ['--identifier', SAGE_MCP_IDENTIFIER] };
  }
  if (filePath.endsWith('/Contents/Helpers/auth-command')) {
    return {
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS.authCommand,
      additionalArguments: ['--identifier', AUTH_COMMAND_IDENTIFIER],
    };
  }
  if (filePath.endsWith('/Contents/Helpers/code-pair-approve')) {
    return {
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS.codePairApprove,
      additionalArguments: ['--identifier', CODE_PAIR_APPROVE_IDENTIFIER],
    };
  }
  if (filePath.endsWith('/Contents/Helpers/disclaim')) {
    return { hardenedRuntime: true, entitlements: ENTITLEMENTS.disclaim, additionalArguments: ['--identifier', DISCLAIM_IDENTIFIER] };
  }
  if (filePath.endsWith('/Contents/Helpers/update-install')) {
    return {
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS.updateInstall,
      additionalArguments: ['--identifier', UPDATE_INSTALL_IDENTIFIER],
    };
  }
  return { hardenedRuntime: true, entitlements: appEntitlements };
}

/**
 * Where the nested code built for Contents/Helpers sits in the packaged app (electron/capabilities/computer.cjs and
 * socket.cjs look there). tests/nestedCodeEntitlements.invariant.test.ts signs each entry as a profiled release does.
 */
export function nestedCodePaths(appPath) {
  const helpers = path.join(appPath, 'Contents/Helpers');
  return {
    helper: path.join(helpers, `${HELPER_NAME}.app`),
    sageMcp: path.join(helpers, 'sage-mcp'),
    authCommand: path.join(helpers, 'auth-command'),
    disclaim: path.join(helpers, 'disclaim'),
    updateInstall: path.join(helpers, 'update-install'),
    codePairApprove: path.join(helpers, 'code-pair-approve'),
    passkeys: path.join(helpers, 'passkeys.node'),
  };
}
