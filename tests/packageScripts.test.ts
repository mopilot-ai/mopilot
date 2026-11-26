// scripts/package.mjs with packager and the native builds,
// signing and fuses replaced: what each passes along, nothing is built or signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import edition from '../shared/edition.json' with { type: 'json' };
import { recorder, runScript } from './support/scripts-shared-cli.ts';
import { macOutput, pkg, tools } from './support/package-tools.ts';

const { hostFiles } = createRequire(import.meta.url)('../electron/host/bundle.cjs');
const pkgScript = await import('../scripts/package.mjs');
const { FUSES } = await import('../scripts/check-fuses.mjs');
const { ENTITLEMENTS } = await import('../scripts/signing.mjs');
const { desktop } = edition;
const macApp = `${desktop.name}.app`;
const windowsExe = `${desktop.name}.exe`;

test('package: an unsupported platform is refused before anything runs', async () => {
  const t = tools();
  const error = recorder();
  assert.equal(await pkgScript.main(['--platform', 'freebsd'], { ...t, error }), 1);
  assert.deepEqual(error.calls, [['Unsupported --platform freebsd (darwin, win32 or linux)']]);
  assert.equal(t.fetchRipgrep.calls.length, 0);
  const r = runScript('scripts/package.mjs', ['--platform', 'freebsd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unsupported --platform freebsd/);
});

test('package: a macOS dev build is ad-hoc signed with nested helpers, fuses flipped and checked', async () => {
  const t = tools();
  assert.equal(await pkgScript.main(['--arch', 'arm64'], { ...t, env: {}, pkg } as any), 0);
  assert.deepEqual(t.fetchRipgrep.calls[0], [
    { platform: 'darwin', arch: 'arm64', out: path.resolve('build/vendor/darwin-arm64/ripgrep') },
  ]);
  assert.deepEqual(t.buildHelper.calls[0], [{ out: '/native', arch: 'arm64', sign: false, peerRequirement: undefined, devBuild: false }]);
  // the pairing-by-code approval helper is not built or packaged unless the build asks for it (it ships when host.codePair is first turned on, #5576)
  assert.equal(t.buildCodePairApprove.calls.length, 0);
  for (const b of ['buildSageMcp', 'buildAuthCommand', 'buildDisclaim', 'buildUpdateInstall', 'buildPasskeys'])
    assert.deepEqual(t[b].calls[0], [{ out: '/native', arch: 'arm64', sign: false }]);
  const o = t.packager.calls[0][0];
  assert.deepEqual(
    [o.name, o.appVersion, o.buildVersion, o.platform, o.arch, o.icon],
    [desktop.name, '1.2.0', '1.2.0', 'darwin', 'arm64', 'build/icon.icns'],
  );
  assert.equal(o.appBundleId, desktop.appId);
  assert.deepEqual(o.protocols, [{ name: desktop.name, schemes: [desktop.scheme] }]);
  // the Rust core's addon, built for the arch and shipped in Resources/core, where electron/platform/core.cjs looks
  assert.deepEqual(t.buildCore.calls[0], [{ arch: 'arm64', out: path.resolve('build/vendor/darwin-arm64/core') }]);
  assert.deepEqual(o.extraResource, [
    'build/THIRD_PARTY_NOTICES.md',
    path.resolve('build/vendor/darwin-arm64/ripgrep'),
    path.resolve('build/vendor/darwin-arm64/core'),
    path.resolve('build/vendor/host-core'),
  ]);
  assert.equal(o.osxSign.identity, '-');
  assert.equal(o.osxSign.identityValidation, false);
  // dev builds skip the timestamp server per file (osx-sign ignores a global timestamp for nested code)
  assert.equal('timestamp' in o.osxSign, false);
  assert.equal(o.osxNotarize, undefined);
  assert.deepEqual(t.notarizeApp.calls, []);
  assert.deepEqual(o.osxSign.optionsForFile(`/${macApp}/Contents/MacOS/${desktop.name}`), {
    hardenedRuntime: true,
    entitlements: ENTITLEMENTS.dev,
    timestamp: 'none',
  });
  // an ad-hoc package pins the helper's designated requirement to its bundle identifier (TCC grants survive rebuilds)
  assert.equal(
    o.osxSign.optionsForFile('/A.app/Contents/Helpers/MoPilot.app').requirements,
    `=designated => identifier "${desktop.appId}.computer-use"`,
  );
  assert.ok(o.ignore.some((r: RegExp) => r.test('/electron/tray.ico')));
  // app.asar holds runtime files and source-edition notices. Rust build output, dev folders and dot folders stay out.
  const ignored = (p: string) => o.ignore.some((r: RegExp) => r.test(p));
  for (const p of [
    '/core',
    '/core/target/aarch64-apple-darwin/release/deps/libserde_core.rlib',
    '/bench/lib/x.mjs',
    '/lint/rules/x.mjs',
    '/mobile/App.tsx',
    '/relay/src/x.mjs',
    '/.agents/skills/x/SKILL.md',
    '/.local/state/gh/device-id',
    '/AGENTS.md',
    '/LICENSES.chromium.html',
    '/biome.json',
    '/package-lock.json',
    '/src/main.tsx',
    '/a-new-folder/x.js',
    '/node_modules/zod/src/index.ts',
    '/node_modules/zod/index.d.cts',
    '/shared/orchestration.d.ts',
  ])
    assert.ok(ignored(p), p);
  for (const p of [
    '/LICENSE',
    '/NOTICE',
    '/dist/index.html',
    '/dist/preview/pdf/cmaps/78-H.bcmap',
    '/electron/boot.cjs',
    '/host/src/continue.mjs',
    '/shared/harnessKind.mjs',
    '/package.json',
    '/node_modules/zod/index.cjs',
    '/node_modules/zod/v4/core/index.js',
  ])
    assert.ok(!ignored(p), p);
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/node-pty/prebuilds/darwin-x64/pty.node')));
  assert.ok(!o.ignore.some((r: RegExp) => r.test('/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')));
  // MoPilot's own skills plugin ships in app.asar, dot folder included (read in place, copied with plain reads)
  assert.ok(
    !o.ignore.some(
      (r: RegExp) =>
        r.test('/electron/plugins/builtin/mopilot/.claude-plugin/plugin.json') ||
        r.test('/electron/plugins/builtin/mopilot/skills/pdf-reading/SKILL.md'),
    ),
  );
  assert.equal(o.asar.unpack, '{**/*.node,**/node-pty/prebuilds/*/spawn-helper}');
  // sodium-native keeps only this platform and arch's prebuild
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/prebuilds/darwin-x64/sodium-native.node')));
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/prebuilds/ios-arm64/sodium-native.node')));
  assert.ok(!o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/prebuilds/darwin-arm64/sodium-native.node')));
  assert.ok(!o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/index.js')));

  // the afterCopy hooks run on the staged Electron.app
  const appPath = `/stage/${macApp}`;
  const buildPath = `${appPath}/Contents/Resources/app`;
  for (const hook of o.afterCopy) await hook({ buildPath });
  assert.deepEqual(t.flipFuses.calls[0], [appPath, { ...FUSES, resetAdHocDarwinSignature: true }]);
  assert.deepEqual(
    t.writeHelperDigest.calls,
    [[buildPath]],
    'the digest of the helper’s sources goes beside the app’s code, where main compares it (#4320)',
  );
  assert.deepEqual(t.mkdirSync.calls[0], [`${appPath}/Contents/Helpers`, { recursive: true }]);
  assert.deepEqual(
    t.cpSync.calls.map((c) => c.slice(0, 2)),
    [
      ['/native/helper.app', `${appPath}/Contents/Helpers/MoPilot.app`],
      ['/native/sage-mcp', `${appPath}/Contents/Helpers/sage-mcp`],
      ['/native/auth-command', `${appPath}/Contents/Helpers/auth-command`],
      ['/native/disclaim', `${appPath}/Contents/Helpers/disclaim`],
      ['/native/update-install', `${appPath}/Contents/Helpers/update-install`],
      ['/native/passkeys.node', `${appPath}/Contents/Helpers/passkeys.node`],
      // Electron's licenses go inside the app, so the DMG and the update zip hold the app alone
      ['/stage/LICENSE', `${appPath}/Contents/Resources/LICENSE`],
      ['/stage/LICENSES.chromium.html', `${appPath}/Contents/Resources/LICENSES.chromium.html`],
    ],
  );
  assert.deepEqual(t.chmodSync.calls[0], [`${buildPath}/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`, 0o755]);
  // the last step, before osx-sign signs the framework: Chromium's locales for the interface languages only
  assert.deepEqual(t.stripChromiumLocales.calls, [[{ platform: 'darwin', buildPath }]]);

  // a hash an earlier Windows build left is removed before packing and after; the native build folder after
  const hashFile = path.resolve('electron/platform/core-hash.json');
  const hostHashes = path.resolve('electron/host/host-core-hashes.json');
  assert.deepEqual(t.rmSync.calls, [
    [hashFile, { force: true }],
    [hostHashes, { force: true }],
    [hashFile, { force: true }],
    [hostHashes, { force: true }],
    ['/native', { recursive: true, force: true }],
  ]);
  assert.equal(t.recordCoreHash.calls.length, 0);
  assert.deepEqual(t.warn.calls, [['MOPILOT_SIGN_IDENTITY not set: dev build signed ad-hoc; it cannot auto-update.']]);
  assert.deepEqual(t.log.calls, [
    ['Host core builds 1'],
    ['Packaged:', macOutput],
    // from the afterCopy hooks this test ran after packaging
    ['Chromium locales: 60 kept for the interface languages, 160 removed'],
  ]);
  // the Host's builds: signed where they are this Mac's code, hashed after, shipped, and left alone by osx-sign
  const hostCores = path.resolve('build/vendor/host-core');
  assert.deepEqual(t.signHostCores.calls, [[hostCores, { identity: '-', release: false }]]);
  assert.deepEqual(t.recordHostCores.calls, [[hostCores, hostHashes]]);
  assert.ok(o.extraResource.includes(hostCores));
  assert.equal(o.osxSign.ignore('/a/x.app/Contents/Resources/host-core/darwin-x64/mopilot_core.node'), true);
  assert.deepEqual(t.checkFuses.calls, [[`${macOutput}/${macApp}`]]);
  assert.deepEqual(t.checkEntitlements.calls, [[`${macOutput}/${macApp}`]]);
  assert.equal('provisioningProfile' in o.osxSign, false);
});

test('package: a package main loads only as a devDependency is refused before the build, and the pruned app is checked', async () => {
  const devOnly = tools({
    checkRuntimeDependencies: () => {
      throw new Error('Move to "dependencies" in package.json; the packaged app prunes devDependencies: js-yaml');
    },
  });
  const error = recorder();
  assert.equal(await pkgScript.main(['--arch', 'arm64'], { ...devOnly, env: {}, pkg, error } as any), 1);
  assert.match(error.calls[0][0], /js-yaml/);
  assert.equal(devOnly.fetchRipgrep.calls.length, 0);
  assert.equal(devOnly.packager.calls.length, 0);

  // after the prune, every package main loads is still in the app folder
  const pruned = new Set(['/stage/app/node_modules/smol-toml/package.json']);
  const t = tools({ existsSync: recorder((file: string) => pruned.has(file)) });
  await pkgScript.packageApp(['--arch', 'arm64'], { ...t, env: {}, pkg });
  assert.deepEqual(t.checkRuntimeDependencies.calls, [[path.resolve('.')]]);
  const [hook] = t.packager.calls[0][0].afterPrune;
  await assert.rejects(hook({ buildPath: '/stage/app' }), /The pruned app is missing packages main loads: js-yaml/);
  pruned.add('/stage/app/node_modules/js-yaml/package.json');
  await hook({ buildPath: '/stage/app' });
});

test('package: the pruned app is checked to build the same Host archive, and the build reports its checksum', async () => {
  const t = tools();
  const log = recorder();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...t, env: {}, pkg, log });
  const hooks = t.packager.calls[0][0].afterPrune;
  assert.equal(hooks.length, 2);
  await hooks[1]({ buildPath: '/stage/app' });
  assert.deepEqual(t.checkHostBundle.calls, [['/stage/app']]);
  assert.ok(log.calls.some(([line]: string[]) => line === 'Host archive host-sha'));
  // a mismatch stops the build before the app is packed
  const broken = tools({
    checkHostBundle: () => {
      throw new Error('The packaged app would build a different Host archive: x is missing.');
    },
  });
  await pkgScript.packageApp(['--arch', 'arm64'], { ...broken, env: {}, pkg });
  await assert.rejects(
    broken.packager.calls[0][0].afterPrune[1]({ buildPath: '/stage/app' }),
    /different Host archive: x is missing\. .*ignore list or prune.*MOPILOT_SKIP_HOST_BUNDLE_CHECK=1/,
  );
  // the documented escape hatch packages without checking, and says so
  const skipped = tools();
  const skipLog = recorder();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...skipped, env: { MOPILOT_SKIP_HOST_BUNDLE_CHECK: '1' }, pkg, log: skipLog });
  await skipped.packager.calls[0][0].afterPrune[1]({ buildPath: '/stage/app' });
  assert.deepEqual(skipped.checkHostBundle.calls, []);
  assert.ok(skipLog.calls.some(([line]: string[]) => /check skipped/.test(line)));
  // Windows packages host/ too (POSIX-only at run time, but its files are in the archive): the hook is the same
  const winTools = tools();
  await pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...winTools, env: {}, pkg });
  await winTools.packager.calls[0][0].afterPrune[1]({ buildPath: '/stage/app' });
  assert.deepEqual(winTools.checkHostBundle.calls, [['/stage/app']]);
});

test('package: no file the Host archive reads is ignored by the packager or pruned as a devDependency', async () => {
  const lock = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package-lock.json'), 'utf8')).packages;
  const files: string[] = hostFiles(path.join(import.meta.dirname, '..'));
  assert.ok(files.length > 100);
  for (const platform of ['darwin', 'win32']) {
    const t = tools({ existsSync: () => true });
    await pkgScript.packageApp(['--platform', platform, '--arch', 'arm64'], { ...t, env: {}, pkg });
    const { ignore } = t.packager.calls[0][0];
    const dropped = files.filter((f) => ignore.some((r: RegExp) => r.test(`/${f}`)));
    assert.deepEqual(dropped, [], `${platform}: the packager drops files the Host archive needs`);
  }
  // npm marks a package only a devDependency reaches; the packager's prune removes exactly those
  const packages = new Set(files.flatMap((f) => (/^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(f) ?? []).slice(1)));
  assert.ok(packages.has('mdast-util-from-markdown'));
  const pruned = [...packages].filter((name) => lock[`node_modules/${name}`]?.dev);
  assert.deepEqual(pruned, [], 'the Host archive needs packages that only devDependencies bring in');
});

test('package: a dev identity marks the helper a dev build and validates the identity', async () => {
  const t = tools({ resolveIdentity: () => ({ identity: 'Apple Development: J', release: false }) });
  await pkgScript.packageApp([], { ...t, env: { BUILD_NUMBER: '7' }, pkg, hostArch: 'x64' });
  assert.equal(t.buildHelper.calls[0][0].devBuild, true);
  assert.equal(t.buildHelper.calls[0][0].arch, 'x64');
  const o = t.packager.calls[0][0];
  assert.equal(o.buildVersion, '7');
  assert.equal(o.osxSign.identityValidation, true);
  assert.equal('requirements' in o.osxSign.optionsForFile('/A.app/Contents/Helpers/MoPilot.app'), false);
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')));
  assert.equal(t.warn.calls[0][0], 'MOPILOT_SIGN_IDENTITY not set: dev build signed with Apple Development: J; it cannot auto-update.');
});

test('package: a release reads the designated requirement and notarizes with the API key', async () => {
  const t = tools({ resolveIdentity: () => ({ identity: 'Developer ID Application: M (AB12CD34EF)', release: true }) });
  const env = { APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' };
  await pkgScript.packageApp(['--arch', 'arm64'], { ...t, env, pkg });
  assert.deepEqual(t.mainSigningInfo.calls, [['Developer ID Application: M (AB12CD34EF)']]);
  assert.deepEqual(t.webAuthnSigning.calls, [[{ teamId: 'AB12CD34EF', release: true, out: '/native', profile: undefined }]]);
  assert.equal(t.buildHelper.calls[0][0].peerRequirement, 'designated');
  const o = t.packager.calls[0][0];
  // notarized after packaging with a retried staple (scripts/notary.mjs), not by packager's osxNotarize, whose
  // staple @electron/notarize never retries (releases 0.3.39 and 0.3.42)
  assert.equal(o.osxNotarize, undefined);
  assert.deepEqual(t.notarizeApp.calls, [
    [`${macOutput}/${macApp}`, ['--key', 'k', '--key-id', 'i', '--issuer', 's'], { exec: t.exec, log: t.log, sleep: t.sleep }],
  ]);
  assert.equal(o.osxSign.timestamp, undefined);
  assert.deepEqual(o.osxSign.optionsForFile(`/${macApp}/Contents/MacOS/${desktop.name}`), {
    hardenedRuntime: true,
    entitlements: ENTITLEMENTS.app,
  });
  assert.deepEqual(t.warn.calls, []);
  // a configured peer requirement wins, and an incomplete API key means no notarization
  const t2 = tools({ resolveIdentity: () => ({ identity: 'Developer ID Application: M (AB12CD34EF)', release: true }) });
  await pkgScript.packageApp([], { ...t2, env: { MOPILOT_HELPER_PEER_REQUIREMENT: 'peer', APPLE_API_KEY: 'k' }, pkg });
  assert.equal(t2.buildHelper.calls[0][0].peerRequirement, 'peer');
  assert.equal(t2.packager.calls[0][0].osxNotarize, undefined);
  assert.deepEqual(t2.notarizeApp.calls, []);
});

test('package: a provisioning profile embeds in the app and its WebAuthn group is advertised in Info.plist', async () => {
  const t = tools({
    resolveIdentity: () => ({ identity: 'Developer ID Application: M (AB12CD34EF)', release: true }),
    webAuthnSigning: recorder(() => ({
      appEntitlements: ENTITLEMENTS.app,
      webAuthnAccessGroup: 'AB12CD34EF.com.mopilot.webauthn',
      provisioningProfile: '/p/m.provisionprofile',
    })),
  });
  await pkgScript.packageApp(['--arch', 'arm64'], { ...t, env: { MOPILOT_PROVISIONING_PROFILE: '/p/m.provisionprofile' }, pkg });
  assert.equal(t.webAuthnSigning.calls[0][0].profile, '/p/m.provisionprofile');
  assert.equal(t.packager.calls[0][0].extendInfo.MPCWebAuthnAccessGroup, 'AB12CD34EF.com.mopilot.webauthn');
  assert.equal(t.packager.calls[0][0].osxSign.provisioningProfile, '/p/m.provisionprofile');
  const plain = tools();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...plain, env: {}, pkg });
  assert.equal('MPCWebAuthnAccessGroup' in plain.packager.calls[0][0].extendInfo, false);
});

test("package: the main app's Info.plist carries every purpose string of the helper nested in it (#5340)", async () => {
  const { HELPER_PURPOSE_STRINGS } = await import('../scripts/build-helper.mjs');
  const t = tools();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...t, env: {}, pkg });
  const info = t.packager.calls[0][0].extendInfo;
  assert.ok(Object.keys(HELPER_PURPOSE_STRINGS).includes('NSSpeechRecognitionUsageDescription'));
  for (const [key, text] of Object.entries(HELPER_PURPOSE_STRINGS)) assert.equal(info[key], text, key);
  // its own microphone string stays
  assert.match(info.NSMicrophoneUsageDescription, /microphone/);
});

test('package: Windows needs the conpty prebuild, skips native builds and flips fuses on the exe', async () => {
  const missing = tools({ existsSync: () => false });
  await assert.rejects(
    pkgScript.packageApp(['--platform', 'win32', '--arch', 'arm64'], { ...missing, env: {}, pkg }),
    /node-pty has no win32-arm64 prebuild/,
  );
  const t = tools({ packager: recorder(async () => ['/out/w']) });
  await pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...t, env: { BUILD_NUMBER: '9' }, pkg });
  assert.equal(t.resolveIdentity.calls.length, 0);
  assert.equal(t.buildHelper.calls.length, 0);
  // Windows ships the core the release built and signed, with its hash recorded in app.asar; nothing is built here
  const coreDir = path.resolve('build', 'vendor', 'win32-x64', 'core');
  const hashFile = path.resolve('electron/platform/core-hash.json');
  assert.equal(t.buildCore.calls.length, 0);
  assert.deepEqual(t.recordCoreHash.calls, [[path.join(coreDir, 'mopilot_core.node'), hashFile]]);
  assert.deepEqual(t.log.calls[0], ['Rust core abc123']);
  const hostHashes = path.resolve('electron/host/host-core-hashes.json');
  assert.deepEqual(t.rmSync.calls, [
    [hashFile, { force: true }],
    [hostHashes, { force: true }],
    [hashFile, { force: true }],
    [hostHashes, { force: true }],
  ]);
  assert.equal(t.signHostCores.calls.length, 0, 'a Windows package does not sign for Apple');
  assert.equal(t.recordHostCores.calls.length, 1);
  assert.deepEqual(t.existsSync.calls[0], ['node_modules/node-pty/prebuilds/win32-x64/conpty.node']);
  const o = t.packager.calls[0][0];
  assert.deepEqual([o.buildVersion, o.icon, o.afterCopy.length, o.osxSign], ['1.2.0.9', 'build/icon.ico', 1, undefined]);
  // Windows' one afterCopy step keeps Chromium's locales for the interface languages, beside MoPilot.exe
  await o.afterCopy[0]({ buildPath: '/w/resources/app' });
  assert.deepEqual(t.stripChromiumLocales.calls, [[{ platform: 'win32', buildPath: '/w/resources/app' }]]);
  assert.deepEqual(t.log.calls.at(-1), ['Chromium locales: 60 kept for the interface languages, 160 removed']);
  // the pruned-app check runs on Windows too
  await o.afterPrune[0]({ buildPath: '/w/resources/app' });
  assert.deepEqual(t.existsSync.calls.slice(-2), [
    [path.join('/w/resources/app', 'node_modules', 'js-yaml', 'package.json')],
    [path.join('/w/resources/app', 'node_modules', 'smol-toml', 'package.json')],
  ]);
  assert.equal(o.win32metadata.OriginalFilename, windowsExe);
  assert.ok(o.ignore.some((r: RegExp) => r.test('/electron/trayTemplate@2x.png')));
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/node-pty/prebuilds/win32-arm64/conpty.node')));
  assert.ok(!o.ignore.some((r: RegExp) => r.test('/node_modules/node-pty/prebuilds/win32-x64/conpty.node')));
  assert.ok(!o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/prebuilds/win32-x64/sodium-native.node')));
  assert.ok(o.ignore.some((r: RegExp) => r.test('/node_modules/sodium-native/prebuilds/darwin-arm64/sodium-native.node')));
  assert.equal(o.asar.unpack, '{**/*.node,**/node_modules/node-pty/**}');
  assert.ok(o.extraResource.includes(coreDir));
  assert.deepEqual(t.flipFuses.calls, [[`/out/w/${windowsExe}`, FUSES]]);
  // none built and signed: no package, since the app does not start without it
  const bare = tools({ packager: recorder(async () => ['/out/w']), existsSync: recorder((f: string) => !f.endsWith('mopilot_core.node')) });
  await assert.rejects(
    pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...bare, env: {}, pkg }),
    /^Error: The Windows x64 package needs the Rust core: none was built and signed in /,
  );
  assert.equal(bare.packager.calls.length, 0);
  assert.match(t.warn.calls[0][0], /^Windows build is unsigned/);
  assert.deepEqual(t.checkFuses.calls, [[`/out/w/${windowsExe}`]]);
  assert.deepEqual(t.checkEntitlements.calls, []);
  const t2 = tools({ packager: recorder(async () => ['/out/w']) });
  await pkgScript.packageApp(['--platform', 'win32'], { ...t2, env: {}, pkg, hostArch: 'x64' });
  assert.equal(t2.packager.calls[0][0].buildVersion, '1.2.0');
  // a prerelease keeps its tag in package.json; Windows' version resources take only numbers
  const t3 = tools({ packager: recorder(async () => ['/out/w']) });
  await pkgScript.packageApp(['--platform', 'win32'], {
    ...t3,
    env: { BUILD_NUMBER: '4' },
    pkg: { ...pkg, version: '0.3.1-dogfood.1' },
    hostArch: 'x64',
  });
  const pre = t3.packager.calls[0][0];
  assert.deepEqual([pre.appVersion, pre.buildVersion], ['0.3.1', '0.3.1.4']);
  // macOS keeps the full version
  const t4 = tools();
  await pkgScript.packageApp([], { ...t4, env: { BUILD_NUMBER: '4' }, pkg: { ...pkg, version: '0.3.1-dogfood.1' }, hostArch: 'x64' });
  assert.deepEqual([t4.packager.calls[0][0].appVersion, t4.packager.calls[0][0].buildVersion], ['0.3.1-dogfood.1', '4']);
});

test('package: only a release workflow build is marked a release build, on both platforms', async () => {
  const marked = (o: any) => o.afterCopy.length;
  const mac = tools();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...mac, env: {}, pkg });
  const macRelease = tools();
  await pkgScript.packageApp(['--arch', 'arm64'], { ...macRelease, env: { RELEASE_VERSION: '1.2.0' }, pkg });
  assert.equal(marked(macRelease.packager.calls[0][0]), marked(mac.packager.calls[0][0]) + 1);
  await macRelease.packager.calls[0][0].afterCopy[0]({ buildPath: '/stage/app' });
  assert.deepEqual(macRelease.markReleaseBuild.calls, [['/stage/app']], 'marked first, on the staged app folder');

  const winRelease = tools({ packager: recorder(async () => ['/out/w']) });
  await pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...winRelease, env: { RELEASE_VERSION: 'v1.2.0' }, pkg });
  const win = tools({ packager: recorder(async () => ['/out/w']) });
  await pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...win, env: {}, pkg });
  assert.equal(marked(winRelease.packager.calls[0][0]), marked(win.packager.calls[0][0]) + 1, 'npm version drops a leading v');
  const stale = tools({ packager: recorder(async () => ['/out/w']) });
  await assert.rejects(
    pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...stale, env: { RELEASE_VERSION: '1.3.0' }, pkg }),
    /RELEASE_VERSION 1\.3\.0 is not package\.json's version 1\.2\.0/,
    'a release package.json was not stamped for would never report',
  );

  const app = mkdtempSync(path.join(tmpdir(), 'mark-release-'));
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'mopilot', version: '1.2.0' }));
  pkgScript.markReleaseBuild(app);
  assert.deepEqual(JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')), {
    name: 'mopilot',
    version: '1.2.0',
    mopilotBuild: 'release',
  });
  rmSync(app, { recursive: true, force: true });
});

/** @electron/packager's order on the staged app folder: afterCopy, afterPrune, writeAppVersion, then beforeAsar. */
function stagingPackager(app: string, sourceVersion: string) {
  return recorder(async (o: any) => {
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'mopilot', version: sourceVersion }));
    for (const hook of o.afterCopy) await hook({ buildPath: app });
    for (const hook of o.afterPrune) await hook({ buildPath: app });
    const json = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ ...json, version: o.appVersion }, null, 2));
    for (const hook of o.beforeAsar ?? []) await hook({ buildPath: app });
    return ['/out/w'];
  });
}
const staged = (app: string) => JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));

test('package: a Windows prerelease app reports its full version, though the exe resources stay numeric', async () => {
  const app = mkdtempSync(path.join(tmpdir(), 'app-version-'));
  try {
    const version = '0.4.5-dogfood.2';
    const t = tools({ packager: stagingPackager(app, version), markReleaseBuild: pkgScript.markReleaseBuild });
    const env = { RELEASE_VERSION: version, BUILD_NUMBER: '7' };
    await pkgScript.packageApp(['--platform', 'win32', '--arch', 'x64'], { ...t, env, pkg: { ...pkg, version } });
    const o = t.packager.calls[0][0];
    assert.deepEqual([o.appVersion, o.buildVersion], ['0.4.5', '0.4.5.7'], 'ProductVersion and FileVersion');
    assert.deepEqual(staged(app), { name: 'mopilot', version: '0.4.5-dogfood.2', mopilotBuild: 'release' });

    // macOS, and a stable Windows build, already match: package.json is left as packager wrote it
    for (const argv of [
      ['--arch', 'arm64'],
      ['--platform', 'win32', '--arch', 'x64'],
    ]) {
      const plain = tools({ packager: stagingPackager(app, '0.4.5') });
      await pkgScript.packageApp(argv, { ...plain, env: {}, pkg: { ...pkg, version: '0.4.5' } });
      assert.deepEqual(staged(app), { name: 'mopilot', version: '0.4.5' });
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('package: restoreAppVersion rewrites only a version that differs', () => {
  const writes: string[] = [];
  const fs: any = {
    readFileSync: () => JSON.stringify({ name: 'm', version: '0.4.5' }),
    writeFileSync: (_f: string, t: string) => writes.push(t),
  };
  pkgScript.restoreAppVersion('/a', '0.4.5', fs);
  assert.deepEqual(writes, []);
  pkgScript.restoreAppVersion('/a', '0.4.5-beta.1', fs);
  assert.deepEqual(JSON.parse(writes[0]), { name: 'm', version: '0.4.5-beta.1' });
});
