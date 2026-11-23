// Only the main app may claim a restricted entitlement: the provisioning profile that grants one is embedded in the main
// app alone, and macOS refuses to load nested code claiming one (scripts/check-entitlements.mjs fails the release).
// 0.4.7-dogfood.5 failed both macOS builds when passkeys.node, new in Contents/Helpers, was signed with the profiled app's
// keychain group. Every nested code path the package builds is signed here as a profiled release signs it, so a new one
// is checked when it is added to nestedCodePaths, before a release finds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADDON } from '../scripts/build-core.mjs';
import { restrictedKeys } from '../scripts/check-entitlements.mjs';
import { ENTITLEMENTS, nestedCodePaths, signOptionsForFile, webAuthnSigning } from '../scripts/signing.mjs';

const APP = '/out/MoPilot-darwin-arm64/MoPilot.app';

/** The restricted keys a profiled release signs `file` with. */
function restrictedFor(file: string, appEntitlements: string) {
  const { entitlements } = signOptionsForFile(file, { release: true, appEntitlements });
  return restrictedKeys(readFileSync(entitlements, 'utf8'));
}

test('a profiled release gives restricted entitlements to the main app only, never to nested code', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'mopilot-entitlements-'));
  try {
    const { appEntitlements } = webAuthnSigning({ teamId: 'AB12CD34EF', release: true, out, profile: 'profile.provisionprofile' });
    // the profiled app's own entitlements hold the keychain group, so a nested file signed with them is caught below
    for (const main of [APP, `${APP}/Contents/MacOS/MoPilot`])
      assert.deepEqual(restrictedFor(main, appEntitlements), ['keychain-access-groups'], main);
    const helper = nestedCodePaths(APP).helper;
    const nested = [
      ...Object.values(nestedCodePaths(APP)),
      `${helper}/Contents/MacOS/ComputerUseHelper`,
      `${APP}/Contents/Resources/core/${ADDON}`,
      `${APP}/Contents/Resources/ripgrep/rg`,
      `${APP}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`,
      `${APP}/Contents/Frameworks/Electron Framework.framework`,
      `${APP}/Contents/Frameworks/MoPilot Helper (Renderer).app`,
      `${APP}/Contents/Frameworks/MoPilot Helper (Renderer).app/Contents/MacOS/MoPilot Helper (Renderer)`,
      // code nobody has added yet gets the plain set by default, wherever it lands
      `${APP}/Contents/Helpers/a-future-tool`,
      `${APP}/Contents/MacOS/a-future-launcher`,
      `${APP}/Contents/PlugIns/a-future.appex`,
      `${APP}/Contents/Library/LoginItems/a-future.app`,
    ];
    for (const file of nested) assert.deepEqual(restrictedFor(file, appEntitlements), [], file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('no checked-in entitlements file claims a restricted entitlement: only the profile-backed app plist may', () => {
  for (const file of Object.values(ENTITLEMENTS)) assert.deepEqual(restrictedKeys(readFileSync(file, 'utf8')), [], file);
});
