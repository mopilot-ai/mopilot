// Expo push configuration: identifiers from the environment, app.config.js, and the iOS Notification Service Extension plugin.
import edition from '../mobile/config/edition.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const { resolveIdentifiers } = require('./config/identifiers.js');
const appConfig = require('./app.config.js');
const files = require('./plugins/nseFiles.js');
const withoutPushEntitlement = require('./plugins/withoutPushEntitlement.js');
const plugin = require('./plugins/withNotificationServiceExtension.js');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const fixture = new URL('./fixtures/mobile/template.pbxproj', import.meta.url).pathname;

const ids = resolveIdentifiers({ MOPILOT_APPLE_TEAM_ID: 'TEAM123456' });

test('identifiers default to documented placeholders and every one can be overridden; blanks count as unset', () => {
  const d = resolveIdentifiers({});
  assert.deepEqual(d, {
    iosBundleId: edition.iosId,
    androidPackage: edition.androidId,
    appleTeamId: '',
    appGroup: `group.${edition.iosId}`,
    keychainGroup: `${edition.iosId}.shared`,
    keychainAccessGroup: undefined,
    extensionName: 'NotificationServiceExtension',
    extensionBundleId: `${edition.iosId}.notification-service`,
    widgetName: 'LiveActivityExtension',
    widgetBundleId: `${edition.iosId}.live-activity`,
    googleServicesFile: undefined,
    deviceBuild: false,
  });
  const o = resolveIdentifiers({
    MOPILOT_IOS_BUNDLE_ID: 'com.example.app',
    MOPILOT_ANDROID_PACKAGE: 'com.example.droid',
    MOPILOT_APPLE_TEAM_ID: 'ABCDE12345',
    MOPILOT_APP_GROUP: 'group.example',
    MOPILOT_KEYCHAIN_GROUP: 'com.example.keys',
    MOPILOT_GOOGLE_SERVICES_FILE: './g.json',
  });
  assert.equal(o.extensionBundleId, 'com.example.app.notification-service');
  assert.equal(o.widgetBundleId, 'com.example.app.live-activity');
  assert.equal(o.keychainAccessGroup, 'ABCDE12345.com.example.keys');
  assert.equal(o.appGroup, 'group.example');
  assert.equal(o.androidPackage, 'com.example.droid');
  assert.equal(o.googleServicesFile, './g.json');
  assert.equal(resolveIdentifiers({ MOPILOT_IOS_BUNDLE_ID: '  ' }).iosBundleId, edition.iosId);
});

test('iOS and Android defaults are independent: a new iOS id moves neither the Android package nor the other way round', () => {
  const ios = resolveIdentifiers({ MOPILOT_IOS_BUNDLE_ID: 'com.example.app' });
  assert.equal(ios.androidPackage, edition.androidId);
  assert.equal(ios.appGroup, 'group.com.example.app');
  const android = resolveIdentifiers({ MOPILOT_ANDROID_PACKAGE: 'com.example.droid' });
  assert.equal(android.iosBundleId, edition.iosId);
  assert.equal(android.extensionBundleId, `${edition.iosId}.notification-service`);
});

test('app.config.js adds the notification permission, plugins and identifiers without dropping app.json settings', () => {
  const saved = { ...process.env };
  try {
    delete process.env.MOPILOT_GOOGLE_SERVICES_FILE;
    process.env.MOPILOT_APPLE_TEAM_ID = 'TEAM123456';
    process.env.MOPILOT_BUILD_COMMIT = 'abc1234def';
    const base = { name: 'x', ios: { bundleIdentifier: 'old' }, android: { package: 'old' }, plugins: ['expo-sqlite'], extra: { keep: 1 } };
    const out = appConfig({ config: base });
    assert.equal(out.ios.bundleIdentifier, edition.iosId);
    assert.deepEqual(out.android.permissions, ['POST_NOTIFICATIONS']);
    assert.equal('googleServicesFile' in out.android, false);
    assert.deepEqual(out.extra, {
      keep: 1,
      push: { keychainAccessGroup: `TEAM123456.${edition.iosId}.shared` },
      buildCommit: 'abc1234def',
      inPlaceSelection: true,
    });
    assert.equal(out.plugins[0][0], './plugins/withReleaseHardening');
    assert.equal(out.plugins[1], 'expo-sqlite');
    assert.deepEqual(out.plugins[2], [
      'expo-notifications',
      { mode: 'production', defaultChannel: 'system', icon: './assets/notification-icon.png', color: '#ef8b57' },
    ]);
    assert.ok(out.plugins.includes('expo-task-manager'));
    assert.equal(out.plugins.at(-2)[0], './plugins/withNotificationServiceExtension');
    assert.equal(out.plugins.at(-1)[0], './plugins/withLiveActivity');
    assert.equal(out.plugins.at(-1)[1].widgetBundleId, `${edition.iosId}.live-activity`);
    process.env.MOPILOT_GOOGLE_SERVICES_FILE = './google-services.json';
    assert.equal(appConfig({ config: {} }).android.googleServicesFile, './google-services.json');
    assert.equal(appConfig({ config: {} }).plugins.length, 5);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('a device build drops every plugin that adds an entitlement a free Apple account cannot sign, the Live Activity widget included', () => {
  assert.equal(resolveIdentifiers({ MOPILOT_DEVICE_BUILD: '1' }).deviceBuild, true);
  assert.equal(resolveIdentifiers({ MOPILOT_DEVICE_BUILD: '0' }).deviceBuild, false);
  const saved = { ...process.env };
  try {
    process.env.MOPILOT_DEVICE_BUILD = '1';
    process.env.MOPILOT_APPLE_TEAM_ID = 'TEAM123456';
    const out = appConfig({ config: { plugins: ['expo-sqlite'] } });
    assert.deepEqual(out.plugins.slice(1), ['expo-sqlite', 'expo-task-manager', './plugins/withoutPushEntitlement']);
    assert.equal(out.extra.push.keychainAccessGroup, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the time-sensitive entitlement is in a store build, keeps the entitlements app.json has, and is not in a device build', () => {
  const key = 'com.apple.developer.usernotifications.time-sensitive';
  const saved = { ...process.env };
  try {
    delete process.env.MOPILOT_DEVICE_BUILD;
    assert.deepEqual(appConfig({ config: { ios: { entitlements: { other: true } } } }).ios.entitlements, { other: true, [key]: true });
    process.env.MOPILOT_DEVICE_BUILD = '1';
    assert.deepEqual(appConfig({ config: {} }).ios.entitlements, {});
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('withoutPushEntitlement removes aps-environment and keeps the other entitlements', async () => {
  const out = withoutPushEntitlement({ name: 'x', slug: 'x', ios: {} });
  const run = await out.mods.ios.entitlements({
    modRequest: {},
    ...out,
    modResults: { 'aps-environment': 'development', 'com.apple.developer.usernotifications.time-sensitive': true, keep: [1] },
  });
  assert.deepEqual(run.modResults, { keep: [1] });
});

test('the extension Info.plist and entitlements are well-formed and carry both shared groups', () => {
  const info = plist.parse(files.infoPlist(ids));
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.usernotifications.service');
  assert.equal(info.NSExtension.NSExtensionPrincipalClass, '$(PRODUCT_MODULE_NAME).NotificationService');
  assert.equal(info.MPKeychainService, 'mopilot-push');
  assert.equal(info.MPAppGroup, `group.${edition.iosId}`);
  const ent = files.entitlementsPlist(ids);
  assert.deepEqual(ent['com.apple.security.application-groups'], [`group.${edition.iosId}`]);
  assert.deepEqual(ent['keychain-access-groups'], [`$(AppIdentifierPrefix)${edition.iosId}.shared`]);
  assert.equal(plist.parse(plist.build(ent))['keychain-access-groups'][0], ent['keychain-access-groups'][0]);
});

test('the app entitlements gain both groups once and keep what the app already declares', () => {
  const merged = files.mergeAppEntitlements({ 'aps-environment': 'development' }, ids);
  assert.equal(merged['aps-environment'], 'development');
  assert.deepEqual(merged['com.apple.security.application-groups'], [`group.${edition.iosId}`]);
  const again = files.mergeAppEntitlements(merged, ids);
  assert.deepEqual(again, merged);
  const other = files.mergeAppEntitlements(
    { 'com.apple.security.application-groups': ['group.other'], 'keychain-access-groups': ['x'] },
    ids,
  );
  assert.deepEqual(other['com.apple.security.application-groups'], ['group.other', `group.${edition.iosId}`]);
  assert.deepEqual(other['keychain-access-groups'], ['x', `$(AppIdentifierPrefix)${edition.iosId}.shared`]);
  const odd = files.mergeAppEntitlements({ 'keychain-access-groups': 'not-an-array' }, ids);
  assert.deepEqual(odd['keychain-access-groups'], [`$(AppIdentifierPrefix)${edition.iosId}.shared`]);
});

test('build settings sign the extension with its entitlements and set a team only when one is configured', () => {
  const withTeam = files.buildSettings(ids, '1.2.3');
  assert.equal(withTeam.DEVELOPMENT_TEAM, 'TEAM123456');
  assert.equal(withTeam.MARKETING_VERSION, '"1.2.3"');
  assert.equal(withTeam.CODE_SIGN_ENTITLEMENTS, '"NotificationServiceExtension/NotificationServiceExtension.entitlements"');
  assert.equal(withTeam.IPHONEOS_DEPLOYMENT_TARGET, files.DEPLOYMENT_TARGET);
  assert.equal('DEVELOPMENT_TEAM' in files.buildSettings(resolveIdentifiers({}), '1.0.0'), false);
  // the Swift wrapper and the C library are linked by exact path: -lsodium also matches libSodium.a on a case-insensitive volume
  const flags = withTeam.OTHER_LDFLAGS.join(' ');
  assert.match(flags, /Sodium\/libSodium\.a/);
  assert.match(flags, /Sodium\/libsodium\.a/);
  assert.doesNotMatch(flags, /-l/);
});

test('the Podfile gets the extension pod target once', () => {
  const base = "target 'App' do\nend\n";
  const patched = plugin.patchPodfile(base, ids);
  assert.match(patched, /target 'NotificationServiceExtension' do[\s\S]*pod 'Sodium'/);
  assert.equal(plugin.patchPodfile(patched, ids), patched);
});

test('the extension target never sets a linkage of its own, so CocoaPods can embed it in the app', () => {
  // CocoaPods refuses to embed an extension whose use_frameworks! differs from the host app's; the extension's link flags
  // name static archives, so an app that links frameworks is refused with a message rather than failing in the linker.
  const block = plugin.patchPodfile("target 'App' do\nend\n", ids).split("target 'NotificationServiceExtension'")[1];
  assert.doesNotMatch(block, /^\s*use_frameworks!/m);
  assert.match(block, /podfile_properties\['ios\.useFrameworks'\] \|\| ENV\['USE_FRAMEWORKS'\]/);
  assert.match(block, /raise '.*does not support use_frameworks!'/);
  assert.match(block, /use_modular_headers!/);
});

test('the extension target is added to the project: embedded, depended on, sourced and signed', () => {
  const project = xcode.project(fixture);
  project.parseSync();
  const app = project.getFirstTarget().uuid;
  plugin.addExtensionTarget(project, ids, '1.0.0');
  const target = plugin.findTarget(project, 'NotificationServiceExtension');
  assert.ok(target);
  const phases = target.buildPhases.map((p: any) => p.comment);
  assert.deepEqual(phases, ['Sources', 'Resources', 'Frameworks']);
  const text = project.writeSync();
  assert.match(text, /NotificationServiceExtension\.appex in Copy Files/);
  assert.match(text, /dstSubfolderSpec = 13/);
  assert.match(text, /isa = PBXTargetDependency/);
  assert.match(text, /NotificationService\.swift in Sources/);
  assert.match(text, /PrivacyInfo\.xcprivacy in Resources/);
  assert.equal(project.pbxNativeTargetSection()[app].dependencies.length, 1);
  const configs = Object.values(project.pbxXCBuildConfigurationSection()).filter(
    (c: any) => c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${edition.iosId}.notification-service"`,
  ) as any[];
  assert.equal(configs.length, 2);
  for (const c of configs) {
    assert.equal(c.buildSettings.DEVELOPMENT_TEAM, 'TEAM123456');
    assert.equal(c.buildSettings.SWIFT_VERSION, '5.0');
  }
  // adding twice changes nothing
  const before = project.writeSync();
  plugin.addExtensionTarget(project, ids, '1.0.0');
  assert.equal(project.writeSync(), before);
});

test('the extension files are written under ios/<name>/ with the Swift source copied verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  try {
    plugin.writeExtensionFiles(dir, ids, plist);
    const swift = readFileSync(join(dir, 'NotificationServiceExtension/NotificationService.swift'), 'utf8');
    assert.equal(swift, readFileSync(new URL('../mobile/plugins/NotificationService.swift', import.meta.url), 'utf8'));
    // the sealed-title opener is one file shared with the Live Activity widget
    const shared = readFileSync(join(dir, 'NotificationServiceExtension/SealedTitle.swift'), 'utf8');
    assert.equal(shared, readFileSync(new URL('../mobile/plugins/Shared/SealedTitle.swift', import.meta.url), 'utf8'));
    const ent = plist.parse(readFileSync(join(dir, 'NotificationServiceExtension/NotificationServiceExtension.entitlements'), 'utf8'));
    assert.deepEqual(ent['com.apple.security.application-groups'], [`group.${edition.iosId}`]);
    const privacy = plist.parse(readFileSync(join(dir, 'NotificationServiceExtension/PrivacyInfo.xcprivacy'), 'utf8'));
    assert.equal(privacy.NSPrivacyTracking, false);
    assert.deepEqual(privacy.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons, ['1C8F.1']);
    assert.ok(
      readFileSync(join(dir, 'NotificationServiceExtension/NotificationServiceExtension-Info.plist'), 'utf8').includes(
        'com.apple.usernotifications.service',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the Swift extension keeps its safety properties: fixed title on any failure, one delivery, no ratchet access', () => {
  const service = readFileSync(new URL('../mobile/plugins/NotificationService.swift', import.meta.url), 'utf8');
  const swift = service + readFileSync(new URL('../mobile/plugins/Shared/SealedTitle.swift', import.meta.url), 'utf8');
  assert.match(swift, /override func serviceExtensionTimeWillExpire\(\)/);
  assert.match(swift, /guard let done = handler, let content = best else \{ return \}/);
  assert.match(swift, /handler = nil/);
  assert.match(swift, /xchacha20poly1305ietf\.decrypt/);
  assert.match(swift, /mopilot-push-title-v1\|/);
  assert.match(swift, /if isMerged\(info\) \{ return nil \}/);
  // what the extension records in the App Group is a result word (opened or fallback) or a count: these are all its calls
  assert.deepEqual(
    swift
      .split('\n')
      .filter((line) => /\bnote\(/.test(line) && !line.includes('func note'))
      .map((line) => line.trim()),
    ['NotificationService.note("opened")', 'NotificationService.note("fallback")'],
  );
  // only the title-key service is read; the vault and the ratchet checkpoints are not named
  assert.doesNotMatch(swift, /mobile-remote|phone_vault|checkpoint/);
  // the aad prefix and the nonce size match the phone-side implementation
  assert.match(swift, /nonceBytes = 24/);
});

test('the full plugin registers entitlement, file and project mods that run end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nse-full-'));
  try {
    writeFileSync(join(dir, 'Podfile'), "target 'App' do\nend\n");
    const out = plugin({ name: 'x', slug: 'x', version: '2.0.0', ios: {} }, ids);
    const base = { modRequest: { platformProjectRoot: dir, nextMod: undefined, projectRoot: dir }, ...out };
    const ent = await out.mods.ios.entitlements({ ...base, modResults: { 'aps-environment': 'development' } });
    assert.ok(ent.modResults['keychain-access-groups']);
    await out.mods.ios.dangerous({ ...base, modResults: {} });
    assert.match(readFileSync(join(dir, 'Podfile'), 'utf8'), /pod 'Sodium'/);
    const project = xcode.project(fixture);
    project.parseSync();
    const result = await out.mods.ios.xcodeproj({ ...base, modResults: project });
    assert.ok(plugin.findTarget(result.modResults, 'NotificationServiceExtension'));
    const none = plugin({ name: 'x', slug: 'x' }, ids);
    const p2 = xcode.project(fixture);
    p2.parseSync();
    await none.mods.ios.xcodeproj({ modRequest: base.modRequest, ...none, modResults: p2 });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('in-place text selection is on in a build unless MOPILOT_INPLACE_SELECTION=0 turns it off', () => {
  const saved = { ...process.env };
  try {
    delete process.env.MOPILOT_INPLACE_SELECTION;
    assert.equal(appConfig({ config: { name: 'x' } }).extra.inPlaceSelection, true);
    process.env.MOPILOT_INPLACE_SELECTION = '1';
    assert.equal(appConfig({ config: { name: 'x' } }).extra.inPlaceSelection, true);
    process.env.MOPILOT_INPLACE_SELECTION = '0';
    assert.equal('inPlaceSelection' in appConfig({ config: { name: 'x' } }).extra, false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
