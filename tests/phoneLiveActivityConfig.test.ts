// Live Activity widget target: identifiers, Info.plist, entitlements, build settings, Podfile, Xcode target and written files, iPhone only.
import edition from '../mobile/config/edition.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const { resolveIdentifiers } = require('./config/identifiers.js');
const files = require('./plugins/liveActivityFiles.js');
const nseFiles = require('./plugins/nseFiles.js');
const plugin = require('./plugins/withLiveActivity.js');
const nsePlugin = require('./plugins/withNotificationServiceExtension.js');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const fixture = new URL('./fixtures/mobile/template.pbxproj', import.meta.url).pathname;
const swiftDir = new URL('../mobile/plugins/LiveActivity/', import.meta.url);
const moduleDir = new URL('../mobile/modules/mopilot-live-activity/ios/', import.meta.url);

const ids = resolveIdentifiers({ MOPILOT_APPLE_TEAM_ID: 'TEAM123456' });

test('the widget Info.plist is a WidgetKit extension that names the shared keychain service and App Group', () => {
  const info = plist.parse(files.infoPlist(ids));
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
  // a widget bundle is the @main entry; a principal class would make the system look for one
  assert.equal('NSExtensionPrincipalClass' in info.NSExtension, false);
  assert.equal(info.MPKeychainService, 'mopilot-push');
  assert.equal(info.MPAppGroup, `group.${edition.iosId}`);
  assert.equal(info.CFBundleDisplayName, 'MoPilot');
  assert.equal(plist.parse(files.infoPlist(resolveIdentifiers({ MOPILOT_APP_GROUP: 'group.other' }))).MPAppGroup, 'group.other');
});

test('the widget is signed with the same two groups as the notification extension', () => {
  const ent = files.entitlementsPlist(ids);
  assert.deepEqual(ent, nseFiles.entitlementsPlist(ids));
  assert.deepEqual(ent['com.apple.security.application-groups'], [`group.${edition.iosId}`]);
  assert.deepEqual(ent['keychain-access-groups'], [`$(AppIdentifierPrefix)${edition.iosId}.shared`]);
});

test('the widget build settings are iPhone only, iOS 16.2, signed with its own entitlements and link Sodium by path', () => {
  const s = files.buildSettings(ids, '1.2.3', '7');
  assert.equal(s.TARGETED_DEVICE_FAMILY, '"1"');
  assert.equal(s.IPHONEOS_DEPLOYMENT_TARGET, '16.2');
  assert.equal(files.DEPLOYMENT_TARGET, '16.2');
  assert.equal(s.CODE_SIGN_ENTITLEMENTS, '"LiveActivityExtension/LiveActivityExtension.entitlements"');
  assert.equal(s.DEVELOPMENT_TEAM, 'TEAM123456');
  assert.equal(s.MARKETING_VERSION, '"1.2.3"');
  assert.equal(s.CURRENT_PROJECT_VERSION, '"7"');
  const flags = s.OTHER_LDFLAGS.join(' ');
  assert.match(flags, /Sodium\/libSodium\.a/);
  assert.doesNotMatch(flags, /-l/);
  assert.equal('DEVELOPMENT_TEAM' in files.buildSettings(resolveIdentifiers({}), '1.0.0'), false);
  // the notification extension keeps its own deployment target
  assert.equal(nseFiles.buildSettings(ids, '1.0.0').IPHONEOS_DEPLOYMENT_TARGET, nseFiles.DEPLOYMENT_TARGET);
});

test('the Podfile gets the widget pod target once, without a linkage of its own', () => {
  const base = "target 'App' do\nend\n";
  const patched = plugin.patchPodfile(base, ids);
  assert.match(patched, /target 'LiveActivityExtension' do[\s\S]*pod 'Sodium'/);
  assert.equal(plugin.patchPodfile(patched, ids), patched);
  const block = patched.split("target 'LiveActivityExtension'")[1];
  assert.doesNotMatch(block, /^\s*use_frameworks!/m);
  assert.match(block, /raise 'LiveActivityExtension links Sodium as a static library and does not support use_frameworks!'/);
  // the notification extension's block is added independently
  assert.match(nsePlugin.patchPodfile(patched, ids), /target 'NotificationServiceExtension' do/);
});

test('the widget target is added to the project beside the notification extension: embedded, depended on, sourced and signed', () => {
  const project = xcode.project(fixture);
  project.parseSync();
  const app = project.getFirstTarget().uuid;
  nsePlugin.addExtensionTarget(project, ids, '1.0.0');
  plugin.addWidgetTarget(project, ids, '1.0.0', '3');
  const target = plugin.findTarget(project, 'LiveActivityExtension');
  assert.ok(target);
  assert.deepEqual(
    target.buildPhases.map((p: any) => p.comment),
    ['Sources', 'Resources', 'Frameworks'],
  );
  const text = project.writeSync();
  assert.match(text, /LiveActivityExtension\.appex in Copy Files/);
  assert.match(text, /LiveActivity\.swift in Sources/);
  assert.match(text, /TitleKeyStore\.swift in Sources/);
  assert.match(text, /ActivityState\.swift in Sources/);
  assert.match(text, /SealedTitle\.swift in Sources/);
  assert.match(text, /PrivacyInfo\.xcprivacy in Resources/);
  assert.equal(project.pbxNativeTargetSection()[app].dependencies.length, 2);
  // a file both extensions carry gets a reference per group: Xcode 27 refuses a project with a reference in two groups
  const groups = Object.values(project.hash.project.objects.PBXGroup).filter((g: any) => typeof g === 'object') as any[];
  const children = groups.flatMap((g) => g.children.map((c: any) => c.value));
  assert.equal(new Set(children).size, children.length);
  const refs = project.pbxFileReferenceSection();
  const named = (group: string) => groups.find((g) => g.name === group).children.map((c: any) => refs[c.value].path.replace(/"/g, ''));
  for (const group of ['LiveActivityExtension', 'NotificationServiceExtension']) {
    assert.ok(named(group).includes('SealedTitle.swift'));
    assert.ok(named(group).includes('PrivacyInfo.xcprivacy'));
  }
  const configs = Object.values(project.pbxXCBuildConfigurationSection()).filter(
    (c: any) => c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${edition.iosId}.live-activity"`,
  ) as any[];
  assert.equal(configs.length, 2);
  for (const c of configs) {
    assert.equal(c.buildSettings.TARGETED_DEVICE_FAMILY, '"1"');
    assert.equal(c.buildSettings.IPHONEOS_DEPLOYMENT_TARGET, '16.2');
    assert.equal(c.buildSettings.CURRENT_PROJECT_VERSION, '"3"');
  }
  // adding twice changes nothing
  const before = project.writeSync();
  plugin.addWidgetTarget(project, ids, '1.0.0', '3');
  assert.equal(project.writeSync(), before);
});

test('the widget files are written under ios/<name>/ with the Swift sources copied verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-'));
  try {
    plugin.writeWidgetFiles(dir, ids, plist);
    for (const source of plugin.SOURCES) {
      // the widget's own sources are copied from plugins/LiveActivity, the sealed-title opener from plugins/Shared (the notification extension compiles it too),
      // and the activity's state and attributes from the app's Live Activity module, which starts the activity with the same types
      const from =
        source === 'SealedTitle.swift'
          ? new URL('../mobile/plugins/Shared/SealedTitle.swift', import.meta.url)
          : ['ActivityState.swift', 'ActivityAttributes.swift'].includes(source)
            ? new URL(source, moduleDir)
            : new URL(source, swiftDir);
      assert.equal(readFileSync(join(dir, 'LiveActivityExtension', source), 'utf8'), readFileSync(from, 'utf8'));
    }
    assert.deepEqual(plugin.SOURCES, [
      'LiveActivity.swift',
      'TitleKeyStore.swift',
      'ActivityState.swift',
      'ActivityAttributes.swift',
      'SealedTitle.swift',
    ]);
    const ent = plist.parse(readFileSync(join(dir, 'LiveActivityExtension/LiveActivityExtension.entitlements'), 'utf8'));
    assert.deepEqual(ent['com.apple.security.application-groups'], [`group.${edition.iosId}`]);
    const privacy = plist.parse(readFileSync(join(dir, 'LiveActivityExtension/PrivacyInfo.xcprivacy'), 'utf8'));
    assert.equal(privacy.NSPrivacyTracking, false);
    assert.deepEqual(privacy.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons, ['1C8F.1']);
    assert.match(
      readFileSync(join(dir, 'LiveActivityExtension/LiveActivityExtension-Info.plist'), 'utf8'),
      /com\.apple\.widgetkit-extension/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the full plugin declares NSSupportsLiveActivities and runs its file and project mods end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-full-'));
  try {
    writeFileSync(join(dir, 'Podfile'), "target 'App' do\nend\n");
    const out = plugin({ name: 'x', slug: 'x', version: '2.0.0', ios: {} }, ids);
    const base = { modRequest: { platformProjectRoot: dir, nextMod: undefined, projectRoot: dir }, ...out };
    const info = await out.mods.ios.infoPlist({ ...base, modResults: { keep: 1 } });
    // the app names its App Group for the module that writes the titles switch the widget reads
    assert.deepEqual(info.modResults, { keep: 1, NSSupportsLiveActivities: true, MPAppGroup: `group.${edition.iosId}` });
    await out.mods.ios.dangerous({ ...base, modResults: {} });
    assert.match(readFileSync(join(dir, 'Podfile'), 'utf8'), /target 'LiveActivityExtension'/);
    const project = xcode.project(fixture);
    project.parseSync();
    const result = await out.mods.ios.xcodeproj({ ...base, modResults: project });
    assert.ok(plugin.findTarget(result.modResults, 'LiveActivityExtension'));
    // a config without a version, an ios section or a build number still gets a target
    const bare = plugin({ name: 'x', slug: 'x' }, ids);
    const p2 = xcode.project(fixture);
    p2.parseSync();
    await bare.mods.ios.xcodeproj({ modRequest: base.modRequest, ...bare, modResults: p2 });
    assert.ok(plugin.findTarget(p2, 'LiveActivityExtension'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the Swift widget carries only counts, a kind, a start time and rows, draws the clock itself and offers no action but opening the app', () => {
  const state = readFileSync(new URL('ActivityState.swift', moduleDir), 'utf8');
  const ui = readFileSync(new URL('LiveActivity.swift', swiftDir), 'utf8');
  const fields = (block: string) => [...block.matchAll(/var (\w+):/g)].map((m) => m[1]);
  assert.deepEqual(fields(state.split('struct ActivityState')[1].split('init(')[0]), ['needs', 'running', 'kind', 'since', 'rows']);
  assert.deepEqual(fields(state.split('struct ActivityRow')[1].split('}')[0]), ['kind', 'since', 'ref', 'st']);
  // unix seconds, not Date: ActivityKit decodes a push with a default JSONDecoder
  assert.doesNotMatch(state.split('struct ActivityState')[1].split('init(')[0], /Date/);
  assert.match(ui, /Text\(timerInterval: /);
  for (const text of [
    'A chat needs you',
    'A chat is running',
    'A chat finished',
    'Open MoPilot to answer',
    'Open MoPilot to review',
    'Computer offline',
  ]) {
    assert.ok(state.includes(text) || ui.includes(text), text);
  }
  // Approve and Deny are never offered outside the app (decisions.md section 2); opening is a link, not an intent
  assert.doesNotMatch(ui + state, /Button|AppIntent|LiveActivityIntent|Approve|Deny/);
  assert.match(ui, /widgetURL/);
  assert.match(ui, /Link\("Open MoPilot"/);
  // a sealed label is opened only when the switch and a key allow it, never otherwise
  assert.match(ui, /titlesAllowed: keys != nil/);
  // the only key source in the widget UI is the gate: a direct read of the keychain would open titles with the switch off
  assert.match(ui, /let keys = TitleKeyStore\.keysIfAllowed\(\)/);
  assert.doesNotMatch(ui, /titleKeys\(|titlesAllowed: true/);
  assert.doesNotMatch(state, /SealedTitle|titleKeys/);
});

test('the Swift key store reads only the titles switch, and keys only when it is on', () => {
  const swift = readFileSync(new URL('TitleKeyStore.swift', swiftDir), 'utf8');
  assert.match(swift, /guard titlesSwitchOn\(\) else \{ return nil \}/);
  assert.match(swift, /defaults\.bool\(forKey: "liveActivityTitles"\)/);
  assert.match(swift, /keys\.isEmpty \? nil : keys/);
  // the vault and the ratchet checkpoints are not named, in the key store or the shared opener
  const shared = readFileSync(new URL('../mobile/plugins/Shared/SealedTitle.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(swift + shared, /mobile-remote|phone_vault|checkpoint/);
  assert.match(shared, /hasPrefix\("title-key\."\)/);
});

test("the app's .gitignore leaves a local module's ios folder alone, so its Swift sources and podspec are committed", () => {
  const ignored = readFileSync(new URL('../mobile/.gitignore', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // only the app's own generated folders are ignored; an unanchored `ios/` would match modules/*/ios as well
  assert.ok(ignored.includes('/ios/') && ignored.includes('/android/'));
  assert.equal(ignored.includes('ios/') || ignored.includes('android/'), false);
  for (const file of [
    'ActivityAttributes.swift',
    'ActivityState.swift',
    'MoPilotLiveActivityModule.swift',
    'MoPilotLiveActivity.podspec',
  ]) {
    assert.ok(existsSync(new URL(file, moduleDir)), file);
  }
});
